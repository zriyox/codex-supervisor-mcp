import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dataDir, dbPath, runsDir } from "./paths.js";
import { extractAgentMessage } from "./event-parser.js";
import { ACTIVE_STATUSES, PHASES } from "./status.js";

let db;

// Columns added after v1. Kept in one place so the legacy rebuild and the
// fresh CREATE TABLE cannot drift apart.
const POST_V1_COLUMNS = [
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
  ["session_id", "TEXT"]
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
      run_log TEXT NOT NULL
    );
`;

const TASK_COLUMNS = [
  "id", "title", "worker", "status", "phase", "cwd", "project_root", "sandbox", "model",
  "reasoning_effort", "skip_git_repo_check", "prompt", "changed_files", "commands",
  "created_at", "updated_at", "started_at", "completed_at", "pid", "exit_code", "signal",
  "stderr_tail", "last_event_at", "last_event_type", "last_message", "current_action",
  "current_command", "error", "followup_of", "resumed_from", "session_id", "thread_id", "owned_paths",
  "depends_on", "goal_objective", "goal_token_budget", "goal_status", "goal_tokens_used",
  "goal_time_used_seconds", "goal_updated_at", "run_count", "cancel_requested_at",
  "notices", "worktree_path", "run_log"
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
    const definition = POST_V1_COLUMNS.find(([columnName]) => columnName === name);
    if (definition && definition[1].includes("DEFAULT '[]'")) return "'[]'";
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
      seq INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL
    );
  `;

const TASK_EVENTS_INDEX_DDL =
  "CREATE INDEX IF NOT EXISTS idx_task_events_task_seq ON task_events(task_id, seq);";

const TASKS_SESSION_INDEX_DDL =
  "CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);";

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
      dbInstance.exec(TASK_EVENTS_INDEX_DDL);
      dbInstance.exec(TASKS_SESSION_INDEX_DDL);
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
  return {
    ...row,
    skip_git_repo_check: Boolean(row.skip_git_repo_check),
    changed_files: decodeJson(row.changed_files, []),
    commands: decodeJson(row.commands, []),
    owned_paths: decodeJson(row.owned_paths, []),
    depends_on: decodeJson(row.depends_on, []),
    pid: row.pid ?? null,
    exit_code: row.exit_code ?? null,
    phase: row.phase ?? null,
    goal_token_budget: row.goal_token_budget ?? null,
    goal_tokens_used: row.goal_tokens_used ?? null,
    goal_time_used_seconds: row.goal_time_used_seconds ?? null,
    goal_status: row.goal_status ?? null
  };
}

function isPidAlive(pid) {
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
export async function reconcileDetachedActiveTasks() {
  const tasks = await readActiveTasks();
  const staleTasks = tasks.filter((task) => task.pid && !isPidAlive(task.pid));
  for (const task of staleTasks) {
    const now = new Date().toISOString();
    await writeTask({
      ...task,
      status: "lost",
      phase: null,
      current_action: "Worker process disappeared without a terminal event",
      current_command: null,
      error: task.error ?? "Codex worker process disappeared before a terminal event was recorded.",
      completed_at: task.completed_at ?? now,
      updated_at: now
    });
  }
  return staleTasks;
}

export async function writeTask(task) {
  await ensureFilesystem();
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
  params.skip_git_repo_check = task.skip_git_repo_check ? 1 : 0;
  params.changed_files = encodeJson(task.changed_files);
  params.commands = encodeJson(task.commands);
  params.owned_paths = encodeJson(task.owned_paths);
  params.depends_on = encodeJson(task.depends_on);
  params.run_count = task.run_count ?? 0;
  params.phase = task.phase ?? null;

  stmt.run(params);
  return task;
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

export async function appendTaskEvent(taskId, event) {
  await ensureFilesystem();
  const dbInstance = openDb();
  const nextSeqRow = dbInstance.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM task_events WHERE task_id = ?").get(taskId);
  dbInstance.prepare(`
    INSERT INTO task_events (task_id, seq, created_at, event_type, payload)
    VALUES (?, ?, ?, ?, ?)
  `).run(taskId, nextSeqRow.seq, new Date().toISOString(), event.type ?? "unknown", JSON.stringify(event));
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
