import { TERMINAL_STATUSES, isGoalNeedingAttention } from "./status.js";

// Cursors belong to observers, not workers. A resumed run gets a new receipt;
// old acceptance cannot produce a current-run completion or failure notice.
export function collectWorkerChanges(tasks, cursor = {}) {
  const next = {};
  const transitions = [];
  const attention = [];
  for (const task of tasks) {
    const acceptance = task.acceptance_results?.run === task.run_count ? task.acceptance_results : null;
    let reason = null;
    if (isGoalNeedingAttention(task.goal_status)) reason = `goal_${task.goal_status}`;
    else if (task.attention_reason) reason = task.attention_reason;
    else if (acceptance?.passed === false) reason = "acceptance_failed";
    else if (["interrupted", "cancelled"].includes(acceptance?.status)) reason = `acceptance_${acceptance.status}`;
    else if (TERMINAL_STATUSES.has(task.status) && acceptance?.status !== "running" &&
      (!["completed", "failed"].includes(task.status) || task.exit_code != null)) reason = task.status;
    if (!reason) {
      if (cursor[task.id]) next[task.id] = cursor[task.id];
      continue;
    }
    const fingerprint = JSON.stringify([task.run_count, reason, task.goal_status, acceptance?.status, task.landed_head]);
    next[task.id] = fingerprint;
    if (cursor[task.id] === fingerprint) continue;
    const needsAttention = !["completed", "cancelled"].includes(reason);
    const receipt = {
      id: task.id, title: task.title ?? task.id, run: task.run_count, status: task.status,
      reason, next_step: {
        tool: needsAttention ? "get_worker_result" : "get_worker_diff",
        arguments: { task_id: task.id },
        instruction: needsAttention ? "Read the failure or goal evidence before deciding whether to resume; user approval waits must not auto-resume." : "Read the result and diff, then decide whether to land. Completion is not proof of correctness."
      }
    };
    transitions.push(receipt);
    if (needsAttention) attention.push(receipt);
  }
  return { quiet: transitions.length === 0, transitions, attention, cursor: next };
}
