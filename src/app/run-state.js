
export const processes = new Map();
// taskId -> control object of an acceptance run in progress ({ kill, cancelled }).
export const acceptanceRuns = new Map();
export const cancelledTasks = new Set();
export const allowedReasoningEfforts = new Set(["minimal", "low", "medium", "high"]);
export const MAX_RUN_HOST_PROMPT_BYTES = 4 * 1024 * 1024;
export const RUN_HOST_STARTUP_TIMEOUT_MS = process.platform === "win32" ? 120000 : 30000;
export const WORKTREE_LOCK_TIMEOUT_MS = 120000;

export function failedStart(record, reason) {
  const now = new Date().toISOString();
  return {
    ok: false,
    record: {
      ...record,
      status: "failed",
      phase: null,
      pid: null,
      error: reason,
      attention_reason: "start_failed",
      completed_at: now,
      updated_at: now
    }
  };
}
