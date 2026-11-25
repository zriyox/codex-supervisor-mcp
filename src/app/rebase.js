// Moving a worker's worktree onto a newer base before it continues: stash its
// uncommitted edits, replay only the commits that are not on the new base yet,
// put the edits back. Any failure leaves the worktree as it was.
import { resolveWorktreeBase, worktreeRef } from "../infra/worktree.js";
import { git, gitTail, lines } from "./landing.js";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

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
// A pop that fails has already written the stash's untracked files back
// into the worktree, and reset --hard does not touch untracked files, so
// the next pop would stop on "already exists". Those files are the
// stash's third parent; they are removed before the pop that restores
// them for good.
function removeStashedUntracked(cwd) {
  let paths;
  try {
    paths = lines(git(cwd, ["ls-tree", "-r", "--name-only", "refs/stash^3"]));
  } catch {
    return; // the stash carries no untracked files
  }
  for (const path of paths) rmSync(join(cwd, path), { force: true });
}

// Null when the stash is back (or there was none), otherwise git's complaint.
function restoreStash(cwd, stashed) {
  if (!stashed) return null;
  try {
    removeStashedUntracked(cwd);
    git(cwd, ["stash", "pop", "-q"]);
    return null;
  } catch (error) {
    return gitTail(error);
  }
}

// Where the worktree stands, or the reason it cannot be rebased, or a no-op
// when the new base is already behind it.
function rebaseStart(task, ontoCommit) {
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
  return { cwd, base, head };
}

function splitByPatch(cwd, base, ontoCommit, head) {
  try {
    const commits = lines(git(cwd, ["rev-list", "--reverse", `${base}..HEAD`]));
    const newPatches = new Set(lines(git(cwd, ["cherry", ontoCommit, "HEAD", base]))
      .filter((line) => line.startsWith("+ ")).map((line) => line.slice(2)));
    return { pending: commits.filter((sha) => newPatches.has(sha)), alreadyLanded: commits.filter((sha) => !newPatches.has(sha)) };
  } catch (error) {
    return { error: "rebase_failed", reason: `could not prove which worker patches are already integrated: ${gitTail(error)}`, base_commit: base, head };
  }
}

function stashEdits(cwd, base, head) {
  const stashBefore = stashRef(cwd);
  try {
    git(cwd, ["stash", "push", "--include-untracked", "-q", "-m", "codex-supervisor: rebase"]);
  } catch (error) {
    return { error: "rebase_failed", reason: `could not stash the worker's uncommitted edits: ${gitTail(error)}`, git: gitTail(error), base_commit: base, head };
  }
  // "No local changes to save" also exits 0, so the stash ref decides.
  return { stashed: stashRef(cwd) !== stashBefore };
}

// Rebase --onto can replay a patch previously cherry-picked to main and
// conflict with main's later edits. Rebuild only the proven new patches.
function replayPending({ cwd, base, head }, ontoCommit, pending, stashed) {
  try {
    git(cwd, ["reset", "-q", "--hard", ontoCommit]);
    if (pending.length) git(cwd, ["cherry-pick", ...pending], { timeout: 10 * 60 * 1000 });
    return null;
  } catch (error) {
    const files = conflictFiles(cwd);
    try {
      git(cwd, ["cherry-pick", "--abort"]);
    } catch {
      // nothing in progress to abort
    }
    git(cwd, ["reset", "-q", "--hard", head]);
    const popError = restoreStash(cwd, stashed);
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
}

// The replay succeeded; put the uncommitted edits back. If they do not fit the
// new base, go back to the old base, where the same stash pops clean.
function popOntoNewBase({ cwd, base, head }, ontoCommit) {
  try {
    git(cwd, ["stash", "pop", "-q"]);
    return null;
  } catch (error) {
    const files = conflictFiles(cwd);
    const tail = gitTail(error);
    try {
      git(cwd, ["reset", "-q", "--hard", head]);
    } catch {
      // fall through; the stash is still there
    }
    const popError = restoreStash(cwd, true);
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

export function rebaseWorktree(task, ontoCommit) {
  const start = rebaseStart(task, ontoCommit);
  if (start.error || start.noop) return start;
  const { cwd, base, head } = start;
  const split = splitByPatch(cwd, base, ontoCommit, head);
  if (split.error) return split;
  const stash = stashEdits(cwd, base, head);
  if (stash.error) return stash;
  const { stashed } = stash;

  const failed = replayPending(start, ontoCommit, split.pending, stashed);
  if (failed) return failed;
  const newHead = git(cwd, ["rev-parse", "HEAD"]).trim();
  let replayed = 0;
  try {
    replayed = lines(git(cwd, ["rev-list", `${ontoCommit}..HEAD`])).length;
  } catch {
    // reported as 0
  }
  const stashConflict = stashed ? popOntoNewBase(start, ontoCommit) : null;
  if (stashConflict) return stashConflict;
  return { ok: true, base_commit: ontoCommit, head: newHead, previous_head: head, replayed, already_landed: split.alreadyLanded, stashed };
}
