// Landing a worker's commits where they were dispatched from.
//
// A worker commits on codex/<taskId> inside its own worktree. Getting that
// work onto the branch the main thread integrates on used to be the main
// thread's job, one cherry-pick per step, dozens of times per batch. This
// does the same thing with the same guard rails a careful person would use:
// the target must be clean, it is never switched to another branch, and a
// conflict leaves nothing half-applied.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { parsePorcelainLine, resolveWorktreeBase, worktreeRef } from "./worktree.js";

const defaultGitBin = process.env.GIT_BIN?.trim() || "git";

function git(cwd, args, { timeout = 60000 } = {}) {
  return execFileSync(defaultGitBin, ["-C", cwd, "-c", "core.quotePath=false", ...args], {
    encoding: "utf8",
    timeout,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true" }
  });
}

function lines(output) {
  return output.split("\n").map((line) => line.trim()).filter(Boolean);
}

// Porcelain lines carry their status in the first two columns, so they must
// not be trimmed before parsing.
function porcelainPaths(output) {
  return output.split("\n").filter((line) => line.length > 3).map(parsePorcelainLine).filter(Boolean);
}

function currentBranch(cwd) {
  const name = git(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]).trim();
  return name || null;
}

// Lands task's commits onto the current branch of its dispatch directory
// (task.project_root: the row's cwd is the worktree the worker ran in).
// `onto`, when given, must name that branch: it is a guard, not a switch.
// Returns { landed: [{ sha, original, subject }], onto, head } on success;
// otherwise { error, reason, ... } with nothing changed in the target.
export function landWorker(task, { onto = null } = {}) {
  const target = task.project_root;
  if (!task.worktree_path || !existsSync(task.worktree_path)) {
    return { error: "no_worktree", reason: "this worker has no worktree (it ran in place), so there is nothing on a codex/ branch to land" };
  }
  if (!target || !existsSync(target)) {
    return { error: "no_target", reason: `the directory the worker was dispatched from (${target}) no longer exists` };
  }
  let branch;
  try {
    branch = currentBranch(target);
  } catch (error) {
    return { error: "no_target", reason: `${target} is not a git checkout: ${error.message.split("\n")[0]}` };
  }
  if (!branch) return { error: "detached_target", reason: `${target} has a detached HEAD; check out the branch you integrate on first` };
  if (onto && onto !== branch) {
    return { error: "wrong_branch", reason: `${target} is on ${branch}, not ${onto}; this tool never switches branches for you`, current_branch: branch };
  }
  const dirty = porcelainPaths(git(target, ["status", "--porcelain", "--untracked-files=no"]));
  if (dirty.length > 0) {
    return { error: "dirty_target", reason: `${target} has uncommitted changes; commit or stash them before landing`, dirty_files: dirty };
  }

  const base = resolveWorktreeBase(task.worktree_path, worktreeRef(task));
  if (!base) return { error: "no_base_commit", reason: "the commit this worker started from is unknown, so its commits cannot be told apart" };
  let commits;
  try {
    commits = lines(git(task.worktree_path, ["rev-list", "--reverse", `${base}..HEAD`]));
  } catch (error) {
    return { error: "no_base_commit", reason: `the base ${base} no longer resolves in the worktree: ${error.message.split("\n")[0]}` };
  }
  const uncommitted = porcelainPaths(git(task.worktree_path, ["--no-optional-locks", "status", "--porcelain"]));
  if (commits.length === 0) {
    return { error: "nothing_to_land", reason: "the worker made no commits on its branch; uncommitted edits are not landed", uncommitted, base_commit: base };
  }

  const before = git(target, ["rev-parse", "HEAD"]).trim();
  try {
    git(target, ["cherry-pick", "--allow-empty-message", ...commits], { timeout: 10 * 60 * 1000 });
  } catch (error) {
    let conflicts = [];
    try {
      conflicts = lines(git(target, ["diff", "--name-only", "--diff-filter=U"]));
    } catch {
      // no conflict list, still abort
    }
    try {
      git(target, ["cherry-pick", "--abort"]);
    } catch {
      // nothing in progress to abort
    }
    const tail = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim().split("\n").slice(-4).join("\n");
    return {
      error: "conflict",
      reason: conflicts.length > 0 ? `cherry-pick stopped on a conflict; ${target} was reset to where it was` : `cherry-pick failed; ${target} was reset to where it was`,
      conflicts,
      git: tail,
      base_commit: base,
      commits,
      uncommitted
    };
  }
  const landed = lines(git(target, ["rev-list", "--reverse", `${before}..HEAD`]));
  const subjects = lines(git(target, ["log", "--format=%H%x09%s", `${before}..HEAD`]));
  const subjectOf = new Map(subjects.map((line) => line.split("\t")).map(([sha, subject]) => [sha, subject]));
  return {
    onto: branch,
    target,
    base_commit: base,
    head: landed.at(-1) ?? before,
    landed: landed.map((sha, index) => ({ sha, original: commits[index] ?? null, subject: subjectOf.get(sha) ?? null })),
    uncommitted
  };
}
