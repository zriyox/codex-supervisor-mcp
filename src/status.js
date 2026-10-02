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
  return key === "blocked" || key === "paused";
}
