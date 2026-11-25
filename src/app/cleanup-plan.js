// Plans and performs worktree cleanup. A plan classifies each worktree as
// safe, review or blocked; applying one removes only safe worktrees, after
// saving any uncommitted edits as a checkpoint commit on the worker's branch.
// Branches, task rows, events, logs and artifacts are never removed.
import { branchOf } from "../domain/worker-branch.js";
import "./compose.js";
import { cleanupVerdict, holdMsFrom } from "../domain/cleanup-policy.js";
import { gitSucceedsAsync, runGitAsync } from "../infra/git.js";
import { runFile } from "../infra/process.js";
import { runIdFor } from "../infra/store/db.js";
import { appendTaskEvent } from "../infra/store/events.js";
import { markCleanupPlanItemApplied, updateWorkItemDelivery } from "../infra/store/records.js";
import { claimIdleTask, getTask, readTasks, releaseTaskRun } from "../infra/store/tasks.js";
import { workspaceSetupIgnorePaths } from "../infra/worktree.js";
import { cleanupFacts } from "./cleanup-facts.js";
import { identityEnv } from "./landing.js";
import { withWorktreeCreationLock } from "./worktree-setup.js";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";

export const CLEANUP_PLAN_TTL_MS = 15 * 60 * 1000;
export const CLEANUP_POLICY = "keep_branch_and_evidence_checkpoint_before_removal";
const RETAINED = ["branch", "task", "events", "jsonl", "artifacts"];

const git = (cwd, args, options = {}) => runGitAsync(cwd, args, { timeout: 15000, noOptionalLocks: true, ...options });
const holdMs = () => holdMsFrom(process.env.AGENT_SUPERVISOR_CLEANUP_HOLD_DAYS);

// The size is a hint for the reader of a plan. Where du is missing or slow
// the answer is 0, never a failed plan.
function directoryBytes(path) {
  return new Promise((resolveSize) => {
    runFile("du", ["-sk", path], { encoding: "utf8", timeout: 30000 }, (error, stdout) => {
      const kib = error ? NaN : Number(stdout.trim().split(/\s+/)[0]);
      resolveSize(Number.isFinite(kib) ? kib * 1024 : 0);
    });
  });
}

// A plan item is only applied to the worktree it was made for: same commit,
// same uncommitted paths.
function fingerprintOf(task, facts) {
  const proof = { path: resolve(task.worktree_path), head: facts.head, uncommitted: facts.uncommittedPaths, landed: facts.landed };
  return createHash("sha256").update(JSON.stringify(proof)).digest("hex");
}

export async function assessWorktree(task, tasks, now = Date.now()) {
  const facts = await cleanupFacts(task, tasks);
  const result = cleanupVerdict(facts, { now, holdMs: holdMs() });
  return { ...result, facts, fingerprint: result.verdict === "safe" ? fingerprintOf(task, facts) : null };
}

export async function createCleanupPlan({ taskIds = null, projectRoot = null, now = Date.now() } = {}) {
  const tasks = await readTasks();
  const selected = tasks.filter((task) => (!taskIds || taskIds.includes(task.id)) && (!projectRoot || resolve(task.project_root) === resolve(projectRoot)));
  const items = [];
  for (const task of selected) {
    const result = await assessWorktree(task, tasks, now);
    items.push({
      task_id: task.id,
      verdict: result.verdict,
      reasons: result.reasons,
      checkpoint: result.checkpoint,
      fingerprint: result.fingerprint,
      reclaimable_bytes: result.verdict === "safe" ? await directoryBytes(task.worktree_path) : 0,
      eligible_after: result.eligible_after ?? (result.verdict === "safe" ? new Date(now).toISOString() : null)
    });
  }
  const count = (value) => items.filter((item) => item.verdict === value).length;
  return {
    id: randomUUID(),
    project_root: projectRoot ? resolve(projectRoot) : null,
    generated_at: new Date(now).toISOString(),
    expires_at: new Date(now + CLEANUP_PLAN_TTL_MS).toISOString(),
    policy: CLEANUP_POLICY,
    summary: { safe: count("safe"), review: count("review"), blocked: count("blocked"), reclaimable_bytes: items.reduce((sum, item) => sum + item.reclaimable_bytes, 0) },
    items
  };
}

// Saves the worker's uncommitted edits as one commit on its branch. Setup
// links are left out; hooks are skipped because nobody is there to answer them.
async function checkpointUncommitted(task) {
  const path = resolve(task.worktree_path);
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true", ...identityEnv(path) };
  const exclude = workspaceSetupIgnorePaths(task).map((entry) => `:(exclude)${entry}`);
  await git(path, ["add", "-A", "--", ".", ...exclude], { env });
  if (await gitSucceedsAsync(path, ["diff", "--cached", "--quiet"])) return null;
  await git(path, ["commit", "-q", "--no-verify", "-m", `Checkpoint before worktree cleanup (${task.id})`], { env });
  return git(path, ["rev-parse", "HEAD"]);
}

// Removes one worktree after proving again that it is safe and unchanged
// since it was assessed. The task is locked the way a dispatcher locks it, so
// a resume cannot start in the directory while it is being removed. Returns
// the checkpoint commit, or null.
export async function removeSafeWorktree(task, fingerprint) {
  const claim = await claimIdleTask(task.id);
  if (!claim) throw new Error("the task is running or held by a dispatcher; nothing was removed");
  try {
    const result = await assessWorktree(task, await readTasks());
    if (result.verdict !== "safe") throw new Error(`worktree is no longer safe: ${result.reasons.join("; ")}`);
    if (result.fingerprint !== fingerprint) throw new Error("worktree changed since cleanup plan; create a new plan");
    // The same lock that creating and restoring a worktree takes.
    return await withWorktreeCreationLock(task.project_root, async () => {
      const checkpoint = result.checkpoint ? await checkpointUncommitted(task) : null;
      // What is left now is setup links and ignored build output, neither of
      // which is the worker's work; a plain remove would refuse them.
      await git(task.project_root, ["worktree", "remove", "--force", task.worktree_path]);
      try {
        await git(task.project_root, ["worktree", "prune"]);
      } catch {
        // pruning is housekeeping; the worktree is already gone
      }
      return checkpoint;
    });
  } finally {
    await releaseTaskRun(task.id, claim);
  }
}

export async function recordRemoval(task, { actor, planId = null, itemId = null, checkpoint = null, reasons = [] }) {
  const removedAt = new Date().toISOString();
  await updateWorkItemDelivery(task.id, "cleanup_removed");
  await appendTaskEvent(task.id, {
    type: "supervisor.cleanup_removed",
    plan_id: planId,
    item_id: itemId,
    removed_at: removedAt,
    reasons,
    checkpoint_commit: checkpoint,
    branch: branchOf(task),
    retained: RETAINED
  }, { runId: runIdFor(task.id, task.run_count ?? 1), actor });
  return removedAt;
}

export async function applyCleanupPlan({ plan, itemIds, actor = "main_thread" }) {
  if (Date.parse(plan.expires_at) <= Date.now()) {
    return { error: "cleanup_plan_expired", plan_id: plan.id, expires_at: plan.expires_at };
  }
  const selected = plan.items.filter((item) => itemIds.includes(item.id));
  if (selected.length !== itemIds.length) return { error: "cleanup_plan_item_not_found", plan_id: plan.id };
  const applied = [];
  const skipped = [];
  for (const item of selected) {
    const skip = (reason) => skipped.push({ item_id: item.id, task_id: item.task_id, reason });
    if (item.verdict !== "safe") {
      skip("only SAFE plan items may be applied");
      continue;
    }
    const task = await getTask(item.task_id);
    if (!task) {
      skip("task no longer exists");
      continue;
    }
    try {
      const checkpoint = await removeSafeWorktree(task, item.fingerprint);
      await markCleanupPlanItemApplied(item.id, actor);
      const removedAt = await recordRemoval(task, { actor, planId: plan.id, itemId: item.id, checkpoint, reasons: item.reasons });
      applied.push({ item_id: item.id, task_id: task.id, worktree_path: task.worktree_path, removed_at: removedAt, checkpoint_commit: checkpoint });
    } catch (error) {
      skip(error.message.split("\n")[0]);
    }
  }
  return { plan_id: plan.id, applied, skipped, retained: RETAINED };
}
