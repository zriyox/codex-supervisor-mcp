// A cleaned-up worker keeps its branch. When the main thread comes back to it
// (to resume or land), the worktree is cut again from that branch, with the
// same setup links, so cleanup never closes the door on unfinished work.
import { branchOf } from "../domain/worker-branch.js";
import "./compose.js";
import { gitBin, gitSucceeds } from "../infra/git.js";
import { runToExit } from "../infra/process.js";
import { runIdFor } from "../infra/store/db.js";
import { appendTaskEvent } from "../infra/store/events.js";
import { updateWorkItemDelivery } from "../infra/store/records.js";
import { prepareWorktreeWorkspace, withWorktreeCreationLock } from "./worktree-setup.js";
import { existsSync } from "node:fs";

function deliveryStepOf(task) {
  if (task.push_verified_at) return "push_verified";
  return task.landed_at ? "landed" : "draft";
}

// True when a worktree was restored, false when there was nothing to do
// (already present, or the task never had one). Throws when the worktree is
// gone and cannot be brought back, so no caller carries on somewhere else.
export async function ensureTaskWorktree(task) {
  if (!task.worktree_path || !task.project_root || existsSync(task.worktree_path)) return false;
  const branch = branchOf(task);
  if (!gitSucceeds(task.project_root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])) {
    const error = new Error(`the worktree of ${task.id} is gone and its branch ${branch} does not exist, so it cannot be restored`);
    error.code = "worktree_unrecoverable";
    throw error;
  }
  const restored = await withWorktreeCreationLock(task.project_root, async () => {
    if (existsSync(task.worktree_path)) return false;
    await runToExit(gitBin(), ["-C", task.project_root, "worktree", "prune"]).catch(() => {});
    await runToExit(gitBin(), ["-C", task.project_root, "worktree", "add", task.worktree_path, branch]);
    return true;
  });
  if (!restored) return false;
  const setup = task.workspace_metadata?.setup ?? null;
  if (setup) {
    try {
      await prepareWorktreeWorkspace(setup, task.project_root, task.worktree_path, task.id);
    } catch (error) {
      // A worktree without its setup would look restored and fail at the first command.
      await runToExit(gitBin(), ["-C", task.project_root, "worktree", "remove", "--force", task.worktree_path]).catch(() => {});
      throw error;
    }
  }
  await updateWorkItemDelivery(task.id, deliveryStepOf(task)).catch(() => null);
  await appendTaskEvent(task.id, { type: "supervisor.worktree_restored", branch, restored_at: new Date().toISOString() },
    { runId: runIdFor(task.id, task.run_count ?? 1), actor: "supervisor" }).catch(() => null);
  return true;
}
