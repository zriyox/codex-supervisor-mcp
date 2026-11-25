import { normalizeAcceptance } from "../../domain/acceptance-spec.js";
import { decodeJson, ensureFilesystem, openDb, runWithRetry } from "./db.js";

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
