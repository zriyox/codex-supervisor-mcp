import { ACTIVE_STATUSES, isGoalNeedingAttention } from "./status.js";
import { classifyFailure } from "./failure-class.js";

function readyToLand(task) {
  return task.status === "completed" && task.exit_code === 0 && (!task.acceptance_results || task.acceptance_results.passed === true) && !task.landed_at;
}

function readyToClean(task, readyToCleanTaskIds = null) {
  if (readyToCleanTaskIds) return readyToCleanTaskIds.has(task.id);
  return task.push_verified_at && ["cleanup_eligible"].includes(task.delivery_state);
}

function attentionReason(task) {
  if (task.attention_reason) return String(task.attention_reason).slice(0, 180);
  if (task.acceptance_results?.passed === false) return "acceptance_failed";
  if (isGoalNeedingAttention(task.goal_status)) return `goal_${task.goal_status}`;
  return null;
}

function nextAction(task, { attention, readyToLand, readyToClean }) {
  if (attention) return "inspect the worker evidence and resolve the recorded blocker";
  if (task.delivery_state === "cleanup_eligible" && !readyToClean) return "rerun cleanup_plan; the previous cleanup proof is no longer current";
  if (readyToLand) return "review the diff and acceptance, then land the worker";
  if (readyToClean) return "review the cleanup plan item, then explicitly apply it";
  if (task.status === "completed" && !task.landed_at) return "review the worker result and decide whether to land it";
  return null;
}

export function buildOverviewDelta(tasks, cursor = {}, { readyToCleanTaskIds = null } = {}) {
  const active = tasks.filter((task) => ACTIVE_STATUSES.has(task.status));
  const attention = tasks.filter((task) => isGoalNeedingAttention(task.goal_status) || task.attention_reason || task.acceptance_results?.passed === false);
  const land = tasks.filter(readyToLand);
  const clean = tasks.filter((task) => readyToClean(task, readyToCleanTaskIds));
  const nextCursor = {};
  const changes = [];
  for (const task of tasks) {
    const isAttention = attention.some((item) => item.id === task.id);
    const isReadyToLand = land.some((item) => item.id === task.id);
    const isReadyToClean = clean.some((item) => item.id === task.id);
    const reason = attentionReason(task);
    const failure = classifyFailure(task);
    const fingerprint = JSON.stringify([task.run_count ?? 0, task.status, task.exit_code ?? null, task.attention_reason ?? null, task.landed_head ?? null, task.push_verified_at ?? null, task.delivery_state ?? null, isReadyToClean, reason, task.updated_at]);
    nextCursor[task.id] = fingerprint;
    if (cursor[task.id] !== fingerprint) {
      changes.push({
        id: task.id,
        title: task.title ?? task.id,
        status: task.status,
        delivery_state: task.delivery_state ?? "draft",
        attention: isAttention,
        attention_reason: reason,
        failure_source: failure?.source ?? null,
        failure_code: failure?.code ?? null,
        ready_to_land: isReadyToLand,
        ready_to_clean: isReadyToClean,
        next_action: nextAction(task, { attention: isAttention, readyToLand: isReadyToLand, readyToClean: isReadyToClean }),
        updated_at: task.updated_at
      });
    }
  }
  return {
    generated_at: new Date().toISOString(),
    active: active.length,
    needs_attention: attention.length,
    ready_to_land: land.length,
    ready_to_clean: clean.length,
    changes,
    cursor: nextCursor
  };
}
