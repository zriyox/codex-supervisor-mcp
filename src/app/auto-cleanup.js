// Removes safe worktrees and expired scratch directories without being asked.
// It rides on the polling tools, so a batch that is never cleaned up by hand
// does not grow without bound. A sweep is throttled and bounded: it must never
// make a poll slow.
import "./compose.js";
import { holdMsFrom } from "../domain/cleanup-policy.js";
import { TERMINAL_STATUSES } from "../domain/status.js";
import { scratchDir } from "../infra/paths.js";
import { runIdFor } from "../infra/store/db.js";
import { appendTaskEvent } from "../infra/store/events.js";
import { claimIdleTask, readTasks, releaseTaskRun } from "../infra/store/tasks.js";
import { assessWorktree, recordRemoval, removeSafeWorktree } from "./cleanup-plan.js";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;
const SWEEP_LIMIT = 20;
let lastSweepAt = 0;

function intervalMs() {
  const raw = Number(process.env.CODEX_SUPERVISOR_CLEANUP_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= 0 && process.env.CODEX_SUPERVISOR_CLEANUP_INTERVAL_MS !== undefined ? raw : DEFAULT_INTERVAL_MS;
}

const finishedAt = (task) => Date.parse(task.completed_at ?? task.updated_at ?? "") || 0;

async function sweepWorktree(task, tasks, now) {
  const assessed = await assessWorktree(task, tasks, now);
  if (assessed.verdict !== "safe") return null;
  const checkpoint = await removeSafeWorktree(task, assessed.fingerprint);
  // The worktree is gone whether or not the audit row can be written.
  await recordRemoval(task, { actor: "auto_cleanup", checkpoint, reasons: assessed.reasons })
    .catch((error) => process.stderr.write(`[codex-supervisor] removed ${task.id} but could not record it: ${error.message}\n`));
  return { task_id: task.id, kind: "worktree", branch: `codex/${task.id}`, checkpoint_commit: checkpoint, reasons: assessed.reasons };
}

// A scratch directory holds a research worker's drafts; its report is in the
// store. It goes once the hold period is over.
async function sweepScratch(task, now) {
  const path = join(scratchDir, task.id);
  const finished = finishedAt(task);
  if (!finished || now < finished + holdMsFrom(process.env.CODEX_SUPERVISOR_CLEANUP_HOLD_DAYS) || !existsSync(path)) return null;
  const claim = await claimIdleTask(task.id);
  if (!claim) return null;
  try {
    await rm(path, { recursive: true, force: true });
  } finally {
    await releaseTaskRun(task.id, claim);
  }
  await appendTaskEvent(task.id, { type: "supervisor.cleanup_removed", kind: "scratch", removed_at: new Date(now).toISOString(), retained: ["task", "events", "jsonl", "artifacts"] },
    { runId: runIdFor(task.id, task.run_count ?? 1), actor: "auto_cleanup" }).catch(() => null);
  return { task_id: task.id, kind: "scratch" };
}

// Returns what was removed. One failure never stops the sweep or the poll.
export async function sweepCleanup({ now = Date.now(), force = false } = {}) {
  if (process.env.CODEX_SUPERVISOR_NO_AUTO_CLEANUP === "1") return [];
  if (!force && now - lastSweepAt < intervalMs()) return [];
  lastSweepAt = now;
  const tasks = await readTasks();
  const finished = tasks.filter((task) => TERMINAL_STATUSES.has(task.status)).sort((a, b) => finishedAt(a) - finishedAt(b));
  const removed = [];
  let examined = 0;
  for (const task of finished) {
    if (examined >= SWEEP_LIMIT) break;
    try {
      if (task.workspace_kind === "scratch") {
        examined += 1;
        const gone = await sweepScratch(task, now);
        if (gone) removed.push(gone);
        continue;
      }
      if (!task.worktree_path || !existsSync(task.worktree_path)) continue;
      examined += 1;
      const gone = await sweepWorktree(task, tasks, now);
      if (gone) removed.push(gone);
    } catch (error) {
      process.stderr.write(`[codex-supervisor] auto cleanup skipped ${task.id}: ${error.message.split("\n")[0]}\n`);
    }
  }
  return removed;
}
