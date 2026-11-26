// Single source of truth for the work state machine.
//
// status  = lifecycle. One value per work, never overwritten by progress.
// phase   = what the worker is doing right now. Only meaningful while
//           status === "running"; NULL once the work reaches a terminal status.

export const TASK_STATUSES = ["queued", "running", "completed", "failed", "cancelled", "lost"];

export const PHASES = ["starting", "thinking", "command", "editing", "reporting"];

export const ACTIVE_STATUSES = new Set(["queued", "running"]);

export const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "lost"]);

// Codex native thread goal status -> work status.
// Storage uses snake_case ("usage_limited"); the RPC layer uses camelCase
// ("usageLimited"). mapGoalStatus accepts either.
const GOAL_STATUS_MAP = new Map([
  ["active", "running"],
  ["paused", "running"],
  ["blocked", "running"],
  ["usagelimited", "failed"],
  ["budgetlimited", "failed"],
  ["complete", "completed"]
]);

export function mapGoalStatus(nativeStatus) {
  if (!nativeStatus) return null;
  const key = String(nativeStatus).replace(/_/g, "").toLowerCase();
  return GOAL_STATUS_MAP.get(key) ?? null;
}

// A goal that is not finished but is not progressing on its own.
export function isGoalNeedingAttention(nativeStatus) {
  const key = String(nativeStatus ?? "").replace(/_/g, "").toLowerCase();
  return ["blocked", "paused", "usagelimited", "budgetlimited"].includes(key);
}

// True once nothing of a worker's last run can still be running: its exit
// code is recorded (the last thing a run host writes), or the row was marked
// lost (done only after both processes were seen gone). From then on the pids
// on the row are history. The system hands them to other processes, on
// Windows within seconds, and a live stranger must not read as a live worker.
export function runIsOver(task) {
  return task.status === "lost" || (TERMINAL_STATUSES.has(task.status) && task.exit_code != null);
}
