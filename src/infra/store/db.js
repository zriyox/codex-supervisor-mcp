import { PHASES } from "../../domain/status.js";
import { artifactsDir, dataDir, dbPath, runsDir } from "../paths.js";
import { git } from "./facts.js";
import { CONTROL_DDL, POST_V1_COLUMNS, SESSIONS_DDL, SIDE_DDL, TASK_COLUMNS, TASK_EVENTS_DDL, TASK_EVENTS_INDEX_DDL, TASK_EXTRA_COLUMNS, TASKS_DDL, TASKS_SESSION_INDEX_DDL } from "./schema.js";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

let db;

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

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isBusyError(error) {
  return /SQLITE_BUSY|database is locked|database table is locked/i.test(String(error?.message ?? ""));
}

// Several MCP processes may open a brand-new database at the same moment, so
// schema setup runs inside one immediate transaction (which the busy timeout
// makes wait instead of failing) and is retried if the file is still locked.
export function runWithRetry(dbInstance, work, attempts = 10) {
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

export function canonicalRemoteForRoot(root) {
  try {
    return canonicalizeRemote(git(root, ["remote", "get-url", "origin"]));
  } catch {
    return null;
  }
}

export function workItemIdForTask(taskId) {
  return `work-${taskId}`;
}

export function runIdFor(taskId, attempt) {
  return `run-${taskId}-${attempt}`;
}

export function ensureControlRecords(dbInstance, task, { refreshRepo = false, canonicalRemote = undefined } = {}) {
  if (!task?.id || !task.project_root) return;
  const now = new Date().toISOString();
  const root = resolve(task.project_root);
  const repoId = repoIdForRoot(root);
  const workItemId = workItemIdForTask(task.id);
  const repo = dbInstance.prepare("SELECT id FROM repos WHERE root = ?").get(root);
  if (!repo || refreshRepo) {
    const resolvedRemote = canonicalRemote === undefined ? canonicalRemoteForRoot(root) : canonicalRemote;
    dbInstance.prepare(`
      INSERT INTO repos (id, canonical_remote, root, default_branch, created_at, updated_at)
      VALUES (@id, @canonical_remote, @root, NULL, @now, @now)
      ON CONFLICT(root) DO UPDATE SET canonical_remote = excluded.canonical_remote, updated_at = excluded.updated_at
    `).run({ id: repoId, canonical_remote: resolvedRemote, root, now });
  }
  const workItem = dbInstance.prepare("SELECT id FROM work_items WHERE task_id = ?").get(task.id);
  if (workItem) return;
  dbInstance.prepare(`
    INSERT INTO work_items (id, repo_id, task_id, parent_work_item_id, objective, owner, delivery_state, created_at, updated_at)
    VALUES (@id, @repo_id, @task_id, NULL, @objective, NULL, @delivery_state, @now, @now)
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
  const rows = dbInstance.prepare(`
    SELECT t.id,t.title,t.project_root,t.goal_objective,t.landed_at
    FROM tasks AS t
    LEFT JOIN work_items AS w ON w.task_id = t.id
    WHERE w.task_id IS NULL
  `).all();
  for (const row of rows) ensureControlRecords(dbInstance, row);
}

export function openDb() {
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

export async function ensureFilesystem() {
  await mkdir(dataDir, { recursive: true });
  await mkdir(runsDir, { recursive: true });
  await mkdir(artifactsDir, { recursive: true });
}

export function encodeJson(value) {
  return JSON.stringify(value ?? []);
}

export function decodeJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
