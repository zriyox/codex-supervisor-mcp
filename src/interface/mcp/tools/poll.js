import { createCleanupPlan } from "../../../app/cleanup-plan.js";
import { recoverEligibleRuns } from "../../../app/resume.js";
import { buildOverviewDelta } from "../../../domain/overview-delta.js";
import { collectWorkerChanges } from "../../../domain/worker-changes.js";
import { cleanupHint } from "../../../infra/cleanup-hint.js";
import { readObserverCursor, readTasks, writeObserverCursor } from "../../../infra/store/tasks.js";
import { reconcileDetachedActiveTasks } from "../../../infra/store/reconcile.js";
import { textResult } from "../result.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const observerId = process.env.CODEX_SUPERVISOR_OBSERVER_ID?.trim() || `mcp-${randomUUID()}`;
const deltaObserverId = process.env.CODEX_SUPERVISOR_DELTA_OBSERVER_ID?.trim() || `${observerId}:delta`;
let observerRead = Promise.resolve();
let deltaRead = Promise.resolve();
export const overviewDeltaTool = [
  "overview_delta",
  {
    title: "Get orchestration delta",
    description: "Return a small cursor-based orchestration view: active, needs_attention, ready_to_land, ready_to_clean and changed task summaries. It never returns full history, prompts, diffs, events or worker capsules.",
    inputSchema: { cursor: z.record(z.string(), z.string()).optional() }
  },
  async ({ cursor }) => {
    const read = deltaRead.then(async () => {
      await reconcileDetachedActiveTasks();
      const tasks = await readTasks();
      const previous = cursor ?? await readObserverCursor(deltaObserverId);
      const candidateIds = tasks.filter((task) => task.delivery_state === "cleanup_eligible").map((task) => task.id);
      const cleanupReadiness = candidateIds.length > 0
        ? await createCleanupPlan({ taskIds: candidateIds, revalidateRemote: false })
        : null;
      const readyToCleanTaskIds = cleanupReadiness
        ? new Set(cleanupReadiness.items.filter((item) => item.verdict === "safe").map((item) => item.task_id))
        : new Set();
      const result = buildOverviewDelta(tasks, previous, { readyToCleanTaskIds });
      await writeObserverCursor(deltaObserverId, result.cursor);
      const { cursor: nextCursor, ...reply } = result;
      return textResult({ ...reply, next_cursor: nextCursor });
    });
    deltaRead = read.catch(() => {});
    return read;
  }
];
export const checkWorkersTool = ["check_workers", {
  title: "Check changed workers",
  description: "Check newly settled runs, actionable failures and active threads crossing the handoff threshold; automatically resume a dead lost/no_work first run once, except approval, authentication, permission and quota waits. Handoff reminders occur once per run and never cancel, replace or resume a live worker. Unchanged state is quiet. Call from a host-scheduled loop; it cannot wake a closed host. Set a distinct CODEX_SUPERVISOR_OBSERVER_ID per main thread to retain its cursor across restarts.",
  inputSchema: {}
}, async () => {
  const read = observerRead.then(async () => {
    await reconcileDetachedActiveTasks();
    const recoveries = await recoverEligibleRuns();
    const result = collectWorkerChanges(await readTasks(), await readObserverCursor(observerId));
    await writeObserverCursor(observerId, result.cursor);
    const { cursor, ...reply } = result;
    // The cleanup hint rides along without touching quiet: it is a standing fact
    // about the store, not a new worker event.
    const cleanup = await cleanupHint();
    return textResult({ ...reply, quiet: reply.quiet && recoveries.length === 0, recoveries, ...(cleanup ? { cleanup } : {}) });
  });
  observerRead = read.catch(() => {});
  return read;
}];
