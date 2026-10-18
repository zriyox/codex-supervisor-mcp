import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { artifactsDir, dataDir, dbPath, runsDir } from "./paths.js";
import { extractAgentMessage } from "./event-parser.js";
import { ACTIVE_STATUSES, PHASES, TERMINAL_STATUSES } from "./status.js";
import { readNativeGoal } from "./goal-store.js";
import { normalizeAcceptance } from "./acceptance.js";
import { createHash, randomUUID } from "node:crypto";
import { captureWorkspaceManifest } from "./workspace-kind.js";
import { buildHandoff } from "./handoff.js";

let db;

// Columns added after v1. Kept in one place so the legacy rebuild and the
// fresh CREATE TABLE cannot drift apart.
const POST_V1_COLUMNS = [
  ["run_host_pid", "INTEGER"],
  ["attention_reason", "TEXT"],
  ["run_evidence", "TEXT"],
  ["guard_policy", "TEXT"],
  ["input_context", "TEXT"],
  ["resumed_from", "TEXT"],
  ["thread_id", "TEXT"],
  ["owned_paths", "TEXT NOT NULL DEFAULT '[]'"],
  ["depends_on", "TEXT NOT NULL DEFAULT '[]'"],
  ["goal_objective", "TEXT"],
  ["goal_token_budget", "INTEGER"],
  ["goal_status", "TEXT"],
  ["goal_tokens_used", "INTEGER"],
  ["goal_time_used_seconds", "INTEGER"],
  ["goal_updated_at", "TEXT"],
  ["run_count", "INTEGER NOT NULL DEFAULT 0"],
  ["cancel_requested_at", "TEXT"],
  ["notices", "TEXT"],
  ["session_id", "TEXT"],
  ["base_commit", "TEXT"],
  ["acceptance", "TEXT"],
  ["acceptance_local", "TEXT"],
  ["session_policy_revision", "INTEGER"],
  ["acceptance_timeout_ms", "INTEGER"],
  ["acceptance_results", "TEXT"],
  ["landed_at", "TEXT"],
  ["landed_head", "TEXT"],
  ["landed_branch", "TEXT"],
  ["push_verified_at", "TEXT"],
  ["push_remote", "TEXT"],
  ["push_branch", "TEXT"],
  ["push_remote_head", "TEXT"]
];

const TASK_EXTRA_COLUMNS = [
  ["workspace_kind", "TEXT NOT NULL DEFAULT 'legacy'"],
  ["workspace_metadata", "TEXT"]
];

const TASKS_DDL = `
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT,
      worker TEXT NOT NULL,
      status TEXT NOT NULL,
      phase TEXT,
      cwd TEXT NOT NULL,
      project_root TEXT NOT NULL,
      workspace_kind TEXT NOT NULL DEFAULT 'legacy',
      workspace_metadata TEXT,
      sandbox TEXT NOT NULL,
      model TEXT,
      reasoning_effort TEXT NOT NULL DEFAULT 'high',
      skip_git_repo_check INTEGER NOT NULL DEFAULT 1,
      prompt TEXT NOT NULL,
      changed_files TEXT NOT NULL DEFAULT '[]',
      commands TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      pid INTEGER,
      run_host_pid INTEGER,
      attention_reason TEXT,
      run_evidence TEXT,
      guard_policy TEXT,
      input_context TEXT,
      exit_code INTEGER,
      signal TEXT,
      stderr_tail TEXT,
      last_event_at TEXT,
      last_event_type TEXT,
      last_message TEXT,
      current_action TEXT,
      current_command TEXT,
      error TEXT,
      followup_of TEXT,
      resumed_from TEXT,
      session_id TEXT,
      thread_id TEXT,
      owned_paths TEXT NOT NULL DEFAULT '[]',
      depends_on TEXT NOT NULL DEFAULT '[]',
      goal_objective TEXT,
      goal_token_budget INTEGER,
      goal_status TEXT,
      goal_tokens_used INTEGER,
      goal_time_used_seconds INTEGER,
      goal_updated_at TEXT,
      run_count INTEGER NOT NULL DEFAULT 0,
      cancel_requested_at TEXT,
      notices TEXT,
      worktree_path TEXT,
      base_commit TEXT,
      acceptance TEXT,
      acceptance_local TEXT,
      session_policy_revision INTEGER,
      acceptance_timeout_ms INTEGER,
      acceptance_results TEXT,
      landed_at TEXT,
      landed_head TEXT,
      landed_branch TEXT,
      push_verified_at TEXT,
      push_remote TEXT,
      push_branch TEXT,
      push_remote_head TEXT,
      run_log TEXT NOT NULL
    );
`;

const TASK_COLUMNS = [
  "id", "title", "worker", "status", "phase", "cwd", "project_root", "workspace_kind", "workspace_metadata", "sandbox", "model",
  "reasoning_effort", "skip_git_repo_check", "prompt", "changed_files", "commands",
  "created_at", "updated_at", "started_at", "completed_at", "pid", "run_host_pid", "attention_reason", "run_evidence", "guard_policy", "input_context", "exit_code", "signal",
  "stderr_tail", "last_event_at", "last_event_type", "last_message", "current_action",
  "current_command", "error", "followup_of", "resumed_from", "session_id", "thread_id", "owned_paths",
  "depends_on", "goal_objective", "goal_token_budget", "goal_status", "goal_tokens_used",
  "goal_time_used_seconds", "goal_updated_at", "run_count", "cancel_requested_at",
  "notices", "worktree_path", "base_commit", "acceptance", "acceptance_local", "session_policy_revision", "acceptance_timeout_ms", "acceptance_results", "landed_at", "landed_head", "landed_branch", "push_verified_at", "push_remote", "push_branch", "push_remote_head", "run_log"
];

function tableColumns(dbInstance, tableName) {
  return dbInstance.prepare(`PRAGMA table_info(${tableName})`).all();
}

// v1 stored progress phases ("editing", "command", "reporting") in the status
// column and required phase to be non-null. Both have to change, and SQLite
// cannot relax NOT NULL in place, so the table is rebuilt once.
function migrateTasksTable(dbInstance, columns) {
  const phaseColumn = columns.find((column) => column.name === "phase");
  const isCurrentSchema = POST_V1_COLUMNS.every(([name]) => columns.some((column) => column.name === name))
    && phaseColumn
    && !phaseColumn.notnull;
  if (isCurrentSchema) return { migrated: false, rows: 0 };

  const legacyNames = new Set(columns.map((column) => column.name));
  const rows = dbInstance.prepare("SELECT COUNT(*) AS count FROM tasks").get().count;

  const selectExpression = (name) => {
    if (legacyNames.has(name)) return name;
    const definition = [...POST_V1_COLUMNS, ...TASK_EXTRA_COLUMNS].find(([columnName]) => columnName === name);
    if (definition && definition[1].includes("DEFAULT '[]'")) return "'[]'";
    if (definition && definition[1].includes("DEFAULT 'legacy'")) return "'legacy'";
    if (definition && definition[1].includes("DEFAULT 0")) return "0";
    return "NULL";
  };

  const statusExpression = legacyNames.has("status")
    ? `CASE WHEN status IN ('editing','command','command_completed','reporting') THEN 'running' ELSE status END`
    : "'failed'";

  const phaseExpression = legacyNames.has("phase")
    ? `CASE
         WHEN status IN ('editing','command','reporting') THEN status
         WHEN status = 'command_completed' THEN 'command'
         WHEN status = 'running' THEN CASE WHEN phase IN (${PHASES.map((p) => `'${p}'`).join(",")}) THEN phase ELSE 'starting' END
         ELSE NULL
       END`
    : "NULL";

  {
    dbInstance.exec("ALTER TABLE tasks RENAME TO tasks_legacy_v1;");
    dbInstance.exec(TASKS_DDL);
    const selectList = TASK_COLUMNS.map((name) => {
      if (name === "status") return `${statusExpression} AS status`;
      if (name === "phase") return `${phaseExpression} AS phase`;
      return `${selectExpression(name)} AS ${name}`;
    }).join(", ");
    dbInstance.exec(`INSERT INTO tasks (${TASK_COLUMNS.join(", ")}) SELECT ${selectList} FROM tasks_legacy_v1;`);
    dbInstance.exec("DROP TABLE tasks_legacy_v1;");
  }
  return { migrated: true, rows };
}

const TASK_EVENTS_DDL = `
    CREATE TABLE IF NOT EXISTS task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_id TEXT,
      seq INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      actor TEXT NOT NULL DEFAULT 'legacy',
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      payload_sha256 TEXT
    );
  `;

const TASK_EVENTS_INDEX_DDL =
  "CREATE INDEX IF NOT EXISTS idx_task_events_task_seq ON task_events(task_id, seq);";

const TASKS_SESSION_INDEX_DDL =
  "CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);";

const CONTROL_DDL = `
    CREATE TABLE IF NOT EXISTS repos (
      id TEXT PRIMARY KEY,
      canonical_remote TEXT,
      root TEXT NOT NULL UNIQUE,
      default_branch TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS work_items (
      id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL,
      task_id TEXT NOT NULL UNIQUE,
      parent_work_item_id TEXT,
      objective TEXT,
      owner TEXT,
      delivery_state TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_work_items_repo ON work_items(repo_id, created_at);
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      work_item_id TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      codex_thread_id TEXT,
      worktree_path TEXT,
      branch TEXT,
      base_sha TEXT,
      run_status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      UNIQUE(task_id, attempt)
    );
    CREATE INDEX IF NOT EXISTS idx_runs_work_item ON runs(work_item_id, attempt);
    CREATE TABLE IF NOT EXISTS facts (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      scope_type TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      state TEXT NOT NULL,
      source_event_id INTEGER,
      source_artifact_id TEXT,
      valid_for_sha TEXT,
      valid_for_content_hash TEXT,
      valid_for_manifest_hash TEXT,
      watched_paths TEXT NOT NULL DEFAULT '[]',
      expires_at TEXT,
      supersedes_id TEXT,
      created_at TEXT NOT NULL,
      verified_at TEXT,
      verified_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_facts_scope ON facts(scope_type, scope_id, state);
    CREATE INDEX IF NOT EXISTS idx_facts_supersedes ON facts(supersedes_id, state);
    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      type TEXT NOT NULL,
      uri TEXT NOT NULL,
      sha256 TEXT,
      security_class TEXT NOT NULL DEFAULT 'internal',
      retention TEXT NOT NULL DEFAULT 'permanent',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id, created_at);
    CREATE TABLE IF NOT EXISTS review_findings (
      id TEXT PRIMARY KEY,
      subject_task_id TEXT NOT NULL,
      verifier_task_id TEXT NOT NULL UNIQUE,
      subject_run_id TEXT,
      subject_base_sha TEXT,
      subject_fingerprint TEXT,
      status TEXT NOT NULL,
      verdict TEXT,
      reason TEXT,
      evidence_artifact_id TEXT,
      finding_event_id INTEGER,
      resolved_at TEXT,
      resolved_by TEXT,
      resolution TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_review_findings_subject ON review_findings(subject_task_id, created_at);
    CREATE TABLE IF NOT EXISTS context_snapshots (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      recipient TEXT NOT NULL,
      fact_versions TEXT NOT NULL DEFAULT '[]',
      base_sha TEXT,
      prompt_sha256 TEXT NOT NULL,
      estimated_tokens INTEGER NOT NULL,
      excluded_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_context_snapshots_run ON context_snapshots(run_id, created_at);
    CREATE TABLE IF NOT EXISTS cleanup_plans (
      id TEXT PRIMARY KEY,
      project_root TEXT,
      generated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      policy TEXT NOT NULL,
      summary_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cleanup_plan_items (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      verdict TEXT NOT NULL,
      reasons_json TEXT NOT NULL,
      fingerprint TEXT,
      reclaimable_bytes INTEGER NOT NULL DEFAULT 0,
      eligible_after TEXT,
      applied_at TEXT,
      applied_by TEXT,
      UNIQUE(plan_id, task_id)
    );
    CREATE INDEX IF NOT EXISTS idx_cleanup_plan_items_plan ON cleanup_plan_items(plan_id, verdict);
    CREATE INDEX IF NOT EXISTS idx_cleanup_plan_items_task ON cleanup_plan_items(task_id, applied_at);
  `;

// A session is a string on each task row; this table is what a session is
// *about*. A main thread sets it once per batch, so a reader sees "给 12
// 个接口补单测" instead of a bare id.
const SESSIONS_DDL = `
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT,
      note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `;

// Side questions asked from the board. One side session per worker (the
// forked Codex thread), many turns under it. A turn keeps the stream chunks
// it produced, so a page that comes back can replay what it missed and the
// conversation survives a board restart.
const SIDE_DDL = `
    CREATE TABLE IF NOT EXISTS side_sessions (
      task_id TEXT PRIMARY KEY,
      fork_thread_id TEXT,
      created_at TEXT NOT NULL,
      ended_at TEXT,
      worker_run_count INTEGER
    );
    CREATE TABLE IF NOT EXISTS side_turns (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      question TEXT NOT NULL,
      status TEXT NOT NULL,
      chunks TEXT NOT NULL DEFAULT '[]',
      usage TEXT,
      error TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_side_turns_task ON side_turns(task_id, started_at);
  `;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isBusyError(error) {
  return /SQLITE_BUSY|database is locked|database table is locked/i.test(String(error?.message ?? ""));
}

// Several MCP processes may open a brand-new database at the same moment, so
// schema setup runs inside one immediate transaction (which the busy timeout
// makes wait instead of failing) and is retried if the file is still locked.
function runWithRetry(dbInstance, work, attempts = 10) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return work();
    } catch (error) {
      if (attempt === attempts - 1 || !isBusyError(error)) throw error;
      sleepSync(50 * (attempt + 1));
    }
  }
  return undefined;
}

function initializeSchema(dbInstance) {
  runWithRetry(dbInstance, () => {
    dbInstance.exec("BEGIN IMMEDIATE;");
    try {
      const columns = tableColumns(dbInstance, "tasks");
      if (columns.length === 0) dbInstance.exec(TASKS_DDL);
      else migrateTasksTable(dbInstance, columns);
      dbInstance.exec(TASK_EVENTS_DDL);
      for (const [name, definition] of [
        ["run_id", "TEXT"],
        ["actor", "TEXT NOT NULL DEFAULT 'legacy'"],
        ["payload_sha256", "TEXT"]
      ]) {
        if (!tableColumns(dbInstance, "task_events").some((column) => column.name === name)) dbInstance.exec(`ALTER TABLE task_events ADD COLUMN ${name} ${definition}`);
      }
      dbInstance.exec("UPDATE task_events SET actor = 'legacy' WHERE actor IS NULL");
      dbInstance.exec(TASK_EVENTS_INDEX_DDL);
      dbInstance.exec(TASKS_SESSION_INDEX_DDL);
      for (const [name, definition] of TASK_EXTRA_COLUMNS) {
        if (!tableColumns(dbInstance, "tasks").some((column) => column.name === name)) dbInstance.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${definition}`);
      }
      dbInstance.exec(CONTROL_DDL);
      for (const [name, definition] of [
        ["watched_paths", "TEXT NOT NULL DEFAULT '[]'"],
        ["source_artifact_id", "TEXT"],
        ["valid_for_content_hash", "TEXT"],
        ["valid_for_manifest_hash", "TEXT"],
        ["verified_by", "TEXT"]
      ]) {
        if (!tableColumns(dbInstance, "facts").some((column) => column.name === name)) dbInstance.exec(`ALTER TABLE facts ADD COLUMN ${name} ${definition}`);
      }
      dbInstance.exec(SESSIONS_DDL);
      for (const [name, definition] of [
        ["objective", "TEXT"], ["default_acceptance", "TEXT"],
        ["approval_state", "TEXT NOT NULL DEFAULT 'approved'"], ["policy_revision", "INTEGER NOT NULL DEFAULT 0"]
      ]) {
        if (!tableColumns(dbInstance, "sessions").some((column) => column.name === name)) dbInstance.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${definition}`);
      }
      dbInstance.exec("CREATE TABLE IF NOT EXISTS observer_cursors (id TEXT PRIMARY KEY, cursor TEXT NOT NULL, updated_at TEXT NOT NULL)");
      dbInstance.exec("CREATE TABLE IF NOT EXISTS run_claims (task_id TEXT PRIMARY KEY, token TEXT NOT NULL, owner_pid INTEGER NOT NULL)");
      dbInstance.exec(SIDE_DDL);
      // Rows written before 0.7.1 have no worker_run_count: the fork is then

      // never judged stale, which is what those rows did before.

      if (!dbInstance.prepare("PRAGMA table_info(side_sessions)").all().some((column) => column.name === "worker_run_count")) {

        dbInstance.exec("ALTER TABLE side_sessions ADD COLUMN worker_run_count INTEGER;");

      }
      backfillControlRecords(dbInstance);
      dbInstance.exec("COMMIT;");
    } catch (error) {
      try {
        dbInstance.exec("ROLLBACK;");
      } catch {
        /* transaction already unwound */
      }
      throw error;
    }
  });
}

function stableId(prefix, value) {
  return `${prefix}-${createHash("sha256").update(String(value)).digest("hex").slice(0, 24)}`;
}

function repoIdForRoot(root) {
  return stableId("repo", resolve(root));
}

function canonicalizeRemote(value) {
  let raw = String(value ?? "").trim();
  if (!raw) return null;
  const scp = raw.match(/^((?:[^@/:\s]+@)?)([^:/\s]+):(.+)$/);
  if (scp && !raw.includes("://")) raw = `ssh://${scp[1]}${scp[2]}/${scp[3]}`;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === "file:") {
      const path = resolve(decodeURIComponent(parsed.pathname)).replace(/\.git$/i, "");
      return `file://${path}`;
    }
    if (!parsed.hostname || !["ssh:", "https:", "http:"].includes(parsed.protocol)) return null;
    const path = decodeURIComponent(parsed.pathname).replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
    if (!path) return null;
    return `${parsed.protocol}//${parsed.hostname.toLowerCase()}${parsed.port ? `:${parsed.port}` : ""}/${path}`;
  } catch {
    return isAbsolute(raw) ? `file://${resolve(raw).replace(/\.git$/i, "")}` : null;
  }
}

function canonicalRemoteForRoot(root) {
  try {
    return canonicalizeRemote(git(root, ["remote", "get-url", "origin"]));
  } catch {
    return null;
  }
}

function workItemIdForTask(taskId) {
  return `work-${taskId}`;
}

export function runIdFor(taskId, attempt) {
  return `run-${taskId}-${attempt}`;
}

function ensureControlRecords(dbInstance, task) {
  if (!task?.id || !task.project_root) return;
  const now = new Date().toISOString();
  const root = resolve(task.project_root);
  const repoId = repoIdForRoot(root);
  const canonicalRemote = canonicalRemoteForRoot(root);
  const workItemId = workItemIdForTask(task.id);
  dbInstance.prepare(`
    INSERT INTO repos (id, canonical_remote, root, default_branch, created_at, updated_at)
    VALUES (@id, @canonical_remote, @root, NULL, @now, @now)
    ON CONFLICT(root) DO UPDATE SET canonical_remote = excluded.canonical_remote, updated_at = excluded.updated_at
  `).run({ id: repoId, canonical_remote: canonicalRemote, root, now });
  dbInstance.prepare(`
    INSERT INTO work_items (id, repo_id, task_id, parent_work_item_id, objective, owner, delivery_state, created_at, updated_at)
    VALUES (@id, @repo_id, @task_id, NULL, @objective, NULL, @delivery_state, @now, @now)
    ON CONFLICT(task_id) DO UPDATE SET
      objective = COALESCE(excluded.objective, work_items.objective),
      delivery_state = CASE WHEN work_items.delivery_state = 'draft' THEN excluded.delivery_state ELSE work_items.delivery_state END,
      updated_at = excluded.updated_at
  `).run({
    id: workItemId,
    repo_id: repoId,
    task_id: task.id,
    objective: task.goal_objective ?? task.title ?? null,
    delivery_state: task.landed_at ? "landed" : "draft",
    now
  });
}

function backfillControlRecords(dbInstance) {
  const rows = dbInstance.prepare("SELECT id,title,project_root,goal_objective,landed_at FROM tasks").all();
  for (const row of rows) ensureControlRecords(dbInstance, row);
}

function openDb() {
  if (db) return db;
  db = new DatabaseSync(dbPath);
  // Several MCP processes share one database file. The busy timeout has to be
  // set before anything that can touch the write lock, otherwise a concurrent
  // writer turns into an immediate SQLITE_BUSY.
  db.exec("PRAGMA busy_timeout=15000;");
  runWithRetry(db, () => db.exec("PRAGMA journal_mode=WAL;"));
  db.exec("PRAGMA synchronous=NORMAL;");
  initializeSchema(db);
  return db;
}

async function ensureFilesystem() {
  await mkdir(dataDir, { recursive: true });
  await mkdir(runsDir, { recursive: true });
  await mkdir(artifactsDir, { recursive: true });
}

function encodeJson(value) {
  return JSON.stringify(value ?? []);
}

function decodeJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function rowToTask(row) {
  if (!row) return null;
  const nativeGoal = readNativeGoal(row.thread_id);
  return {
    ...row,
    workspace_kind: row.workspace_kind ?? "legacy",
    skip_git_repo_check: Boolean(row.skip_git_repo_check),
    changed_files: decodeJson(row.changed_files, []),
    commands: decodeJson(row.commands, []),
    owned_paths: decodeJson(row.owned_paths, []),
    depends_on: decodeJson(row.depends_on, []),
    acceptance: decodeJson(row.acceptance, null),
    acceptance_local: decodeJson(row.acceptance_local, null),
    acceptance_results: decodeJson(row.acceptance_results, null),
    run_evidence: decodeJson(row.run_evidence, null),
    guard_policy: decodeJson(row.guard_policy, null),
    input_context: decodeJson(row.input_context, null),
    workspace_metadata: decodeJson(row.workspace_metadata, null),
    pid: row.pid ?? null,
    exit_code: row.exit_code ?? null,
    phase: row.phase ?? null,
    goal_token_budget: row.goal_token_budget ?? null,
    goal_status: nativeGoal?.storage_status ?? row.goal_status ?? null,
    goal_tokens_used: nativeGoal?.tokens_used ?? row.goal_tokens_used ?? null,
    goal_time_used_seconds: nativeGoal?.time_used_seconds ?? row.goal_time_used_seconds ?? null,
    goal_updated_at: nativeGoal?.updated_at ?? row.goal_updated_at ?? null
  };
}

export function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function readTasks() {
  await ensureFilesystem();
  const rows = openDb().prepare("SELECT * FROM tasks ORDER BY created_at ASC").all();
  return rows.map(rowToTask);
}

export async function readActiveTasks() {
  const tasks = await readTasks();
  return tasks.filter((task) => ACTIVE_STATUSES.has(task.status));
}

// A worker whose process is gone and that never wrote a terminal event is not
// "failed": nothing told us it failed. It is lost, and the fix is to re-run it.
// A row can also be active without ever having had a process: the dispatch
// wrote the row and then died before the spawn was recorded (one real store
// carried such a row for days, pid 0 and no created_at, forever "running").
// Only a row old enough that the dispatch cannot still be in flight is judged
// this way; a row with an unreadable created_at is treated as old.
const NEVER_STARTED_GRACE_MS = 5 * 60 * 1000;

function neverStarted(task, now = Date.now()) {
  if (task.pid) return false;
  if (task.started_at) return false;
  const created = Date.parse(task.created_at ?? "");
  if (Number.isNaN(created)) return true;
  return now - created > NEVER_STARTED_GRACE_MS;
}

// A terminal row whose acceptance run was cut short: the MCP process that
// was running the checks is gone. Left alone it would read as "running"
// forever and land would treat it as never run.
async function reconcileInterruptedAcceptance() {
  const tasks = await readTasks();
  const interrupted = tasks.filter((task) =>
    TERMINAL_STATUSES.has(task.status)
    && task.acceptance_results?.status === "running"
    && !isPidAlive(task.acceptance_results.supervisor_pid));
  for (const task of interrupted) {
    const now = new Date().toISOString();
    await writeTask({
      ...task,
      acceptance_results: { ...task.acceptance_results, status: "interrupted", passed: null, finished_at: now },
      current_action: "Acceptance interrupted: the supervisor process exited while running the checks",
      updated_at: now
    });
  }
  return interrupted;
}

export async function reconcileDetachedActiveTasks() {
  await reconcileInterruptedAcceptance();
  const incomplete = (await readTasks()).filter((task) =>
    ["completed", "failed"].includes(task.status) && task.exit_code == null && task.started_at
    && !isPidAlive(task.pid) && !isPidAlive(task.run_host_pid) && !task.acceptance_results
    && Date.now() - Date.parse(task.updated_at) > 5000);
  for (const task of incomplete) {
    await writeTask({ ...task, status: "lost", phase: null,
      error: "Worker ended but its supervisor did not record the process exit; recover this run before treating it as complete",
      updated_at: new Date().toISOString() });
  }
  const tasks = await readActiveTasks();
  const staleTasks = tasks.filter((task) => !isPidAlive(task.run_host_pid)
    && ((task.pid && !isPidAlive(task.pid)) || neverStarted(task)));
  for (const task of staleTasks) {
    const now = new Date().toISOString();
    const vanished = Boolean(task.pid);
    await writeTask({
      ...task,
      status: "lost",
      phase: null,
      current_action: vanished
        ? "Worker process disappeared without a terminal event"
        : "Worker was never started: no process was recorded for this row",
      current_command: null,
      error: task.error ?? (vanished
        ? "Codex worker process disappeared before a terminal event was recorded."
        : "Codex worker row was written but no process was ever recorded for it."),
      completed_at: task.completed_at || now,
      updated_at: now
    });
  }
  return staleTasks;
}

export async function writeTask(task) {
  await ensureFilesystem();
  return writeTaskNow(task);
}

function writeTaskNow(task) {
  const placeholders = TASK_COLUMNS.map((name) => `@${name}`).join(", ");
  const updates = TASK_COLUMNS
    .filter((name) => name !== "id" && name !== "created_at")
    .map((name) => `${name} = excluded.${name}`)
    .join(",\n      ");
  const stmt = openDb().prepare(`
    INSERT INTO tasks (${TASK_COLUMNS.join(", ")}) VALUES (${placeholders})
    ON CONFLICT(id) DO UPDATE SET
      ${updates}
  `);

  const params = {};
  for (const name of TASK_COLUMNS) params[name] = task[name] ?? null;
  params.reasoning_effort = task.reasoning_effort ?? "high";
  params.workspace_kind = task.workspace_kind ?? "legacy";
  params.skip_git_repo_check = task.skip_git_repo_check ? 1 : 0;
  params.changed_files = encodeJson(task.changed_files);
  params.commands = encodeJson(task.commands);
  params.owned_paths = encodeJson(task.owned_paths);
  params.depends_on = encodeJson(task.depends_on);
  // JSON columns: node:sqlite refuses to bind an array or object, and a
  // refused bind drops the whole row update.
  params.acceptance = task.acceptance ? JSON.stringify(task.acceptance) : null;
  params.acceptance_local = task.acceptance_local ? JSON.stringify(task.acceptance_local) : null;
  params.acceptance_results = task.acceptance_results ? JSON.stringify(task.acceptance_results) : null;
  params.run_evidence = task.run_evidence ? JSON.stringify(task.run_evidence) : null;
  params.guard_policy = task.guard_policy ? JSON.stringify(task.guard_policy) : null;
  params.input_context = task.input_context ? JSON.stringify(task.input_context) : null;
  params.workspace_metadata = task.workspace_metadata ? JSON.stringify(task.workspace_metadata) : null;
  params.run_count = task.run_count ?? 0;
  params.phase = task.phase ?? null;

  stmt.run(params);
  ensureControlRecords(openDb(), task);
  return task;
}

function checkOwnership(taskId, incoming) {
  const normalized = (value) => process.platform === "win32" ? value.replace(/\\/g, "/").toLowerCase() : value;
  const overlaps = (left, right) => {
    const a=normalized(left).replace(/\/$/,""),b=normalized(right).replace(/\/$/,"");
    return a===b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
  };
  const conflicts = [];
  const pending = openDb().prepare("SELECT t.id,t.title,t.status,t.owned_paths,t.acceptance_results,t.started_at,t.exit_code,c.owner_pid FROM tasks t LEFT JOIN run_claims c ON c.task_id=t.id WHERE t.id<>? AND (c.owner_pid IS NOT NULL OR status IN ('queued','running') OR json_extract(acceptance_results,'$.status')='running' OR (status IN ('completed','failed') AND started_at IS NOT NULL AND exit_code IS NULL AND acceptance_results IS NULL))").all(taskId);
  for (const row of pending) {
    const settling = decodeJson(row.acceptance_results,null)?.status === "running"
      || (["completed","failed"].includes(row.status) && row.started_at && row.exit_code == null && !row.acceptance_results);
    if (row.owner_pid && !ACTIVE_STATUSES.has(row.status) && !settling && !isPidAlive(row.owner_pid)) continue;
    const paths=decodeJson(row.owned_paths,[]);
    const matching=incoming.flatMap(path=>paths.filter(other=>overlaps(path,other)).map(other=>({incoming:path,existing:other})));
    if(matching.length)conflicts.push({task_id:row.id,title:row.title,status:row.status,overlapping_paths:matching});
  }
  if(conflicts.length){const error=new Error("ownedPaths overlap with an active worker claimed by another dispatcher");error.code="ownership_conflict";error.conflicts=conflicts;throw error;}
}

export async function reserveTaskOwnership(task) {
  await ensureFilesystem();
  const connection=openDb();
  return runWithRetry(connection,()=>{
    connection.exec("BEGIN IMMEDIATE");
    try { checkOwnership(task.id,task.owned_paths??[]);writeTaskNow(task);connection.exec("COMMIT");return task; }
    catch(error){connection.exec("ROLLBACK");throw error;}
  });
}

export async function upsertTask(task) {
  await writeTask(task);
  return task;
}

export async function getTask(taskId) {
  await ensureFilesystem();
  const row = openDb().prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
  return rowToTask(row);
}

// Compare and claim under one write lock before rebase or spawning. A claim
// whose dispatcher died can be replaced; a different run cannot be resumed
// using an earlier snapshot, even when both dispatchers read it together.
export async function claimTaskRun(taskId, expectedRun) {
  await ensureFilesystem();
  const connection = openDb();
  return runWithRetry(connection, () => {
    connection.exec("BEGIN IMMEDIATE");
    try {
      const row = connection.prepare("SELECT * FROM tasks WHERE id=?").get(taskId);
      const claim = connection.prepare("SELECT * FROM run_claims WHERE task_id=?").get(taskId);
      const busy = !row || row.run_count !== expectedRun || ACTIVE_STATUSES.has(row.status)
        || (["completed", "failed"].includes(row.status) && row.exit_code == null)
        || decodeJson(row.acceptance_results, null)?.status === "running"
        || (claim && isPidAlive(claim.owner_pid));
      let token = null;
      if (!busy) {
        checkOwnership(taskId,decodeJson(row.owned_paths,[]));
        token = randomUUID();
        connection.prepare("INSERT INTO run_claims VALUES (?,?,?) ON CONFLICT(task_id) DO UPDATE SET token=excluded.token,owner_pid=excluded.owner_pid")
          .run(taskId, token, process.pid);
      }
      connection.exec("COMMIT");
      return token;
    } catch (error) { connection.exec("ROLLBACK"); throw error; }
  });
}

export async function releaseTaskRun(taskId, token) {
  openDb().prepare("DELETE FROM run_claims WHERE task_id=? AND token=?").run(taskId, token);
}

export async function readObserverCursor(observerId) {
  await ensureFilesystem();
  return decodeJson(openDb().prepare("SELECT cursor FROM observer_cursors WHERE id=?").get(observerId)?.cursor, {});
}

export async function writeObserverCursor(observerId, cursor) {
  await ensureFilesystem();
  runWithRetry(openDb(), () => openDb().prepare("INSERT INTO observer_cursors VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET cursor=excluded.cursor,updated_at=excluded.updated_at")
    .run(observerId, JSON.stringify(cursor), new Date().toISOString()));
}

// Keyword search over the fields that describe what a work was for and how it
// ended. Substring match, newest first. Deliberately not full-text and not
// vector search: at this scale a LIKE scan over a few hundred rows is faster
// than any index would be to maintain.
export async function searchTasks(query, limit = 20) {
  await ensureFilesystem();
  const pattern = `%${String(query).trim()}%`;
  const rows = openDb().prepare(`
    SELECT * FROM tasks
    WHERE title LIKE @pattern
       OR goal_objective LIKE @pattern
       OR prompt LIKE @pattern
       OR last_message LIKE @pattern
    ORDER BY created_at DESC
    LIMIT @limit
  `).all({ pattern, limit });
  return rows.map(rowToTask);
}

export async function readTasksBySession(sessionId) {
  await ensureFilesystem();
  const rows = openDb()
    .prepare("SELECT * FROM tasks WHERE session_id = ? ORDER BY created_at ASC")
    .all(sessionId);
  return rows.map(rowToTask);
}

// Record the files a terminal worker changed, and nothing else. The summary
// read used to upsert the whole row, which on a running worker put stale
// copies of every live field (phase, current_action, exit_code) back over
// what the runner had just written. A terminal row has no writer left, and
// even then only this one column is touched.
export async function recordTerminalChangedFiles(taskId, changedFiles) {
  await ensureFilesystem();
  const terminal = Array.from(TERMINAL_STATUSES).map((s) => `'${s}'`).join(", ");
  const result = openDb()
    .prepare(`UPDATE tasks SET changed_files = @files WHERE id = @id AND status IN (${terminal})`)
    .run({ id: taskId, files: encodeJson(changedFiles) });
  return result.changes > 0;
}

export async function upsertSession({ id, title = null, note = null, objective, defaultAcceptance, approvalState, expectedRevision }) {
  if (!id) throw new Error("session id is required");
  await ensureFilesystem();
  const now = new Date().toISOString();
  // Only overwrite what the caller sent: a later dispatch that names the
  // session without a title must not blank the title set earlier.
  openDb()
    .prepare(`
      INSERT INTO sessions (id, title, note, created_at, updated_at) VALUES (@id, @title, @note, @now, @now)
      ON CONFLICT(id) DO UPDATE SET
        title = COALESCE(excluded.title, sessions.title),
        note = COALESCE(excluded.note, sessions.note),
        updated_at = excluded.updated_at
    `)
    .run({ id, title: title ?? null, note: note ?? null, now });
  if (objective !== undefined || defaultAcceptance !== undefined || approvalState !== undefined || expectedRevision !== undefined) {
    const acceptance = defaultAcceptance === undefined ? undefined : normalizeAcceptance(defaultAcceptance) ?? [];
    if (objective !== undefined && (typeof objective !== "string" || !objective.trim())) throw new Error("session objective must be nonempty");
    if (approvalState !== undefined && !["approved", "waiting_user"].includes(approvalState)) throw new Error("invalid session approval state");
    runWithRetry(openDb(), () => {
      const store = openDb();
      store.exec("BEGIN IMMEDIATE");
      try {
        const before = store.prepare("SELECT * FROM sessions WHERE id=?").get(id);
        if (expectedRevision !== undefined && expectedRevision !== before.policy_revision) {
          const error = new Error(`session policy changed; current revision is ${before.policy_revision}`);
          error.code = "session_policy_conflict";
          throw error;
        }
        const policy = {
          objective: objective ?? before.objective,
          acceptance: acceptance === undefined ? before.default_acceptance : JSON.stringify(acceptance),
          approval: approvalState ?? before.approval_state
        };
        const changed = policy.objective !== before.objective || policy.acceptance !== before.default_acceptance || policy.approval !== before.approval_state;
        store.prepare("UPDATE sessions SET objective=?,default_acceptance=?,approval_state=?,policy_revision=?,updated_at=? WHERE id=?")
          .run(policy.objective, policy.acceptance, policy.approval, before.policy_revision + (changed ? 1 : 0), now, id);
        store.exec("COMMIT");
      } catch (error) { store.exec("ROLLBACK"); throw error; }
    });
  }
  return getSession(id);
}

export async function getSession(sessionId) {
  await ensureFilesystem();
  const row = openDb().prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId);
  return row ? { ...row, default_acceptance: decodeJson(row.default_acceptance, []) } : null;
}

export async function readSessions() {
  await ensureFilesystem();
  return openDb().prepare("SELECT * FROM sessions").all();
}

// ---- side sessions and turns

export async function getSideSession(taskId) {
  await ensureFilesystem();
  return openDb().prepare("SELECT * FROM side_sessions WHERE task_id = ? AND ended_at IS NULL").get(taskId) ?? null;
}

// `workerRunCount` is the worker's run_count when the fork is taken; a
// worker resumed after that has a thread the fork no longer reflects.
export async function openSideSession(taskId, workerRunCount = null) {
  await ensureFilesystem();
  const now = new Date().toISOString();
  openDb()
    .prepare(`INSERT INTO side_sessions (task_id, fork_thread_id, created_at, ended_at, worker_run_count) VALUES (?, NULL, ?, NULL, ?)
              ON CONFLICT(task_id) DO UPDATE SET fork_thread_id = NULL, created_at = excluded.created_at, ended_at = NULL, worker_run_count = excluded.worker_run_count`)
    .run(taskId, now, workerRunCount);
  return getSideSession(taskId);
}

export async function setSideSessionFork(taskId, forkThreadId) {
  await ensureFilesystem();
  openDb().prepare("UPDATE side_sessions SET fork_thread_id = ? WHERE task_id = ? AND ended_at IS NULL").run(forkThreadId, taskId);
}

export async function closeSideSession(taskId) {
  await ensureFilesystem();
  const db = openDb();
  const row = db.prepare("SELECT * FROM side_sessions WHERE task_id = ? AND ended_at IS NULL").get(taskId) ?? null;
  const now = new Date().toISOString();
  db.prepare("UPDATE side_sessions SET ended_at = ? WHERE task_id = ? AND ended_at IS NULL").run(now, taskId);
  db.prepare("DELETE FROM side_turns WHERE task_id = ?").run(taskId);
  return row;
}

export async function insertSideTurn(turn) {
  await ensureFilesystem();
  openDb()
    .prepare(`INSERT INTO side_turns (id, task_id, question, status, chunks, usage, error, started_at, ended_at)
              VALUES (@id, @task_id, @question, @status, @chunks, @usage, @error, @started_at, @ended_at)`)
    .run({
      id: turn.id,
      task_id: turn.task_id,
      question: turn.question,
      status: turn.status,
      chunks: JSON.stringify(turn.chunks ?? []),
      usage: turn.usage ? JSON.stringify(turn.usage) : null,
      error: turn.error ?? null,
      started_at: turn.started_at,
      ended_at: turn.ended_at ?? null
    });
}

export async function updateSideTurn(id, fields) {
  await ensureFilesystem();
  const sets = [];
  const params = { id };
  for (const [key, value] of Object.entries(fields)) {
    sets.push(`${key} = @${key}`);
    params[key] = key === "chunks" || key === "usage" ? (value === null ? null : JSON.stringify(value)) : value;
  }
  if (sets.length === 0) return;
  openDb().prepare(`UPDATE side_turns SET ${sets.join(", ")} WHERE id = @id`).run(params);
}

export async function readSideTurns(taskId) {
  await ensureFilesystem();
  return openDb()
    .prepare("SELECT * FROM side_turns WHERE task_id = ? ORDER BY started_at ASC")
    .all(taskId)
    .map((row) => ({ ...row, chunks: decodeJson(row.chunks, []), usage: row.usage ? decodeJson(row.usage, null) : null }));
}

// A board that restarts cannot own a turn that was running when it died.
export async function interruptRunningSideTurns() {
  await ensureFilesystem();
  const now = new Date().toISOString();
  return openDb()
    .prepare("UPDATE side_turns SET status = 'interrupted', error = COALESCE(error, 'the board restarted while this turn was running'), ended_at = ? WHERE status = 'running'")
    .run(now).changes;
}

export async function getTasks(taskIds) {
  await ensureFilesystem();
  return taskIds.map((taskId) => {
    const row = openDb().prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
    return rowToTask(row);
  });
}

export function taskRunPath(taskId) {
  return join(runsDir, `${taskId}.jsonl`);
}

export async function ensureRunRecord(task, attempt) {
  await ensureFilesystem();
  if (!task?.id || !Number.isInteger(attempt) || attempt < 1) throw new Error("run record requires a task and positive attempt");
  const dbInstance = openDb();
  ensureControlRecords(dbInstance, task);
  const now = new Date().toISOString();
  const id = runIdFor(task.id, attempt);
  dbInstance.prepare(`
    INSERT INTO runs (id, task_id, work_item_id, attempt, codex_thread_id, worktree_path, branch, base_sha, run_status, started_at, finished_at)
    VALUES (@id, @task_id, @work_item_id, @attempt, @codex_thread_id, @worktree_path, @branch, @base_sha, 'running', @started_at, NULL)
    ON CONFLICT(task_id, attempt) DO UPDATE SET
      codex_thread_id = COALESCE(excluded.codex_thread_id, runs.codex_thread_id),
      worktree_path = COALESCE(excluded.worktree_path, runs.worktree_path),
      base_sha = COALESCE(excluded.base_sha, runs.base_sha)
  `).run({
    id,
    task_id: task.id,
    work_item_id: workItemIdForTask(task.id),
    attempt,
    codex_thread_id: task.thread_id ?? null,
    worktree_path: task.worktree_path ?? null,
    branch: task.worktree_path ? `codex/${task.id}` : null,
    base_sha: task.base_commit ?? null,
    started_at: now
  });
  return id;
}

export async function completeRunRecord(task, attempt) {
  await ensureFilesystem();
  if (!task?.id || !Number.isInteger(attempt) || attempt < 1) return;
  const now = task.completed_at ?? new Date().toISOString();
  openDb().prepare(`
    UPDATE runs SET codex_thread_id = @codex_thread_id,
      run_status = @run_status, finished_at = @finished_at
    WHERE task_id = @task_id AND attempt = @attempt
  `).run({
    task_id: task.id,
    attempt,
    codex_thread_id: task.thread_id ?? null,
    run_status: task.status ?? "unknown",
    finished_at: now
  });
}

export async function appendTaskEvent(taskId, event, { runId = null, actor = "supervisor" } = {}) {
  await ensureFilesystem();
  const dbInstance = openDb();
  const nextSeqRow = dbInstance.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM task_events WHERE task_id = ?").get(taskId);
  const payload = JSON.stringify(event);
  const result = dbInstance.prepare(`
    INSERT INTO task_events (task_id, run_id, seq, created_at, actor, event_type, payload, payload_sha256)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(taskId, runId, nextSeqRow.seq, new Date().toISOString(), actor, event.type ?? "unknown", payload,
    createHash("sha256").update(payload).digest("hex"));
  return { id: Number(result.lastInsertRowid), run_id: runId, actor };
}

export async function readTaskEvents(taskId, limit = 100, kinds = null) {
  await ensureFilesystem();
  const kindList = Array.isArray(kinds) && kinds.length > 0 ? kinds : null;
  // Filtering happens before the limit so "give me the last 10 file changes"
  // actually returns 10 file changes, not the tail of an unfiltered stream.
  const rows = kindList
    ? openDb().prepare(`
        SELECT payload FROM task_events
        WHERE task_id = ? AND event_type IN (${kindList.map(() => "?").join(", ")})
        ORDER BY seq DESC LIMIT ?
      `).all(taskId, ...kindList, limit)
    : openDb().prepare(`
        SELECT payload FROM task_events
        WHERE task_id = ? ORDER BY seq DESC LIMIT ?
      `).all(taskId, limit);
  return rows.reverse().map((row) => JSON.parse(row.payload));
}

export async function readTaskEventRecords(taskId, limit = 100) {
  await ensureFilesystem();
  const rows = openDb().prepare(`
    SELECT id, task_id, run_id, seq, created_at, actor, event_type, payload, payload_sha256
    FROM task_events WHERE task_id = ? ORDER BY seq DESC LIMIT ?
  `).all(taskId, limit);
  return rows.reverse().map((row) => ({
    ...row,
    event: JSON.parse(row.payload)
  }));
}

export async function getWorkItemForTask(taskId) {
  await ensureFilesystem();
  return openDb().prepare("SELECT * FROM work_items WHERE task_id = ?").get(taskId) ?? null;
}

export async function recordFact({
  workItemId,
  scopeType,
  scopeId,
  key,
  value,
  state = "candidate",
  sourceEventId = null,
  sourceArtifactId = null,
  validForSha = null,
  validForContentHash = null,
  validForManifestHash = null,
  watchedPaths = [],
  expiresAt = null,
  supersedesId = null,
  verifiedAt = null,
  verifiedBy = null
}) {
  await ensureFilesystem();
  if (!workItemId || !scopeType || !scopeId || !key) throw new Error("fact requires workItemId, scopeType, scopeId and key");
  if (!["candidate", "verified", "expired", "revoked"].includes(state)) throw new Error("invalid fact state");
  if (!Array.isArray(watchedPaths) || watchedPaths.some((path) => typeof path !== "string")) throw new Error("watchedPaths must be a string list");
  const now = new Date().toISOString();
  const id = randomUUID();
  openDb().prepare(`
    INSERT INTO facts (id, work_item_id, scope_type, scope_id, key, value_json, state, source_event_id, source_artifact_id, valid_for_sha, valid_for_content_hash, valid_for_manifest_hash, watched_paths, expires_at, supersedes_id, created_at, verified_at, verified_by)
    VALUES (@id, @work_item_id, @scope_type, @scope_id, @key, @value_json, @state, @source_event_id, @source_artifact_id, @valid_for_sha, @valid_for_content_hash, @valid_for_manifest_hash, @watched_paths, @expires_at, @supersedes_id, @created_at, @verified_at, @verified_by)
  `).run({
    id,
    work_item_id: workItemId,
    scope_type: scopeType,
    scope_id: scopeId,
    key,
    value_json: JSON.stringify(value),
    state,
    source_event_id: sourceEventId,
    source_artifact_id: sourceArtifactId,
    valid_for_sha: validForSha,
    valid_for_content_hash: validForContentHash,
    valid_for_manifest_hash: validForManifestHash,
    watched_paths: JSON.stringify(watchedPaths.map((path) => resolve(path))),
    expires_at: expiresAt,
    supersedes_id: supersedesId,
    created_at: now,
    verified_at: verifiedAt ?? (state === "verified" ? now : null),
    verified_by: verifiedBy ?? (state === "verified" ? "supervisor" : null)
  });
  return { id, work_item_id: workItemId, scope_type: scopeType, scope_id: scopeId, key, value, state, source_event_id: sourceEventId, source_artifact_id: sourceArtifactId, valid_for_sha: validForSha, valid_for_content_hash: validForContentHash, valid_for_manifest_hash: validForManifestHash, watched_paths: watchedPaths, supersedes_id: supersedesId, verified_by: verifiedBy ?? (state === "verified" ? "supervisor" : null), created_at: now };
}

function pathsOverlap(left, right) {
  const normalize = (path) => process.platform === "win32" ? path.replace(/\\/g, "/").toLowerCase() : path;
  const a = normalize(left).replace(/\/$/, "");
  const b = normalize(right).replace(/\/$/, "");
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function repoRelativePaths(projectRoot, paths) {
  return (paths ?? []).flatMap((path) => {
    if (typeof path !== "string" || !path.trim()) return [];
    const candidate = isAbsolute(path) ? relative(projectRoot, path) : path;
    const normalized = candidate.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
    return !normalized || normalized === ".." || normalized.startsWith("../") ? [] : [normalized];
  });
}

function git(cwd, args) {
  return execFileSync(process.env.GIT_BIN?.trim() || "git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 15000,
    stdio: ["ignore", "pipe", "ignore"]
  }).trim();
}

function shaCoversBase(projectRoot, validForSha, baseSha) {
  if (!validForSha || !baseSha) return true;
  try {
    git(projectRoot, ["merge-base", "--is-ancestor", validForSha, baseSha]);
    return true;
  } catch {
    return false;
  }
}

function watchedPathsChanged(projectRoot, validForSha, baseSha, watchedPaths) {
  if (!validForSha || !baseSha || watchedPaths.length === 0) return false;
  try {
    const relativePaths = repoRelativePaths(projectRoot, watchedPaths);
    if (relativePaths.length === 0) return true;
    return Boolean(git(projectRoot, ["diff", "--name-only", validForSha, baseSha, "--", ...relativePaths]));
  } catch {
    return true;
  }
}

async function currentWorkspaceManifest(task) {
  const metadata = task.workspace_metadata;
  if (!metadata?.source_root || !Array.isArray(metadata.manifest_paths) || metadata.manifest_paths.length === 0) return null;
  try {
    return await captureWorkspaceManifest(metadata.source_root, metadata.manifest_paths);
  } catch {
    return null;
  }
}

async function currentContextContentHash(task) {
  const context = task.input_context?.context ?? [];
  if (!Array.isArray(context) || context.length === 0) return null;
  try {
    return (await buildHandoff({ context }, { maxLines: 1, maxChars: 1 })).content_hash;
  } catch {
    return null;
  }
}

function markFactExpired(id) {
  openDb().prepare(`
    INSERT INTO facts (id, work_item_id, scope_type, scope_id, key, value_json, state, source_event_id, source_artifact_id,
      valid_for_sha, valid_for_content_hash, valid_for_manifest_hash, watched_paths, expires_at, supersedes_id, created_at, verified_at, verified_by)
    SELECT ?, source.work_item_id, source.scope_type, source.scope_id, source.key, source.value_json, 'expired', source.source_event_id, source.source_artifact_id,
      source.valid_for_sha, source.valid_for_content_hash, source.valid_for_manifest_hash, source.watched_paths, source.expires_at, source.id, ?, source.verified_at, source.verified_by
    FROM facts AS source
    WHERE source.id = ? AND source.state = 'verified'
      AND NOT EXISTS (SELECT 1 FROM facts AS transition WHERE transition.supersedes_id = source.id AND transition.state IN ('expired', 'revoked'))
  `).run(randomUUID(), new Date().toISOString(), id);
}

export async function listContextFacts({ taskId, baseSha, ownedPaths = [], dependencyTaskIds = [] }) {
  await ensureFilesystem();
  const workItem = await getWorkItemForTask(taskId);
  if (!workItem) return [];
  const task = await getTask(taskId);
  if (!task) return [];
  const dependencyItems = dependencyTaskIds.length === 0
    ? []
    : openDb().prepare(`SELECT id FROM work_items WHERE task_id IN (${dependencyTaskIds.map(() => "?").join(",")})`).all(...dependencyTaskIds).map((row) => row.id);
  const rows = openDb().prepare(`
    SELECT facts.* FROM facts
    WHERE state = 'verified'
      AND NOT EXISTS (SELECT 1 FROM facts AS transition WHERE transition.supersedes_id = facts.id AND transition.state IN ('expired', 'revoked'))
    ORDER BY created_at ASC
  `).all();
  const now = Date.now();
  const workspaceManifest = await currentWorkspaceManifest(task);
  const contextContentHash = await currentContextContentHash(task);
  const repo = openDb().prepare("SELECT canonical_remote FROM repos WHERE id = ?").get(workItem.repo_id);
  const canonicalRemote = repo?.canonical_remote ?? null;
  const ownedRelative = repoRelativePaths(task.project_root, ownedPaths);
  const visible = [];
  for (const row of rows) {
    const watched = decodeJson(row.watched_paths, []);
    const watchedRelative = repoRelativePaths(task.project_root, watched);
    const included = row.scope_type === "work_item" ? row.scope_id === workItem.id
      : row.scope_type === "dependency" ? dependencyItems.includes(row.scope_id)
        : row.scope_type === "repo_verified" && canonicalRemote && row.scope_id === canonicalRemote
          && watchedRelative.length > 0 && watchedRelative.some((path) => ownedRelative.some((owned) => pathsOverlap(path, owned)));
    if (!included) continue;
    if (row.expires_at && Date.parse(row.expires_at) <= now) {
      markFactExpired(row.id);
      continue;
    }
    if (!shaCoversBase(task.project_root, row.valid_for_sha, baseSha)) continue;
    if (watchedPathsChanged(task.project_root, row.valid_for_sha, baseSha, watchedRelative)) {
      if (row.scope_type === "work_item" && row.scope_id === workItem.id) markFactExpired(row.id);
      continue;
    }
    if (row.valid_for_manifest_hash && (!workspaceManifest || workspaceManifest.sha256 !== row.valid_for_manifest_hash)) {
      if (row.scope_type === "work_item" && row.scope_id === workItem.id && workspaceManifest) markFactExpired(row.id);
      continue;
    }
    if (row.valid_for_content_hash && contextContentHash !== row.valid_for_content_hash) {
      if (row.scope_type === "work_item" && row.scope_id === workItem.id) markFactExpired(row.id);
      continue;
    }
    visible.push({
      ...row,
      value: decodeJson(row.value_json, null),
      watched_paths: watched
    });
  }
  return visible;
}

export async function countVerifiedFacts() {
  await ensureFilesystem();
  return openDb().prepare(`
    SELECT COUNT(*) AS count FROM facts
    WHERE state = 'verified'
      AND NOT EXISTS (SELECT 1 FROM facts AS transition WHERE transition.supersedes_id = facts.id AND transition.state IN ('expired', 'revoked'))
  `).get().count;
}

export async function createContextSnapshot({ runId, recipient = "worker", factIds = [], baseSha = null, prompt, estimatedTokens, excluded = {} }) {
  await ensureFilesystem();
  if (!runId || typeof prompt !== "string") throw new Error("context snapshot requires runId and prompt");
  const now = new Date().toISOString();
  const id = randomUUID();
  openDb().prepare(`
    INSERT INTO context_snapshots (id, run_id, recipient, fact_versions, base_sha, prompt_sha256, estimated_tokens, excluded_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, runId, recipient, JSON.stringify(factIds), baseSha,
    createHash("sha256").update(prompt).digest("hex"), estimatedTokens, JSON.stringify(excluded), now);
  return { id, run_id: runId, recipient, fact_versions: factIds, base_sha: baseSha, estimated_tokens: estimatedTokens, created_at: now };
}

export async function latestContextSnapshotForTask(taskId) {
  await ensureFilesystem();
  return openDb().prepare(`
    SELECT s.* FROM context_snapshots s JOIN runs r ON r.id = s.run_id
    WHERE r.task_id = ? ORDER BY s.created_at DESC LIMIT 1
  `).get(taskId) ?? null;
}

export async function getFact(factId) {
  await ensureFilesystem();
  const row = openDb().prepare("SELECT * FROM facts WHERE id = ?").get(factId);
  if (!row) return null;
  return {
    ...row,
    value: decodeJson(row.value_json, null),
    watched_paths: decodeJson(row.watched_paths, [])
  };
}

export async function getTaskForWorkItem(workItemId) {
  await ensureFilesystem();
  return openDb().prepare("SELECT * FROM tasks WHERE id = (SELECT task_id FROM work_items WHERE id = ?)").get(workItemId) ?? null;
}

export async function isFactRevoked(factId) {
  await ensureFilesystem();
  return Boolean(openDb().prepare("SELECT 1 FROM facts WHERE supersedes_id = ? AND state = 'revoked'").get(factId));
}

export async function getFactEffectiveState(factId) {
  await ensureFilesystem();
  const transition = openDb().prepare(`
    SELECT state FROM facts WHERE supersedes_id = ? AND state IN ('revoked', 'expired')
    ORDER BY CASE state WHEN 'revoked' THEN 0 ELSE 1 END, created_at DESC LIMIT 1
  `).get(factId);
  return transition?.state ?? null;
}

export async function promoteCandidateFact({ factId, scopeType = "work_item", watchedPaths = null, expiresAt = null, sourceEventId = null, verifiedBy = "main_thread" }) {
  await ensureFilesystem();
  const source = await getFact(factId);
  if (!source) throw new Error(`fact not found: ${factId}`);
  if (await isFactRevoked(factId)) {
    const error = new Error(`fact ${factId} is already revoked`);
    error.code = "fact_already_revoked";
    throw error;
  }
  if (source.state !== "candidate") {
    const error = new Error(`only candidate facts may be promoted; ${factId} is ${source.state}`);
    error.code = "fact_not_candidate";
    throw error;
  }
  if (!['work_item', 'repo_verified'].includes(scopeType)) throw new Error("promotion scope must be work_item or repo_verified");
  const workItem = openDb().prepare("SELECT * FROM work_items WHERE id = ?").get(source.work_item_id);
  if (!workItem) throw new Error(`work item not found for fact: ${factId}`);
  const sourceTask = await getTaskForWorkItem(workItem.id);
  const paths = watchedPaths ?? source.watched_paths ?? [];
  const repo = openDb().prepare("SELECT canonical_remote FROM repos WHERE id = ?").get(workItem.repo_id);
  const canonicalRemote = repo?.canonical_remote ?? null;
  const normalizedRepoPaths = sourceTask ? repoRelativePaths(sourceTask.project_root, paths) : [];
  if (scopeType === "repo_verified" && paths.length === 0) {
    const error = new Error("repo_verified promotion requires watchedPaths so unrelated work cannot inherit it");
    error.code = "repo_fact_requires_paths";
    throw error;
  }
  if (scopeType === "repo_verified" && !canonicalRemote) {
    const error = new Error("repo_verified promotion requires a canonical origin remote; facts from an unrecognized or missing remote stay work-scoped");
    error.code = "repo_fact_requires_canonical_remote";
    throw error;
  }
  if (scopeType === "repo_verified" && normalizedRepoPaths.length === 0) {
    const error = new Error("repo_verified watchedPaths must stay inside the repository root");
    error.code = "repo_fact_paths_outside_root";
    throw error;
  }
  return recordFact({
    workItemId: source.work_item_id,
    scopeType,
    scopeId: scopeType === "repo_verified" ? canonicalRemote : workItem.id,
    key: source.key,
    value: source.value,
    state: "verified",
    sourceEventId,
    sourceArtifactId: source.source_artifact_id ?? null,
    validForSha: source.valid_for_sha ?? null,
    validForContentHash: source.valid_for_content_hash ?? null,
    validForManifestHash: source.valid_for_manifest_hash ?? null,
    watchedPaths: scopeType === "repo_verified" ? normalizedRepoPaths : paths,
    expiresAt: expiresAt ?? source.expires_at ?? null,
    supersedesId: source.id,
    verifiedBy
  });
}

export async function revokeFact(factId) {
  await ensureFilesystem();
  const source = await getFact(factId);
  if (!source) return null;
  if (!["candidate", "verified"].includes(source.state)) {
    const error = new Error(`only candidate or verified facts may be revoked; ${factId} is ${source.state}`);
    error.code = "fact_not_revocable";
    throw error;
  }
  if (await isFactRevoked(factId)) {
    const error = new Error(`fact ${factId} is already revoked`);
    error.code = "fact_already_revoked";
    throw error;
  }
  return recordFact({
    workItemId: source.work_item_id,
    scopeType: source.scope_type,
    scopeId: source.scope_id,
    key: source.key,
    value: source.value,
    state: "revoked",
    sourceEventId: source.source_event_id,
    sourceArtifactId: source.source_artifact_id,
    validForSha: source.valid_for_sha,
    validForContentHash: source.valid_for_content_hash,
    validForManifestHash: source.valid_for_manifest_hash,
    watchedPaths: source.watched_paths,
    expiresAt: source.expires_at,
    supersedesId: source.id,
    verifiedBy: "main_thread"
  });
}

export async function recordJsonArtifact({ runId, type, value, securityClass = "internal", retention = "permanent" }) {
  await ensureFilesystem();
  if (!runId || !type) throw new Error("artifact requires runId and type");
  const id = randomUUID();
  const content = JSON.stringify(value, null, 2);
  const sha256 = createHash("sha256").update(content).digest("hex");
  const path = join(artifactsDir, `${id}.json`);
  await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
  const now = new Date().toISOString();
  openDb().prepare(`
    INSERT INTO artifacts (id, run_id, type, uri, sha256, security_class, retention, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, runId, type, path, sha256, securityClass, retention, now);
  return { id, run_id: runId, type, uri: path, sha256, security_class: securityClass, retention, created_at: now };
}

export async function getArtifact(artifactId) {
  await ensureFilesystem();
  return openDb().prepare("SELECT * FROM artifacts WHERE id = ?").get(artifactId) ?? null;
}

export async function readArtifact(artifactId, maxChars = 12000) {
  const artifact = await getArtifact(artifactId);
  if (!artifact) return null;
  const artifactPath = relative(artifactsDir, resolve(artifact.uri));
  if (!artifactPath || artifactPath === ".." || artifactPath.startsWith(`..${sep}`) || isAbsolute(artifactPath)) {
    return { ...artifact, content: null, reason: "artifact_uri_not_managed" };
  }
  let content;
  try {
    content = await readFile(artifact.uri, "utf8");
  } catch (error) {
    return { ...artifact, content: null, reason: `artifact_unreadable: ${error.code ?? error.message}` };
  }
  const truncated = content.length > maxChars;
  return { ...artifact, content: truncated ? `${content.slice(0, maxChars)}…` : content, truncated };
}

export async function listArtifactsForTask(taskId, limit = 50) {
  await ensureFilesystem();
  return openDb().prepare(`
    SELECT a.* FROM artifacts a JOIN runs r ON r.id = a.run_id
    WHERE r.task_id = ? ORDER BY a.created_at DESC LIMIT ?
  `).all(taskId, limit);
}

export async function createReviewAssignment({ subjectTaskId, verifierTaskId, subjectRunId = null, subjectBaseSha = null, subjectFingerprint = null }) {
  await ensureFilesystem();
  const now = new Date().toISOString();
  const id = randomUUID();
  openDb().prepare(`
    INSERT INTO review_findings (id, subject_task_id, verifier_task_id, subject_run_id, subject_base_sha, subject_fingerprint, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(id, subjectTaskId, verifierTaskId, subjectRunId, subjectBaseSha, subjectFingerprint, now, now);
  return { id, subject_task_id: subjectTaskId, verifier_task_id: verifierTaskId, subject_run_id: subjectRunId, subject_base_sha: subjectBaseSha, subject_fingerprint: subjectFingerprint, status: "pending", created_at: now, updated_at: now };
}

export async function getReviewByVerifierTask(verifierTaskId) {
  await ensureFilesystem();
  return openDb().prepare("SELECT * FROM review_findings WHERE verifier_task_id = ?").get(verifierTaskId) ?? null;
}

export async function recordReviewFinding({ verifierTaskId, verdict, reason, evidenceArtifactId = null, findingEventId = null }) {
  await ensureFilesystem();
  if (!['passes', 'fails', 'inconclusive'].includes(verdict)) throw new Error("review verdict must be passes, fails or inconclusive");
  const now = new Date().toISOString();
  const result = openDb().prepare(`
    UPDATE review_findings
    SET status = 'recorded', verdict = ?, reason = ?, evidence_artifact_id = ?, finding_event_id = ?, updated_at = ?
    WHERE verifier_task_id = ? AND status = 'pending'
  `).run(verdict, reason, evidenceArtifactId, findingEventId, now, verifierTaskId);
  if (result.changes === 0) return null;
  return getReviewByVerifierTask(verifierTaskId);
}

export async function resolveReviewFinding({ verifierTaskId, resolution, resolvedBy = 'main_thread' }) {
  await ensureFilesystem();
  const now = new Date().toISOString();
  const result = openDb().prepare(`
    UPDATE review_findings
    SET status = 'resolved', resolution = ?, resolved_at = ?, resolved_by = ?, updated_at = ?
    WHERE verifier_task_id = ? AND status = 'recorded'
  `).run(resolution, now, resolvedBy, now, verifierTaskId);
  if (result.changes === 0) return null;
  return getReviewByVerifierTask(verifierTaskId);
}

export async function updateWorkItemDelivery(taskId, deliveryState) {
  await ensureFilesystem();
  if (!["draft", "verified", "landed", "push_verified", "cleanup_eligible", "cleanup_removed", "needs_attention"].includes(deliveryState)) {
    throw new Error("invalid delivery state");
  }
  const result = openDb().prepare("UPDATE work_items SET delivery_state = ?, updated_at = ? WHERE task_id = ?")
    .run(deliveryState, new Date().toISOString(), taskId);
  return result.changes > 0;
}

export async function saveCleanupPlan(plan) {
  await ensureFilesystem();
  const dbInstance = openDb();
  dbInstance.exec("BEGIN IMMEDIATE");
  try {
    dbInstance.prepare(`
      INSERT INTO cleanup_plans (id, project_root, generated_at, expires_at, policy, summary_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(plan.id, plan.project_root, plan.generated_at, plan.expires_at, plan.policy, JSON.stringify(plan.summary));
    const insert = dbInstance.prepare(`
      INSERT INTO cleanup_plan_items (id, plan_id, task_id, verdict, reasons_json, fingerprint, reclaimable_bytes, eligible_after, applied_at, applied_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
    `);
    for (const item of plan.items) {
      item.id = item.id ?? randomUUID();
      insert.run(item.id, plan.id, item.task_id, item.verdict, JSON.stringify(item.reasons), item.fingerprint, item.reclaimable_bytes, item.eligible_after);
      if (item.verdict === "safe") {
        dbInstance.prepare("UPDATE work_items SET delivery_state = 'cleanup_eligible', updated_at = ? WHERE task_id = ? AND delivery_state = 'push_verified'")
          .run(new Date().toISOString(), item.task_id);
      } else {
        dbInstance.prepare("UPDATE work_items SET delivery_state = 'push_verified', updated_at = ? WHERE task_id = ? AND delivery_state = 'cleanup_eligible'")
          .run(new Date().toISOString(), item.task_id);
      }
    }
    dbInstance.exec("COMMIT");
  } catch (error) {
    dbInstance.exec("ROLLBACK");
    throw error;
  }
}

export async function getCleanupPlan(planId) {
  await ensureFilesystem();
  const plan = openDb().prepare("SELECT * FROM cleanup_plans WHERE id = ?").get(planId);
  if (!plan) return null;
  const items = openDb().prepare("SELECT * FROM cleanup_plan_items WHERE plan_id = ? ORDER BY task_id").all(planId).map((item) => ({
    ...item,
    reasons: decodeJson(item.reasons_json, [])
  }));
  return { ...plan, summary: decodeJson(plan.summary_json, {}), items };
}

export async function markCleanupPlanItemApplied(itemId, actor = "main_thread") {
  await ensureFilesystem();
  const now = new Date().toISOString();
  openDb().prepare("UPDATE cleanup_plan_items SET applied_at = ?, applied_by = ? WHERE id = ? AND applied_at IS NULL")
    .run(now, actor, itemId);
  return now;
}

export async function readCleanupHistory(taskId = null, limit = 100) {
  await ensureFilesystem();
  const rows = taskId
    ? openDb().prepare(`SELECT i.*, p.generated_at, p.expires_at, p.policy FROM cleanup_plan_items i JOIN cleanup_plans p ON p.id = i.plan_id WHERE i.task_id = ? ORDER BY p.generated_at DESC LIMIT ?`).all(taskId, limit)
    : openDb().prepare(`SELECT i.*, p.generated_at, p.expires_at, p.policy FROM cleanup_plan_items i JOIN cleanup_plans p ON p.id = i.plan_id ORDER BY p.generated_at DESC LIMIT ?`).all(limit);
  return rows.map((row) => ({ ...row, reasons: decodeJson(row.reasons_json, []) }));
}

export async function listTaskEventKinds(taskId) {
  await ensureFilesystem();
  return openDb().prepare(`
    SELECT event_type AS kind, COUNT(*) AS count
    FROM task_events WHERE task_id = ? GROUP BY event_type ORDER BY count DESC
  `).all(taskId);
}

// A worker's report is the only thing a supervisor usually wants back, and the
// task row keeps just the most recent one. This reads them out of the raw
// stream newest-first: `payload LIKE` is a cheap prefilter, and every row that
// survives it is verified through the same extraction the state machine uses.
export async function readAgentMessages(taskId, limit = 1) {
  await ensureFilesystem();
  const rows = openDb().prepare(`
    SELECT payload FROM task_events
    WHERE task_id = ? AND event_type = 'item.completed' AND payload LIKE '%"agent_message"%'
    ORDER BY seq DESC LIMIT ?
  `).all(taskId, limit * 5 + 10);
  const messages = [];
  for (const row of rows) {
    let text = null;
    try {
      text = extractAgentMessage(JSON.parse(row.payload));
    } catch {
      text = null;
    }
    if (text) messages.push(text);
    if (messages.length >= limit) break;
  }
  return messages.reverse();
}

export async function taskCount() {
  await ensureFilesystem();
  const row = openDb().prepare("SELECT COUNT(*) AS count FROM tasks").get();
  return row.count;
}

export async function taskExists(taskId) {
  return Boolean(await getTask(taskId));
}

export async function taskHasEvents(taskId) {
  await ensureFilesystem();
  const row = openDb().prepare("SELECT 1 FROM task_events WHERE task_id = ? LIMIT 1").get(taskId);
  return Boolean(row);
}

export async function taskEventCount(taskId) {
  await ensureFilesystem();
  const row = openDb().prepare("SELECT COUNT(*) AS count FROM task_events WHERE task_id = ?").get(taskId);
  return row.count;
}

export async function deleteTasks(taskIds) {
  await ensureFilesystem();
  if (taskIds.length === 0) return;
  const dbInstance = openDb();
  const deleteEvents = dbInstance.prepare("DELETE FROM task_events WHERE task_id = ?");
  const deleteTask = dbInstance.prepare("DELETE FROM tasks WHERE id = ?");
  dbInstance.exec("BEGIN IMMEDIATE;");
  try {
    for (const taskId of taskIds) {
      deleteEvents.run(taskId);
      deleteTask.run(taskId);
    }
    dbInstance.exec("COMMIT;");
  } catch (error) {
    dbInstance.exec("ROLLBACK;");
    throw error;
  }
}

export async function vacuumStore() {
  await ensureFilesystem();
  openDb().exec("VACUUM;");
}
