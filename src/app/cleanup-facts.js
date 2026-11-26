// Reads what the cleanup policy needs to know about one worker's worktree.
import { branchOf } from "../domain/worker-branch.js";
import "./compose.js";
import { ACTIVE_STATUSES, TERMINAL_STATUSES, runIsOver } from "../domain/status.js";
import { gitSucceedsAsync, runGitAsync } from "../infra/git.js";
import { worktreesDir } from "../infra/paths.js";
import { isGroupAlive, isPidAlive } from "../infra/store/tasks.js";
import { parsePorcelainLine, resolveWorktreeBase, workspaceSetupIgnorePaths, worktreeRef } from "../infra/worktree.js";
import { lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";

// Raw output: porcelain status lines start with a significant space, and a
// quoted path would never match a setup path. Callers trim single values.
const git = (cwd, args) => runGitAsync(cwd, args, { timeout: 15000, noOptionalLocks: true, rawPaths: true, trim: false });
const lines = (text) => text.split("\n").filter(Boolean);

function activeReason(task) {
  // Once the run is over its pids may belong to anyone.
  const settled = runIsOver(task);
  if (!settled && task.pid && isPidAlive(task.pid)) return "worker process is still active";
  if (!settled && task.run_host_pid && isPidAlive(task.run_host_pid)) return "run host process is still active";
  // A lost run can leave a process behind that still writes in the worktree; only a recorded exit rules that out.
  if (task.exit_code == null && isGroupAlive(task.run_host_pid)) return "a process of the worker's run is still active";
  const acceptance = task.acceptance_results;
  if (acceptance?.status === "running" || (acceptance?.supervisor_pid && isPidAlive(acceptance.supervisor_pid))) return "acceptance process is still active";
  return null;
}

// Null when the path is this task's managed worktree on its own branch.
async function identityProblem(task) {
  if (!task.worktree_path || !task.project_root) return "no registered isolated worktree";
  const path = resolve(task.worktree_path);
  const managed = resolve(worktreesDir, task.id);
  if (path !== managed) return "worktree is outside its managed task directory";
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return "worktree is a symlink";
    if (await realpath(path) !== await realpath(managed)) return "worktree realpath is unexpected";
    const branch = (await git(path, ["symbolic-ref", "--short", "HEAD"])).trim();
    if (branch !== branchOf(task)) return "worktree branch ownership is unexpected";
    const registered = (await git(task.project_root, ["worktree", "list", "--porcelain", "-z"])).split("\0").filter((line) => line.startsWith("worktree "));
    const own = await realpath(path);
    for (const line of registered) {
      // A registration whose directory someone deleted has no realpath; it is not ours either way.
      if (await realpath(line.slice(9)).catch(() => null) === own) return null;
    }
    return "git worktree registration is missing";
  } catch (error) {
    return `cleanup proof failed: ${error.message.split("\n")[0]}`;
  }
}

// Paths the dispatcher linked into the worktree (node_modules and the like)
// are setup, not the worker's output.
function setupFilter(task) {
  const setup = workspaceSetupIgnorePaths(task);
  return (path) => !setup.some((entry) => path === entry || path.startsWith(`${entry}/`));
}

function isLanded(task) {
  if (!task.landed_at || !task.landed_head) return false;
  const target = task.landed_branch ? `refs/heads/${task.landed_branch}` : "HEAD";
  return gitSucceedsAsync(task.project_root, ["merge-base", "--is-ancestor", task.landed_head, target]);
}

async function worktreeState(task) {
  const path = resolve(task.worktree_path);
  const keep = setupFilter(task);
  const status = lines(await git(path, ["status", "--porcelain", "--untracked-files=all"]));
  const uncommittedPaths = status.map(parsePorcelainLine).filter((entry) => entry && keep(entry));
  // Without the base the worker's own commits cannot be counted, and "nothing
  // to keep" could not be told from "cannot tell".
  const base = resolveWorktreeBase(path, worktreeRef(task));
  if (!base) throw new Error("the commit this worker started from is unknown");
  const unlandedCommits = lines(await git(path, ["rev-list", `${base}..HEAD`])).length;
  return { uncommittedPaths, unlandedCommits, head: (await git(path, ["rev-parse", "HEAD"])).trim() };
}

export async function cleanupFacts(task, tasks) {
  const facts = {
    active: activeReason(task),
    dependent: tasks.some((other) => ACTIVE_STATUSES.has(other.status) && (other.depends_on ?? []).includes(task.id)),
    terminal: TERMINAL_STATUSES.has(task.status),
    identity: null, landed: false, uncommitted: 0, unlandedCommits: 0, uncommittedPaths: [], head: null,
    finishedAt: Date.parse(task.completed_at ?? task.updated_at ?? "") || null
  };
  if (facts.active || facts.dependent || !facts.terminal) return facts;
  facts.identity = await identityProblem(task);
  if (facts.identity) return facts;
  try {
    const state = await worktreeState(task);
    facts.landed = await isLanded(task);
    facts.uncommittedPaths = state.uncommittedPaths;
    facts.uncommitted = state.uncommittedPaths.length;
    facts.unlandedCommits = state.unlandedCommits;
    facts.head = state.head;
  } catch (error) {
    facts.identity = `cleanup proof failed: ${error.message.split("\n")[0]}`;
  }
  return facts;
}
