import { ACTIVE_STATUSES, TERMINAL_STATUSES } from "../../domain/status.js";
import { readPreflightResult } from "../../domain/worker-preflight.js";
import { runsDir } from "../paths.js";
import { canonicalRemoteForRoot, decodeJson, encodeJson, ensureControlRecords, ensureFilesystem, openDb, runWithRetry } from "./db.js";
import { readNativeGoal } from "./runner-readers.js";
import { TASK_COLUMNS } from "./schema.js";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

export function rowToTask(row) {
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

export function neverStarted(task, now = Date.now()) {
  if (task.pid) return false;
  if (task.started_at) return false;
  const created = Date.parse(task.created_at ?? "");
  if (Number.isNaN(created)) return true;
  return now - created > NEVER_STARTED_GRACE_MS;
}

export async function writeTask(task) {
  await ensureFilesystem();
  return runWithRetry(openDb(), () => writeTaskNow(task));
}

function writeTaskNow(task, { refreshRepo = false, canonicalRemote = undefined } = {}) {
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
  ensureControlRecords(openDb(), task, { refreshRepo, canonicalRemote });
  return task;
}

function checkOwnership(taskId, incoming) {
  const normalized = (value) => process.platform === "win32" ? value.replace(/\\/g, "/").toLowerCase() : value;
  const overlaps = (left, right) => {
    const a=normalized(left).replace(/\/$/,""),b=normalized(right).replace(/\/$/,"");
    return a===b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
  };
  const conflicts = [];
  const pending = openDb().prepare("SELECT t.id,t.title,t.status,t.owned_paths,t.acceptance_results,t.started_at,t.exit_code,t.guard_policy,t.commands,t.attention_reason,c.owner_pid FROM tasks t LEFT JOIN run_claims c ON c.task_id=t.id WHERE t.id<>? AND (c.owner_pid IS NOT NULL OR status IN ('queued','running') OR json_extract(acceptance_results,'$.status')='running' OR (status IN ('completed','failed') AND started_at IS NOT NULL AND exit_code IS NULL AND acceptance_results IS NULL))").all(taskId);
  for (const row of pending) {
    const settling = decodeJson(row.acceptance_results,null)?.status === "running"
      || (["completed","failed"].includes(row.status) && row.started_at && row.exit_code == null && !row.acceptance_results);
    if (row.owner_pid && !ACTIVE_STATUSES.has(row.status) && !settling && !isPidAlive(row.owner_pid)) continue;
    const preflightTask = {
      ...row,
      guard_policy: decodeJson(row.guard_policy, null),
      commands: decodeJson(row.commands, [])
    };
    if (preflightTask.guard_policy?.preflight && readPreflightResult(preflightTask).status === "passed") continue;
    const paths=decodeJson(row.owned_paths,[]);
    const matching=incoming.flatMap(path=>paths.filter(other=>overlaps(path,other)).map(other=>({incoming:path,existing:other})));
    if(matching.length)conflicts.push({task_id:row.id,title:row.title,status:row.status,overlapping_paths:matching});
  }
  if(conflicts.length){const error=new Error("ownedPaths overlap with an active worker claimed by another dispatcher");error.code="ownership_conflict";error.conflicts=conflicts;throw error;}
}

export async function reserveTaskOwnership(task) {
  await ensureFilesystem();
  const canonicalRemote = task?.project_root ? canonicalRemoteForRoot(resolve(task.project_root)) : null;
  const connection=openDb();
  return runWithRetry(connection,()=>{
    connection.exec("BEGIN IMMEDIATE");
    try { checkOwnership(task.id,task.owned_paths??[]);writeTaskNow(task, { refreshRepo: true, canonicalRemote });connection.exec("COMMIT");return task; }
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

// The same lock a dispatcher takes before it runs a task, for work that needs
// the task to stay idle without running it (removing its worktree). Null when
// the task is running, settling, or held by a live dispatcher.
export async function claimIdleTask(taskId) {
  await ensureFilesystem();
  const connection = openDb();
  return runWithRetry(connection, () => {
    connection.exec("BEGIN IMMEDIATE");
    try {
      const row = connection.prepare("SELECT * FROM tasks WHERE id=?").get(taskId);
      const claim = connection.prepare("SELECT * FROM run_claims WHERE task_id=?").get(taskId);
      const busy = !row || ACTIVE_STATUSES.has(row.status)
        || (["completed", "failed"].includes(row.status) && row.exit_code == null)
        || decodeJson(row.acceptance_results, null)?.status === "running"
        || (claim && isPidAlive(claim.owner_pid));
      let token = null;
      if (!busy) {
        token = randomUUID();
        connection.prepare("INSERT INTO run_claims VALUES (?,?,?) ON CONFLICT(task_id) DO UPDATE SET token=excluded.token,owner_pid=excluded.owner_pid")
          .run(taskId, token, process.pid);
      }
      connection.exec("COMMIT");
      return token;
    } catch (error) {
      connection.exec("ROLLBACK");
      throw error;
    }
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
