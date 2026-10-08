// Landing a worker's commits where they were dispatched from.
//
// A worker commits on codex/<taskId> inside its own worktree. Getting that
// work onto the branch the main thread integrates on used to be the main
// thread's job, one cherry-pick per step, dozens of times per batch. This
// does the same thing with the same guard rails a careful person would use:
// the target must be clean, it is never switched to another branch, and a
// conflict leaves nothing half-applied.
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parsePorcelainLine, resolveWorktreeBase, worktreeRef } from "./worktree.js";

const defaultGitBin = process.env.GIT_BIN?.trim() || "git";

// A commit needs a committer. On a machine where git has no user.name or
// user.email (CI runners, a fresh box, a GUI-launched MCP with no HOME
// config), cherry-pick and commit both die with "empty ident name", so a
// stand-in identity is supplied through the environment for that one
// directory. An identity git already has is used untouched.
const FALLBACK_IDENTITY = { name: "codex-supervisor", email: "codex-supervisor@localhost" };
const identityCache = new Map();
export function identityEnv(cwd) {
  if (identityCache.has(cwd)) return identityCache.get(cwd);
  let name = "";
  let email = "";
  try {
    name = execFileSync(defaultGitBin, ["-C", cwd, "config", "user.name"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000 }).trim();
  } catch {
    // unset
  }
  try {
    email = execFileSync(defaultGitBin, ["-C", cwd, "config", "user.email"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000 }).trim();
  } catch {
    // unset
  }
  const env = {};
  if (!name || !email) {
    env.GIT_AUTHOR_NAME = name || FALLBACK_IDENTITY.name;
    env.GIT_AUTHOR_EMAIL = email || FALLBACK_IDENTITY.email;
    env.GIT_COMMITTER_NAME = name || FALLBACK_IDENTITY.name;
    env.GIT_COMMITTER_EMAIL = email || FALLBACK_IDENTITY.email;
  }
  identityCache.set(cwd, env);
  return env;
}

function git(cwd, args, { timeout = 60000 } = {}) {
  return execFileSync(defaultGitBin, ["-C", cwd, "-c", "core.quotePath=false", ...args], {
    encoding: "utf8",
    timeout,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true", ...identityEnv(cwd) }
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
//
// `commitMessage` commits what the worker left uncommitted in its worktree
// first, as one commit on codex/<id>. A worker in Codex's workspace-write
// sandbox cannot commit at all (the sandbox keeps .git read-only), so this
// is how "one step, one commit" is kept without giving workers full access.
//
// Returns { landed: [{ sha, original, subject }], onto, head } on success;
// otherwise { error, reason, ... } with nothing changed in the target.
export function landWorker(task, { onto = null, commitMessage = null, ignoreAcceptance = false } = {}) {
  const target = task.project_root;
  // The dispatcher's own checks are the gate. A failed run is refused until
  // it passes; a run that was cut short is refused until it has run.
  const acceptance = task.acceptance_results ?? null;
  if (!ignoreAcceptance && acceptance) {
    const failing = (acceptance.checks ?? []).find((check) => check.exit_code !== 0) ?? null;
    if (acceptance.passed === false) {
      return {
        error: "acceptance_failed",
        reason: `the worker's acceptance run failed${failing ? ` on "${failing.command.slice(0, 120)}" (exit ${failing.timed_out ? "timeout" : failing.exit_code})` : acceptance.error ? ` (${acceptance.error})` : ""}; resume the worker with the failing output and land once it passes. ignoreAcceptance: true lands anyway, only when the user said to.`,
        acceptance: { status: acceptance.status, passed: false, checks: acceptance.checks ?? [], error: acceptance.error ?? null }
      };
    }
    if (acceptance.status === "running" || acceptance.status === "interrupted" || acceptance.status === "cancelled") {
      return {
        error: "acceptance_not_run",
        reason: `the worker's acceptance is ${acceptance.status}; wait for it (or resume the worker to run it again) before landing. ignoreAcceptance: true lands anyway, only when the user said to.`,
        acceptance: { status: acceptance.status, passed: null }
      };
    }
  }
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
  let uncommitted = porcelainPaths(git(task.worktree_path, ["--no-optional-locks", "status", "--porcelain"]));
  let committedForWorker = null;
  if (uncommitted.length > 0 && commitMessage) {
    try {
      git(task.worktree_path, ["add", "-A"]);
      git(task.worktree_path, ["commit", "-q", "-m", commitMessage]);
    } catch (error) {
      const tail = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim().split("\n").slice(-3).join("\n");
      return { error: "commit_failed", reason: `could not commit the worker's uncommitted edits in ${task.worktree_path}: ${tail || error.message.split("\n")[0]}`, uncommitted };
    }
    committedForWorker = git(task.worktree_path, ["rev-parse", "HEAD"]).trim();
    commits.push(committedForWorker);
    uncommitted = [];
  }
  // Commits whose patch is already on the target (a previous land, or the
  // main thread cherry-picked by hand) are skipped by patch id; picking
  // them again produces an empty commit and git stops with an error.
  const targetHead = git(target, ["rev-parse", "HEAD"]).trim();
  let alreadyLanded = [];
  if (commits.length > 0) {
    try {
      const workerHead = git(task.worktree_path, ["rev-parse", "HEAD"]).trim();
      const pending = new Set(lines(git(target, ["rev-list", "--cherry-pick", "--right-only", `${targetHead}...${workerHead}`])));
      alreadyLanded = commits.filter((sha) => !pending.has(sha));
      commits = commits.filter((sha) => pending.has(sha));
    } catch {
      // comparison failed; try to land everything and let the pick decide
    }
  }
  if (commits.length === 0 && alreadyLanded.length > 0) {
    return {
      error: "nothing_to_land",
      reason: `every commit on this worker's branch is already on ${branch} (landed before, by patch); nothing new to land`,
      already_landed: alreadyLanded,
      uncommitted,
      base_commit: base
    };
  }
  if (commits.length === 0) {
    return {
      error: "nothing_to_land",
      reason: uncommitted.length > 0
        ? "the worker made no commits on its branch (a workspace-write worker cannot: the sandbox keeps .git read-only); pass commitMessage to commit its edits as one commit and land that"
        : "the worker made no commits and left no edits on its branch",
      uncommitted,
      base_commit: base
    };
  }

  const before = targetHead;
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
    already_landed: alreadyLanded,
    committed_for_worker: committedForWorker,
    uncommitted
  };
}

function gitTail(error) {
  return `${error.stdout ?? ""}${error.stderr ?? ""}`.trim().split("\n").slice(-4).join("\n") || error.message.split("\n")[0];
}

function conflictFiles(cwd) {
  try {
    return lines(git(cwd, ["diff", "--name-only", "--diff-filter=U"]));
  } catch {
    return [];
  }
}

function stashRef(cwd) {
  try {
    return git(cwd, ["rev-parse", "-q", "--verify", "refs/stash"]).trim() || null;
  } catch {
    return null;
  }
}

function operationInProgress(cwd) {
  for (const marker of ["rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "MERGE_HEAD"]) {
    try {
      const path = git(cwd, ["rev-parse", "--git-path", marker]).trim();
      if (path && existsSync(path.startsWith("/") || /^[A-Za-z]:/.test(path) ? path : join(cwd, path))) return marker;
    } catch {
      // not a repo; the caller reports that
    }
  }
  return null;
}

// Moves a worker's worktree onto a newer commit of the project before the
// worker is resumed. The worktree was cut from base_commit when the worker
// was dispatched; by the time it is sent back for a fix the project's branch
// has often moved on, and a worker that keeps editing the old base does
// work that cannot land.
//
// Exactly the worker's own commits are replayed: `git rebase --onto <onto>
// <base>`, never a plain rebase, whose merge-base start would also replay
// the project's own commits when the base was rewritten. Edits the worker
// left uncommitted (every workspace-write worker: the sandbox keeps .git
// read-only) are stashed around the rebase, untracked files included.
//
// Nothing is left half done. A conflict in the replay aborts the rebase; a
// conflict when the stash comes back resets the branch to where it was and
// pops the stash there, which cannot conflict. Either way the worktree is as
// it was and the caller gets the file list.
//
// Returns { ok: true, noop: true, base_commit, head } when onto is already in
// the branch's history, { ok: true, base_commit: onto, head, replayed,
// stashed } after a real rebase, or { error, reason, files?, git?,
// base_commit, head } with nothing changed.
export function rebaseWorktree(task, ontoCommit) {
  const cwd = task.worktree_path;
  if (!cwd || !existsSync(cwd)) {
    return { error: "no_worktree", reason: "this worker has no worktree (it ran in place), so there is nothing to rebase" };
  }
  const base = resolveWorktreeBase(cwd, worktreeRef(task));
  if (!base) return { error: "no_base_commit", reason: "the commit this worker started from is unknown, so its own commits cannot be told apart for the replay" };
  const inProgress = operationInProgress(cwd);
  if (inProgress) {
    return { error: "rebase_in_progress", reason: `${cwd} has a ${inProgress} in progress; finish or abort it first`, base_commit: base };
  }
  let head;
  try {
    head = git(cwd, ["rev-parse", "HEAD"]).trim();
  } catch (error) {
    return { error: "no_worktree", reason: `${cwd} has no resolvable HEAD: ${gitTail(error)}`, base_commit: base };
  }
  try {
    git(cwd, ["merge-base", "--is-ancestor", ontoCommit, "HEAD"]);
    // onto is already behind or at this branch: a rebase would move the
    // worker's commits backwards. Nothing to do and base stays.
    return { ok: true, noop: true, base_commit: base, head };
  } catch (error) {
    if (error.status !== 1) {
      return { error: "rebase_failed", reason: `could not compare ${ontoCommit} with HEAD: ${gitTail(error)}`, git: gitTail(error), base_commit: base, head };
    }
  }

  const stashBefore = stashRef(cwd);
  let stashed = false;
  try {
    git(cwd, ["stash", "push", "--include-untracked", "-q", "-m", "codex-supervisor: rebase"]);
  } catch (error) {
    return { error: "rebase_failed", reason: `could not stash the worker's uncommitted edits: ${gitTail(error)}`, git: gitTail(error), base_commit: base, head };
  }
  // "No local changes to save" also exits 0, so the stash ref decides.
  stashed = stashRef(cwd) !== stashBefore;

  // A pop that fails has already written the stash's untracked files back
  // into the worktree, and reset --hard does not touch untracked files, so
  // the next pop would stop on "already exists". Those files are the
  // stash's third parent; they are removed before the pop that restores
  // them for good.
  const removeStashedUntracked = () => {
    let paths = [];
    try {
      paths = lines(git(cwd, ["ls-tree", "-r", "--name-only", "refs/stash^3"]));
    } catch {
      return; // the stash carries no untracked files
    }
    for (const path of paths) rmSync(join(cwd, path), { force: true });
  };
  const restoreStash = () => {
    if (!stashed) return null;
    try {
      removeStashedUntracked();
      git(cwd, ["stash", "pop", "-q"]);
      return null;
    } catch (error) {
      return gitTail(error);
    }
  };

  try {
    git(cwd, ["rebase", "--onto", ontoCommit, base], { timeout: 10 * 60 * 1000 });
  } catch (error) {
    const files = conflictFiles(cwd);
    try {
      git(cwd, ["rebase", "--abort"]);
    } catch {
      // nothing in progress to abort
    }
    const popError = restoreStash();
    return {
      error: files.length > 0 ? "rebase_conflict" : "rebase_failed",
      reason: files.length > 0
        ? `replaying the worker's commits onto ${ontoCommit.slice(0, 12)} hit a conflict; the worktree is back as it was${popError ? " (but its stash could not be restored: run git stash pop there)" : ""}`
        : `the rebase failed; the worktree is back as it was${popError ? " (but its stash could not be restored: run git stash pop there)" : ""}`,
      files,
      git: gitTail(error),
      base_commit: base,
      head
    };
  }
  const newHead = git(cwd, ["rev-parse", "HEAD"]).trim();
  let replayed = 0;
  try {
    replayed = lines(git(cwd, ["rev-list", `${ontoCommit}..HEAD`])).length;
  } catch {
    // reported as 0
  }

  if (stashed) {
    try {
      git(cwd, ["stash", "pop", "-q"]);
    } catch (error) {
      // The replay succeeded but the worker's uncommitted edits do not fit
      // the new base. Back to the old base, where the same stash pops clean.
      const files = conflictFiles(cwd);
      const tail = gitTail(error);
      try {
        git(cwd, ["reset", "-q", "--hard", head]);
      } catch {
        // fall through; the stash is still there
      }
      const popError = restoreStash();
      return {
        error: "stash_conflict",
        reason: `the worker's uncommitted edits conflict with ${ontoCommit.slice(0, 12)}; the worktree is back as it was${popError ? " (but its stash could not be restored: run git stash pop there)" : ""}. Commit them first (land_codex_worker with commitMessage) so the conflict is in a commit that can be resolved, or redispatch from the new commit with baseRef`,
        files,
        git: tail,
        base_commit: base,
        head
      };
    }
  }
  return { ok: true, base_commit: ontoCommit, head: newHead, previous_head: head, replayed, stashed };
}
