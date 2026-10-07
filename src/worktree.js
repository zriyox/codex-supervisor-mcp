// Ground truth for "what did this worker change".
//
// Codex reports edits as file_change items only when it uses its own patch
// tool. A worker that edits through shell commands produces no such item, so
// the worktree itself is the authoritative source: every worker gets its own
// checkout, so the diff inside it is exactly that worker's work.
//
// Two reads are needed. `git status` covers what is still uncommitted. A
// worker that commits on its branch leaves a clean status, and one real batch
// of five workers all did exactly that and reported no changed files at all -
// so the committed part is read as `git diff --name-only <base> HEAD`, where
// base is the commit the worktree was created from.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const defaultGitBin = process.env.GIT_BIN?.trim() || "git";

function git(worktreePath, args) {
  return execFileSync(defaultGitBin, ["-C", worktreePath, ...args], {
    encoding: "utf8",
    timeout: 15000,
    stdio: ["ignore", "pipe", "ignore"]
  });
}

function parsePorcelainLine(line) {
  // " M path", "?? path", "R  old -> new"
  const trimmed = line.replace(/\s+$/, "");
  if (trimmed.length < 4) return null;
  let rest = trimmed.slice(3);
  const arrow = rest.indexOf(" -> ");
  if (arrow !== -1) rest = rest.slice(arrow + 4);
  if (rest.startsWith('"') && rest.endsWith('"')) rest = rest.slice(1, -1);
  return rest.trim() || null;
}

function nonEmptyLines(output) {
  return output.split("\n").map((line) => line.trim()).filter(Boolean);
}

// The commit the worker started from. Rows written by this version carry it
// as base_commit. Older rows do not, but the branch reflog still has it: the
// oldest reflog entry of `codex/<id>` is the branch's creation point.
export function resolveWorktreeBase(worktreePath, { baseCommit = null, branch = null } = {}) {
  if (baseCommit) return baseCommit;
  if (!branch) return null;
  try {
    const entries = nonEmptyLines(git(worktreePath, ["reflog", "show", "--format=%H", branch]));
    return entries.at(-1) ?? null;
  } catch {
    return null;
  }
}

export function readWorktreeChanges(worktreePath, { baseCommit = null, branch = null } = {}) {
  if (!worktreePath || !existsSync(worktreePath)) return [];
  const found = new Set();
  try {
    const output = git(worktreePath, ["status", "--porcelain"]);
    for (const entry of output.split("\n").map(parsePorcelainLine).filter(Boolean)) found.add(entry);
  } catch {
    return [];
  }
  const base = resolveWorktreeBase(worktreePath, { baseCommit, branch });
  if (base) {
    try {
      for (const entry of nonEmptyLines(git(worktreePath, ["diff", "--name-only", base, "HEAD"]))) found.add(entry);
    } catch {
      // A base that no longer resolves (history rewritten) leaves only the
      // uncommitted part. Better a partial answer than none.
    }
  }
  return Array.from(found, (entry) => join(worktreePath, entry));
}

export function mergeChangedFiles(existing, discovered) {
  return Array.from(new Set([...(existing ?? []), ...(discovered ?? [])]));
}

// What a task row knows about its own worktree, in the shape
// readWorktreeChanges wants. Kept here so every caller derives the branch
// name the same way the runner creates it.
export function worktreeRef(task) {
  return {
    baseCommit: task.base_commit ?? null,
    branch: task.worktree_path ? `codex/${task.id}` : null
  };
}

export function readTaskChanges(task) {
  return mergeChangedFiles(task.changed_files, readWorktreeChanges(task.worktree_path, worktreeRef(task)));
}
