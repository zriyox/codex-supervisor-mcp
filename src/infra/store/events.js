import { branchOf } from "../../domain/worker-branch.js";
import { ensureControlRecords, ensureFilesystem, openDb, runIdFor, runWithRetry, workItemIdForTask } from "./db.js";
import { storedForm } from "./event-body.js";
import { extractAgentMessage } from "./runner-readers.js";

export async function ensureRunRecord(task, attempt) {
  await ensureFilesystem();
  if (!task?.id || !Number.isInteger(attempt) || attempt < 1) throw new Error("run record requires a task and positive attempt");
  const dbInstance = openDb();
  return runWithRetry(dbInstance, () => {
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
      branch: task.worktree_path ? branchOf(task) : null,
      base_sha: task.base_commit ?? null,
      started_at: now
    });
    return id;
  });
}

export async function completeRunRecord(task, attempt) {
  await ensureFilesystem();
  if (!task?.id || !Number.isInteger(attempt) || attempt < 1) return;
  const now = task.completed_at ?? new Date().toISOString();
  const dbInstance = openDb();
  runWithRetry(dbInstance, () => dbInstance.prepare(`
    UPDATE runs SET codex_thread_id = @codex_thread_id,
      run_status = @run_status, finished_at = @finished_at
    WHERE task_id = @task_id AND attempt = @attempt
  `).run({
    task_id: task.id,
    attempt,
    codex_thread_id: task.thread_id ?? null,
    run_status: task.status ?? "unknown",
    finished_at: now
  }));
}

// bodyInLog: the caller has written each event to the run log, so a large one
// need not be kept whole here as well.
export async function appendTaskEvents(taskId, events, { runId = null, actor = "supervisor", bodyInLog = false } = {}) {
  await ensureFilesystem();
  if (!Array.isArray(events) || events.length === 0) return [];
  const dbInstance = openDb();
  return runWithRetry(dbInstance, () => {
    dbInstance.exec("BEGIN IMMEDIATE");
    try {
      const nextSeqRow = dbInstance.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM task_events WHERE task_id = ?").get(taskId);
      const insert = dbInstance.prepare(`
    INSERT INTO task_events (task_id, run_id, seq, created_at, actor, event_type, payload, payload_sha256)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const createdAt = new Date().toISOString();
      const records = events.map((event, index) => {
        const stored = storedForm(event, { bodyInLog });
        const result = insert.run(taskId, runId, nextSeqRow.seq + index, createdAt, actor, event.type ?? "unknown", stored.payload, stored.sha256);
        return { id: Number(result.lastInsertRowid), run_id: runId, actor };
      });
      dbInstance.exec("COMMIT");
      return records;
    } catch (error) {
      dbInstance.exec("ROLLBACK");
      throw error;
    }
  });
}

export async function appendTaskEvent(taskId, event, options = {}) {
  return (await appendTaskEvents(taskId, [event], options))[0];
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
    let text;
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
