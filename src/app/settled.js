import "./compose.js";
import { readPreflightResult } from "../domain/worker-preflight.js";
import { TERMINAL_STATUSES } from "../domain/status.js";
import { isPidAlive } from "../infra/store/tasks.js";

// A terminal status is written in two steps. Codex's turn.completed event
// flips status to completed while the process is still alive and exit_code is
// still null; the process exit then writes exit_code. A wait that returned on
// the first step handed the caller a snapshot with exit_code: null, and the
// next read said 0 - two answers for one worker. A row counts as settled once
// the exit is recorded, or once nobody is left to record it.
export function isSettled(task) {
  if (!TERMINAL_STATUSES.has(task.status)) return false;
  if (task.attention_reason === "start_failed") return true;
  if (task.guard_policy?.preflight && readPreflightResult(task).status === "passed") return true;
  if (task.status !== "completed" && task.status !== "failed") return true;
  // Acceptance is running in the supervisor process that owned the worker;
  // the codex pid is already dead, so that process is what to wait on.
  if (task.acceptance_results?.status === "running") return !isPidAlive(task.acceptance_results.supervisor_pid);
  if (["interrupted", "cancelled"].includes(task.acceptance_results?.status)) {
    return task.exit_code !== null && task.exit_code !== undefined;
  }
  if (task.exit_code !== null && task.exit_code !== undefined) return true;
  // A dead Codex pid does not prove that its owner's close handler finished
  // draining the stream and writing the exit status. Leave the half-written
  // row for reconciliation after a short grace period, never return it.
  return false;
}
