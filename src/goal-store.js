// Read-only view of Codex's own thread goals.
//
// Codex stores goals in $CODEX_HOME/goals_1.sqlite (table thread_goals). The
// supervisor never writes there: Codex owns that file. When a worker thread
// has a native goal we surface it; when it does not, the supervisor falls back
// to the goal it recorded at dispatch time.
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { goalsDbPath } from "./paths.js";
import { mapGoalStatus } from "./status.js";

function toCamelCase(status) {
  return String(status).replace(/_([a-z])/g, (_match, letter) => letter.toUpperCase());
}

export function readNativeGoal(threadId) {
  if (!threadId || !existsSync(goalsDbPath)) return null;
  let db;
  try {
    db = new DatabaseSync(goalsDbPath, { readOnly: true });
    db.exec("PRAGMA busy_timeout=2000;");
    const row = db.prepare(`
      SELECT goal_id, objective, status, token_budget, tokens_used,
             time_used_seconds, created_at_ms, updated_at_ms
      FROM thread_goals
      WHERE thread_id = ?
    `).get(threadId);
    if (!row) return null;
    return {
      objective: row.objective,
      status: toCamelCase(row.status),
      storage_status: row.status,
      work_status: mapGoalStatus(row.status),
      token_budget: row.token_budget ?? null,
      tokens_used: row.tokens_used ?? 0,
      time_used_seconds: row.time_used_seconds ?? 0,
      created_at: row.created_at_ms ? new Date(row.created_at_ms).toISOString() : null,
      updated_at: row.updated_at_ms ? new Date(row.updated_at_ms).toISOString() : null
    };
  } catch {
    // A locked or half-migrated Codex database must never break a supervisor
    // call; the supervisor goal is still returned by the caller.
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
  }
}
