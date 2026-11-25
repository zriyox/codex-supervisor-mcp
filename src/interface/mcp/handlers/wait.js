import { acceptanceVerdict } from "../../../app/acceptance.js";
import { ACTIVE_STATUSES } from "../../../domain/status.js";
import { truncateEventStrings } from "../../../domain/truncate.js";
import { getTasks } from "../../../infra/store/tasks.js";
import { readTaskEvents } from "../../../infra/store/events.js";
import { reconcileDetachedActiveTasks } from "../../../infra/store/reconcile.js";
import { readTaskChanges } from "../../../infra/worktree.js";
import { clip, sleep, textResult } from "../result.js";
import { withUpdate } from "../update-state.js";
import { isSettled } from "../../../app/settled.js";
import { compactLiveness, summarizeTask } from "../views/task.js";
import { z } from "zod";

// Polls until the selected workers settle, the budget runs out or the client
// cancels. Returns whether the client cancelled.
async function pollUntilSettled({ task_ids, mode, pollMs, emitProgress }, { startedAt, effectiveTimeoutMs }, extra) {
  const progressToken = extra?._meta?.progressToken;
  let lastProgressAt = -Infinity;
  while (Date.now() - startedAt < effectiveTimeoutMs) {
    if (extra?.signal.aborted) return true;
    await reconcileDetachedActiveTasks();
    const tasks = (await getTasks(task_ids)).filter(Boolean);
    const settledCount = tasks.filter(isSettled).length;
    const isDone = mode === "any" ? settledCount > 0 : settledCount === task_ids.length;
    if (isDone) break;
    const elapsed = Date.now() - startedAt;
    if (emitProgress && progressToken != null && elapsed - lastProgressAt >= 30000) {
      await extra.sendNotification({ method: "notifications/progress", params: {
        progressToken, progress: elapsed, total: effectiveTimeoutMs,
        message: `${settledCount}/${task_ids.length} workers settled; wait budget only`
      } }).catch(() => {});
      lastProgressAt = elapsed;
    }
    await sleep(Math.min(pollMs, Math.max(0, effectiveTimeoutMs - (Date.now() - startedAt))));
  }
  return false;
}

function budgetExhaustedHint(effectiveTimeoutMs) {
  const budgetLabel =
    effectiveTimeoutMs >= 60000
      ? `${Math.round(effectiveTimeoutMs / 60000)}-minute`
      : `${Math.round(effectiveTimeoutMs / 1000)}-second`;
  return `Workers are still running; the ${budgetLabel} wait budget ran out. Reuse the same task_ids for a short wait, or schedule poll_workers for long monitoring. Set allow_long_wait only after verifying the client's MCP timeout supports the requested budget; do not start another long wait while a background wait is active.`;
}

function compactWorkerRow(task) {
  return {
    id: task.id,
    title: clip(task.title, 60),
    status: task.status,
    phase: task.phase ?? null,
    exit_code: task.exit_code ?? null,
    changed_file_count: readTaskChanges(task).length,
    acceptance: acceptanceVerdict(task),
    ...compactLiveness(task),
    updated_at: task.updated_at ?? null
  };
}

function fullWorkerRows(tasks, { includeEvents, eventLimit, eventMaxChars, eventKinds }) {
  return Promise.all(
    tasks.map(async (task) => ({
      ...summarizeTask(task),
      recent_events: includeEvents
        ? await readTaskEvents(task.id, eventLimit, eventKinds ?? null).then((events) =>
            eventMaxChars === undefined ? events : events.map((event) => truncateEventStrings(event, eventMaxChars))
          )
        : undefined
    }))
  );
}

async function waitForWorkers(input, extra) {
  const { task_ids, mode, timeoutMinutes, timeoutMs, allowLongWait, includeEvents, compact: requestedCompact } = input;
  const compact = requestedCompact ?? !includeEvents;
  const startedAt = Date.now();
  const requestedTimeoutMs = timeoutMs ?? timeoutMinutes * 60 * 1000;
  const effectiveTimeoutMs = allowLongWait ? requestedTimeoutMs : Math.min(requestedTimeoutMs, 60000);
  const clientCancelled = await pollUntilSettled(input, { startedAt, effectiveTimeoutMs }, extra);

  await reconcileDetachedActiveTasks();
  const tasks = (await getTasks(task_ids)).filter(Boolean);
  const missingIds = task_ids.filter((taskId) => !tasks.some((task) => task.id === taskId));
  const settledTasks = tasks.filter(isSettled);
  const timedOut =
    mode === "any" ? settledTasks.length === 0 : settledTasks.length !== task_ids.length;
  const summaries = await fullWorkerRows(tasks, input);

  return textResult(withUpdate({
    mode,
    timed_out: timedOut,
    still_running: timedOut,
    termination_reason: clientCancelled ? "client_cancelled" : timedOut ? "budget_exhausted" : "settled",
    next_step: timedOut ? budgetExhaustedHint(effectiveTimeoutMs) : null,
    waited_ms: Date.now() - startedAt,
    timeout_ms: effectiveTimeoutMs,
    requested_timeout_ms: requestedTimeoutMs,
    timeout_capped: effectiveTimeoutMs !== requestedTimeoutMs,
    timeout_minutes: Math.round(effectiveTimeoutMs / 60000),
    missing_ids: missingIds,
    completed_count: tasks.filter((task) => task.status === "completed").length,
    failed_count: tasks.filter((task) => task.status === "failed").length,
    cancelled_count: tasks.filter((task) => task.status === "cancelled").length,
    lost_count: tasks.filter((task) => task.status === "lost").length,
    timed_out_count: tasks.filter((task) => task.status === "timed_out").length,
    active_count: tasks.filter((task) => ACTIVE_STATUSES.has(task.status)).length,
    acceptance_failed_count: tasks.filter((task) => task.acceptance_results?.passed === false).length,
    workers: compact ? tasks.map(compactWorkerRow) : summaries
  }));
}

export const waitCodexWorkersOp = {
  input: z.object({
      task_ids: z.array(z.string().min(1)).min(1),
      mode: z.enum(["any", "all"]).default("all"),
      timeoutMinutes: z.number().int().min(1).max(360).default(1),
      timeoutMs: z.number().int().min(1000).max(21600000).optional(),
      allowLongWait: z.boolean().default(false),
      pollMs: z.number().int().min(250).max(10000).default(1000),
      emitProgress: z.boolean().default(false),
      // Off by default. A wait is the call clients background and then replay
      // as a notification, so its payload has to stay small; ten events per
      // worker was the bulk of it. Ask for events explicitly, or read
      // get_worker (include events) for one worker.
      includeEvents: z.boolean().default(false),
      eventLimit: z.number().int().min(1).max(50).default(10),
      // Events used to come back whole: one command event can carry a heredoc
      // that is tens of KB, and ten of those made a single wait response
      // unreadable. The default bounds each string; pass a bigger number when
      // you actually want the raw text.
      eventMaxChars: z.number().int().min(0).max(1000000).default(800),
      eventKinds: z.array(z.string().min(1)).optional(),
      // The smallest useful answer: one line per worker, for a caller that
      // only wants to know who is done. Everything else comes from
      // get_worker (include result) / get_worker_diff afterwards.
      compact: z.boolean().optional()
    }),
  handler: waitForWorkers
};
