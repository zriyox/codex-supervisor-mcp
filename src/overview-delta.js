import { ACTIVE_STATUSES, isGoalNeedingAttention } from "./status.js";

function readyToLand(task) {
  return task.status === "completed" && task.exit_code === 0 && (!task.acceptance_results || task.acceptance_results.passed === true) && !task.landed_at;
}

function readyToClean(task) {
  return task.push_verified_at && ["cleanup_eligible"].includes(task.delivery_state);
}

export function buildOverviewDelta(tasks, cursor = {}) {
  const active = tasks.filter((task) => ACTIVE_STATUSES.has(task.status));
  const attention = tasks.filter((task) => isGoalNeedingAttention(task.goal_status) || task.attention_reason || task.acceptance_results?.passed === false);
  const land = tasks.filter(readyToLand);
  const clean = tasks.filter(readyToClean);
  const nextCursor = {};
  const changes = [];
  for (const task of tasks) {
    const fingerprint = JSON.stringify([task.run_count ?? 0, task.status, task.exit_code ?? null, task.attention_reason ?? null, task.landed_head ?? null, task.push_verified_at ?? null, task.delivery_state ?? null, task.updated_at]);
    nextCursor[task.id] = fingerprint;
    if (cursor[task.id] !== fingerprint) {
      changes.push({ id: task.id, title: task.title ?? task.id, status: task.status, delivery_state: task.delivery_state ?? "draft", attention: attention.some((item) => item.id === task.id), ready_to_land: land.some((item) => item.id === task.id), ready_to_clean: clean.some((item) => item.id === task.id), updated_at: task.updated_at });
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
