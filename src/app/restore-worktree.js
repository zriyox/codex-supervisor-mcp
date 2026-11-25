// A cleaned-up worker keeps its branch. When the main thread comes back to it
// (to resume or land), the worktree is cut again from that branch, with the
// same setup links, so cleanup never closes the door on unfinished work.
import "./compose.js";
import { gitBin, gitSucceeds } from "../infra/git.js";
import { runToExit } from "../infra/process.js";
import { runIdFor } from "../infra/store/db.js";
import { appendTaskEvent } from "../infra/store/events.js";
import { updateWorkItemDelivery } from "../infra/store/records.js";
import { prepareWorktreeWorkspace } from "./worktree-setup.js";
import { existsSync } from "node:fs";

// True when a worktree was restored.
export async function ensureTaskWorktree(task) {
  if (!task.worktree_path || !task.project_root || existsSync(task.worktree_path)) return false;
  const branch = `codex/${task.id}`;
  if (!gitSucceeds(task.project_root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])) return false;
  await runToExit(gitBin(), ["-C", task.project_root, "worktree", "prune"]).catch(() => {});
  await runToExit(gitBin(), ["-C", task.project_root, "worktree", "add", task.worktree_path, branch]);
  const setup = task.workspace_metadata?.setup ?? null;
  if (setup) await prepareWorktreeWorkspace(setup, task.project_root, task.worktree_path, task.id);
  await updateWorkItemDelivery(task.id, task.landed_at ? "landed" : "draft").catch(() => null);
  await appendTaskEvent(task.id, { type: "supervisor.worktree_restored", branch, restored_at: new Date().toISOString() },
    { runId: runIdFor(task.id, task.run_count ?? 1), actor: "supervisor" }).catch(() => null);
  return true;
}
