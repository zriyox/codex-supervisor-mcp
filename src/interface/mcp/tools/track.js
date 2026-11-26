import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sweepCleanup } from "../../../app/auto-cleanup.js";
import { recoverEligibleRuns } from "../../../app/resume.js";
import { ACTIVE_STATUSES, TASK_STATUSES } from "../../../domain/status.js";
import { collectWorkerChanges } from "../../../domain/worker-changes.js";
import { cleanupHint } from "../../../infra/cleanup-hint.js";
import { reconcileDetachedActiveTasks } from "../../../infra/store/reconcile.js";
import { readObserverCursor, readTasks, writeObserverCursor } from "../../../infra/store/tasks.js";
import { waitCodexWorkersOp } from "../handlers/wait.js";
import { packageVersion } from "../meta.js";
import { updateField, updateState } from "../update-state.js";
import { buildOverview } from "../views/overview.js";
import { defineTool, run } from "./run.js";

// Polls from one process run one at a time: recovery and cleanup must not overlap themselves.
let pollChain = Promise.resolve();

// With a cursor this is the loop tick: it reports what changed and does the
// housekeeping a loop is for (one recovery of a dead first run, cleanup).
// Without one it is a plain read of the table and starts nothing.
async function pollOnce({ cursor, status, limit }) {
  await reconcileDetachedActiveTasks();
  if (cursor) {
    const recoveries = await recoverEligibleRuns();
    const cleaned = await sweepCleanup();
    const cleanup = await cleanupHint();
    const tasks = await readTasks();
    const changes = collectWorkerChanges(tasks, await readObserverCursor(cursor));
    await writeObserverCursor(cursor, changes.cursor);
    return {
      generated_at: new Date().toISOString(),
      quiet: changes.quiet && recoveries.length === 0 && cleaned.length === 0,
      active: tasks.filter((task) => ACTIVE_STATUSES.has(task.status)).length,
      transitions: changes.transitions,
      attention: changes.attention,
      recoveries,
      ...(cleaned.length ? { cleaned } : {}),
      ...(cleanup ? { cleanup } : {}),
      next_cursor: cursor
    };
  }
  const tasks = await readTasks();
  // The cursor handed out here makes the next poll report only what changes from now on.
  const token = `poll-${randomUUID().slice(0, 12)}`;
  await writeObserverCursor(token, collectWorkerChanges(tasks, {}).cursor);
  const shown = (status ? tasks.filter((task) => task.status === status) : tasks).slice(-limit);
  const update = updateField() ?? { update_available: false, installed_version: packageVersion, checked: updateState?.source ?? "pending" };
  return buildOverview(shown, { version: packageVersion, update, next_cursor: token });
}

export const pollWorkersTool = defineTool("poll_workers", {
  title: "See what the workers are doing",
  description: "The main thread's read. Without cursor: a compact table of every worker and a next_cursor. With that cursor: only what happened since, as transitions (finished, failed, needs attention) with the next step; quiet when nothing did. A poll with a cursor also recovers a dead first run once and removes safe worktrees (listed under cleaned). Call it from a loop.",
  inputSchema: {
    cursor: z.string().optional().describe("next_cursor from the previous poll"),
    status: z.enum(TASK_STATUSES).optional().describe("Filter the full table"),
    limit: z.number().int().min(1).max(200).default(50).describe("Rows in the full table, newest last")
  }
}, (args) => {
  const poll = pollChain.then(() => pollOnce(args));
  pollChain = poll.catch(() => {});
  return poll;
});

export const waitWorkersTool = defineTool("wait_workers", {
  title: "Wait for workers to finish",
  description: "Block until the given workers settle (process exited and acceptance run), then return one row each. A call waits 60 seconds at most and says so in timed_out; call again with the same ids. allow_long_wait lifts the cap only when the client's own tool timeout is known to be longer.",
  inputSchema: {
    task_ids: z.array(z.string()).min(1),
    mode: z.enum(["any", "all"]).default("all"),
    timeout_ms: z.number().int().min(1000).max(21600000).optional(),
    allow_long_wait: z.boolean().default(false),
    emit_progress: z.boolean().default(false).describe("Send progress notifications while waiting"),
    compact: z.boolean().optional().describe("One short row per worker; the default unless include_events"),
    include_events: z.boolean().default(false),
    event_limit: z.number().int().min(1).max(50).default(10),
    poll_ms: z.number().int().min(250).max(10000).optional()
  }
}, (args, extra) => run(waitCodexWorkersOp, {
  task_ids: args.task_ids, mode: args.mode, timeoutMs: args.timeout_ms ?? 60000, allowLongWait: args.allow_long_wait, emitProgress: args.emit_progress,
  compact: args.compact, includeEvents: args.include_events, eventLimit: args.event_limit,
  pollMs: args.poll_ms
}, extra));
