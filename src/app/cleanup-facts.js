// Reads what the cleanup policy needs to know about one worker's worktree.
import "./compose.js";
import { ACTIVE_STATUSES, TERMINAL_STATUSES } from "../domain/status.js";
import { gitSucceeds, runGit } from "../infra/git.js";
import { worktreesDir } from "../infra/paths.js";
import { isPidAlive } from "../infra/store/tasks.js";
import { parsePorcelainLine, resolveWorktreeBase, workspaceSetupIgnorePaths, worktreeRef } from "../infra/worktree.js";
import { lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";

const git = (cwd, args) => runGit(cwd, args, { timeout: 15000, noOptionalLocks: true });
const lines = (text) => text.split("\n").filter(Boolean);

function activeReason(task) {
  if (task.pid && isPidAlive(task.pid)) return "worker process is still active";
  if (task.run_host_pid && isPidAlive(task.run_host_pid)) return "run host process is still active";
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
    const branch = git(path, ["symbolic-ref", "--short", "HEAD"]);
    if (branch !== `codex/${task.id}`) return "worktree branch ownership is unexpected";
    const registered = git(task.project_root, ["worktree", "list", "--porcelain", "-z"]).split("\0").filter((line) => line.startsWith("worktree "));
    for (const line of registered) if (await realpath(line.slice(9)) === await realpath(path)) return null;
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
  return gitSucceeds(task.project_root, ["merge-base", "--is-ancestor", task.landed_head, target]);
}

function worktreeState(task) {
  const path = resolve(task.worktree_path);
  const keep = setupFilter(task);
  const status = lines(git(path, ["status", "--porcelain", "--untracked-files=all"]));
  const uncommittedPaths = status.map(parsePorcelainLine).filter((entry) => entry && keep(entry));
  const base = resolveWorktreeBase(path, worktreeRef(task));
  const unlandedCommits = base ? lines(git(path, ["rev-list", `${base}..HEAD`])).length : 0;
  return { uncommittedPaths, unlandedCommits, head: git(path, ["rev-parse", "HEAD"]) };
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
    const state = worktreeState(task);
    facts.landed = isLanded(task);
    facts.uncommittedPaths = state.uncommittedPaths;
    facts.uncommitted = state.uncommittedPaths.length;
    facts.unlandedCommits = state.unlandedCommits;
    facts.head = state.head;
  } catch (error) {
    facts.identity = `cleanup proof failed: ${error.message.split("\n")[0]}`;
  }
  return facts;
}
