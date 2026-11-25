import { acceptanceVerdict } from "../../../app/acceptance.js";
import { ACTIVE_STATUSES } from "../../../domain/status.js";
import { truncateEventStrings } from "../../../domain/truncate.js";
import { getTasks, readTaskEvents, reconcileDetachedActiveTasks } from "../../../infra/store/task-store.js";
import { readTaskChanges } from "../../../infra/worktree.js";
import { clip, sleep, textResult } from "../result.js";
import { withUpdate } from "../update-state.js";
import { isSettled } from "../../../app/settled.js";
import { compactLiveness, summarizeTask } from "../views/task.js";
import { z } from "zod";

export const waitCodexWorkersTool = [
  "wait_codex_workers",
  {
    title: "Wait for Codex workers",
    description:
      "Block until selected Codex workers reach a terminal status, then return summaries. Each call is capped at 60 seconds unless allowLongWait is explicitly true and the caller has verified its MCP timeout supports the requested budget. A spent wait budget returns a snapshot while workers continue; reuse the same task_ids or schedule check_workers for longer monitoring. compact: true returns one line per worker with status, phase, exit_code, changed_file_count, acceptance and liveness. command_running means a command may still be working despite a long idle interval.",
    inputSchema: {
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
      // get_codex_worker_events for one worker.
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
      // get_worker_result / get_worker_diff afterwards.
      compact: z.boolean().optional()
    }
  },
  async ({
    task_ids,
    mode,
    timeoutMinutes,
    timeoutMs,
    allowLongWait,
    pollMs,
    emitProgress,
    includeEvents,
    eventLimit,
    eventMaxChars,
    eventKinds,
    compact: requestedCompact
  }, extra) => {
    const compact = requestedCompact ?? !includeEvents;
    const startedAt = Date.now();
    const requestedTimeoutMs = timeoutMs ?? timeoutMinutes * 60 * 1000;
    const effectiveTimeoutMs = allowLongWait ? requestedTimeoutMs : Math.min(requestedTimeoutMs, 60000);
    let tasks = [];
    const progressToken = extra?._meta?.progressToken;
    let lastProgressAt = -Infinity;

    let clientCancelled = false;
    while (Date.now() - startedAt < effectiveTimeoutMs) {
      if (extra?.signal.aborted) { clientCancelled = true; break; }
      await reconcileDetachedActiveTasks();
      tasks = (await getTasks(task_ids)).filter(Boolean);
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

    await reconcileDetachedActiveTasks();
    tasks = (await getTasks(task_ids)).filter(Boolean);
    const missingIds = task_ids.filter((taskId) => !tasks.some((task) => task.id === taskId));
    const settledTasks = tasks.filter(isSettled);
    const timedOut =
      mode === "any" ? settledTasks.length === 0 : settledTasks.length !== task_ids.length;

    const summaries = await Promise.all(
      tasks.map(async (task) => ({
        ...summarizeTask(task),
        recent_events: includeEvents
          ? await readTaskEvents(task.id, eventLimit, eventKinds ?? null).then((events) =>
              eventMaxChars === undefined ? events : events.map((event) => truncateEventStrings(event, eventMaxChars))
            )
          : undefined
      }))
    );

    const budgetLabel =
      effectiveTimeoutMs >= 60000
        ? `${Math.round(effectiveTimeoutMs / 60000)}-minute`
        : `${Math.round(effectiveTimeoutMs / 1000)}-second`;

    return textResult(withUpdate({
      mode,
      timed_out: timedOut,
      still_running: timedOut,
      termination_reason: clientCancelled ? "client_cancelled" : timedOut ? "budget_exhausted" : "settled",
      next_step: timedOut
        ? `Workers are still running; the ${budgetLabel} wait budget ran out. Reuse the same task_ids for a short wait, or schedule check_workers for long monitoring. Set allowLongWait only after verifying the client's MCP timeout supports the requested budget; do not start another long wait while a background wait is active.`
        : null,
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
      active_count: tasks.filter((task) => ACTIVE_STATUSES.has(task.status)).length,
      acceptance_failed_count: tasks.filter((task) => task.acceptance_results?.passed === false).length,
      workers: compact
        ? tasks.map((task) => ({
            id: task.id,
            title: clip(task.title, 60),
            status: task.status,
            phase: task.phase ?? null,
            exit_code: task.exit_code ?? null,
            changed_file_count: readTaskChanges(task).length,
            acceptance: acceptanceVerdict(task),
            ...compactLiveness(task),
            updated_at: task.updated_at ?? null
          }))
        : summaries
    }));
  }
];
