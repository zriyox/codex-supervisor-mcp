import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dataDir, dbPath, runsDir } from "./paths.js";

let db;

function ensureColumn(dbInstance, tableName, columnName, definition) {
  const columns = dbInstance.prepare(`PRAGMA table_info(${tableName})`).all();
  if (!columns.some((column) => column.name === columnName)) {
    dbInstance.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition};`);
  }
}

function openDb() {
  if (db) return db;
  db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA synchronous=NORMAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT,
      worker TEXT NOT NULL,
      status TEXT NOT NULL,
      phase TEXT NOT NULL,
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
      worktree_path TEXT,
      run_log TEXT NOT NULL
    );
  `);
  ensureColumn(db, "tasks", "reasoning_effort", "TEXT NOT NULL DEFAULT 'high'");
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL
    );
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_task_events_task_seq ON task_events(task_id, seq);");
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
  return JSON.parse(value);
}

function rowToTask(row) {
  if (!row) return null;
  return {
    ...row,
    skip_git_repo_check: Boolean(row.skip_git_repo_check),
    changed_files: decodeJson(row.changed_files, []),
    commands: decodeJson(row.commands, []),
    pid: row.pid ?? null,
    exit_code: row.exit_code ?? null
  };
}

function isActiveTask(task) {
  return ["queued", "running", "editing", "command", "command_completed", "reporting"].includes(task.status);
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

export async function reconcileDetachedActiveTasks() {
  const tasks = await readTasks();
  const staleTasks = tasks.filter((task) => isActiveTask(task) && task.pid && !isPidAlive(task.pid));
  for (const task of staleTasks) {
    await writeTask({
      ...task,
      status: "failed",
      phase: "failed",
      current_action: "Worker process is no longer running",
      current_command: null,
      error: task.error ?? "Codex worker process disappeared before a terminal event was recorded.",
      completed_at: task.completed_at ?? new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
  }
  return staleTasks;
}

export async function writeTask(task) {
  await ensureFilesystem();
  const stmt = openDb().prepare(`
    INSERT INTO tasks (
      id, title, worker, status, phase, cwd, project_root, sandbox, model, reasoning_effort, skip_git_repo_check,
      prompt, changed_files, commands, created_at, updated_at, started_at, completed_at,
      pid, exit_code, signal, stderr_tail, last_event_at, last_event_type, last_message,
      current_action, current_command, error, followup_of, worktree_path, run_log
    ) VALUES (
      @id, @title, @worker, @status, @phase, @cwd, @project_root, @sandbox, @model, @reasoning_effort, @skip_git_repo_check,
      @prompt, @changed_files, @commands, @created_at, @updated_at, @started_at, @completed_at,
      @pid, @exit_code, @signal, @stderr_tail, @last_event_at, @last_event_type, @last_message,
      @current_action, @current_command, @error, @followup_of, @worktree_path, @run_log
    )
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      worker = excluded.worker,
      status = excluded.status,
      phase = excluded.phase,
      cwd = excluded.cwd,
      project_root = excluded.project_root,
      sandbox = excluded.sandbox,
      model = excluded.model,
      reasoning_effort = excluded.reasoning_effort,
      skip_git_repo_check = excluded.skip_git_repo_check,
      prompt = excluded.prompt,
      changed_files = excluded.changed_files,
      commands = excluded.commands,
      updated_at = excluded.updated_at,
      started_at = excluded.started_at,
      completed_at = excluded.completed_at,
      pid = excluded.pid,
      exit_code = excluded.exit_code,
      signal = excluded.signal,
      stderr_tail = excluded.stderr_tail,
      last_event_at = excluded.last_event_at,
      last_event_type = excluded.last_event_type,
      last_message = excluded.last_message,
      current_action = excluded.current_action,
      current_command = excluded.current_command,
      error = excluded.error,
      followup_of = excluded.followup_of,
      worktree_path = excluded.worktree_path,
      run_log = excluded.run_log
  `);

  stmt.run({
    ...task,
    reasoning_effort: task.reasoning_effort ?? "high",
    skip_git_repo_check: task.skip_git_repo_check ? 1 : 0,
    project_root: task.project_root,
    changed_files: encodeJson(task.changed_files),
    commands: encodeJson(task.commands)
  });
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

export async function readTaskEvents(taskId, limit = 100) {
  await ensureFilesystem();
  const rows = openDb().prepare(`
    SELECT payload
    FROM task_events
    WHERE task_id = ?
    ORDER BY seq DESC
    LIMIT ?
  `).all(taskId, limit);
  return rows.reverse().map((row) => JSON.parse(row.payload));
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
