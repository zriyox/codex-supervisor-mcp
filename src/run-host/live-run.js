// The state of one run while its worker is alive, and the single serialized
// write path that keeps the task row in step with it. Every write goes through
// one chain so concurrent stdout/stderr callbacks cannot persist out of order.
import { terminateChild } from "../app/cancel.js";
import { runnerOf } from "../runners/registry.js";
import { runIdFor } from "../infra/store/db.js";
import { appendTaskEvent } from "../infra/store/events.js";
import { upsertTask } from "../infra/store/tasks.js";

// A new run starts clean. A resumed worker used to carry the error from the
// run that was lost, so a worker that was plainly running still showed
// "process disappeared" until it finished.
export function startingRow(record, child, outputSchema, now) {
  return {
    ...record,
    status: "running",
    phase: "starting",
    pid: child.pid ?? null,
    run_host_pid: process.pid,
    started_at: now,
    completed_at: null,
    exit_code: null,
    signal: null,
    error: null,
    // What an earlier run wrote to stderr says nothing about how this one ends.
    stderr_tail: null,
    cancel_requested_at: null,
    acceptance_results: null,
    attention_reason: null,
    run_evidence: null,
    guard_policy: { ...record.guard_policy, output_schema: outputSchema },
    commands: [],
    last_message: null,
    current_action: null,
    current_command: null,
    // A resumed row still carries the last event of the run that ended;
    // idle time for this run counts from now.
    last_event_at: now,
    last_event_type: null,
    run_count: (record.run_count ?? 0) + 1,
    updated_at: now
  };
}

// Stops the worker when its per-run or total time budget runs out.
export function watchQuota(run, now) {
  const maxRunMs = run.record.guard_policy?.maxRunMs;
  const maxTotalMs = run.record.guard_policy?.maxTotalMs;
  if (!maxRunMs && !maxTotalMs) return null;
  return setInterval(() => {
    if (run.quotaReason) return;
    if (maxRunMs && Date.now() - Date.parse(now) >= maxRunMs) run.quotaReason = "run_time_limit";
    else if (maxTotalMs && Date.now() - Date.parse(run.record.created_at) >= maxTotalMs) run.quotaReason = "total_time_limit";
    if (run.quotaReason) terminateChild(run.child, runnerOf(run.record));
  }, 250);
}

function writeSnapshot(run, next) {
  run.live = next;
  const snapshot = run.live;
  const pending = run.writeChain.then(() => upsertTask(snapshot));
  // Keep later writes usable after one failed snapshot. Callers that need
  // failure visibility use the returned promise explicitly.
  run.writeChain = pending.catch(() => {});
  return pending;
}

export async function persist(run, next, label = "persist") {
  try {
    await writeSnapshot(run, next);
  } catch (error) {
    await appendTaskEvent(next.id, { type: "supervisor.persist_failed", label, error: error.message, run: next.run_count },
      { runId: runIdFor(next.id, next.run_count), actor: "supervisor" }).catch(() => null);
    process.stderr.write(`[codex-supervisor] ${label} failed for ${next.id}: ${error.message}\n`);
  }
}
