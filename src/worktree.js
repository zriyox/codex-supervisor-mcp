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
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { truncateMiddleChars } from "./truncate.js";

const defaultGitBin = process.env.GIT_BIN?.trim() || "git";

// Two global flags on every read here.
//
// core.quotePath is on by default and turns every non-ASCII path into an
// octal-escaped, double-quoted string ("\344\270\255..."). The projects
// this runs against have Chinese directory names, so it is switched off and
// paths come back as written.
//
// --no-optional-locks keeps `git status` from taking index.lock to refresh
// the index. These reads run while the worker is still working in the same
// worktree, from status polls and the board, and on Windows a status poll
// holding index.lock made the worker's own `git add` fail and the worker
// exit non-zero. An observer must never lock what it observes.
function git(worktreePath, args) {
  return execFileSync(defaultGitBin, ["--no-optional-locks", "-C", worktreePath, "-c", "core.quotePath=false", ...args], {
    encoding: "utf8",
    timeout: 15000,
    stdio: ["ignore", "pipe", "ignore"]
  });
}

export function parsePorcelainLine(line) {
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

// What the worker changed, as patches: everything between the commit the
// worktree started from and the working tree, committed or not, plus files
// git does not track yet. This is the main thread's ground truth for "what
// did it do", as opposed to what the worker says it did.
//
// `maxChars` bounds the whole answer. Files are served in git's order; a
// file that does not fit is cut in the middle (truncated: true), and files
// after the budget is spent come back without a patch so the list of what
// changed is still complete.
export function readWorktreeDiff(worktreePath, { baseCommit = null, branch = null } = {}, { maxChars = 60000, paths = [] } = {}) {
  if (!worktreePath || !existsSync(worktreePath)) return { error: "no_worktree", files: [] };
  const base = resolveWorktreeBase(worktreePath, { baseCommit, branch });
  if (!base) return { error: "no_base_commit", files: [] };
  let head = null;
  try {
    head = git(worktreePath, ["rev-parse", "HEAD"]).trim();
  } catch {
    // a worktree without a resolvable HEAD still has a working tree to diff
  }
  const scope = Array.isArray(paths) && paths.length > 0 ? ["--", ...paths] : [];

  const files = [];
  const known = new Set();
  try {
    for (const line of nonEmptyLines(git(worktreePath, ["diff", "--name-status", "-M", base, ...scope]))) {
      const [code, ...rest] = line.split("\t");
      const path = rest.at(-1);
      if (!path) continue;
      known.add(path);
      files.push({ path, status: statusWord(code), from: code.startsWith("R") && rest.length > 1 ? rest[0] : null });
    }
  } catch {
    return { error: "diff_failed", base_commit: base, head, files: [] };
  }
  const counts = new Map();
  try {
    for (const line of nonEmptyLines(git(worktreePath, ["diff", "--numstat", "-M", base, ...scope]))) {
      const [added, deleted, ...rest] = line.split("\t");
      counts.set(rest.at(-1), { additions: added === "-" ? null : Number(added), deletions: deleted === "-" ? null : Number(deleted) });
    }
  } catch {
    // counts are decoration
  }
  // Untracked files never show in `git diff`; the worker may have created
  // them with a shell command and not added them.
  try {
    for (const line of git(worktreePath, ["status", "--porcelain", "--untracked-files=all", ...scope]).split("\n")) {
      if (!line.startsWith("??")) continue;
      const path = parsePorcelainLine(line);
      if (!path || known.has(path)) continue;
      known.add(path);
      files.push({ path, status: "untracked", from: null });
    }
  } catch {
    // status failing leaves the tracked part
  }

  let remaining = maxChars;
  let truncatedFiles = 0;
  for (const file of files) {
    const stat = counts.get(file.path);
    file.additions = stat?.additions ?? null;
    file.deletions = stat?.deletions ?? null;
    file.patch = null;
    file.truncated = false;
    if (remaining <= 0) {
      file.truncated = true;
      truncatedFiles += 1;
      continue;
    }
    let patch = "";
    try {
      if (file.status === "untracked") {
        const text = readFileSync(join(worktreePath, file.path), "utf8");
        patch = text.split("\n").map((l, i, all) => (i === all.length - 1 && l === "" ? null : `+${l}`)).filter((l) => l !== null).join("\n");
        if (file.additions === null) file.additions = patch === "" ? 0 : patch.split("\n").length;
      } else {
        patch = git(worktreePath, ["diff", "-M", base, "--", file.path]);
      }
    } catch {
      patch = "";
    }
    if (patch.length > remaining) {
      file.patch = truncateMiddleChars(patch, remaining);
      file.truncated = true;
      truncatedFiles += 1;
      remaining = 0;
    } else {
      file.patch = patch;
      remaining -= patch.length;
    }
  }
  return { base_commit: base, head, files, total_files: files.length, truncated_files: truncatedFiles };
}

function statusWord(code) {
  switch (code[0]) {
    case "A": return "added";
    case "M": return "modified";
    case "D": return "deleted";
    case "R": return "renamed";
    case "C": return "copied";
    case "T": return "type-changed";
    default: return code;
  }
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

// How far the project has moved since the worktree was cut. Compared with
// the project directory's HEAD, which is the branch the main thread
// integrates on. contains_base false means the base was rewritten (an
// amend or a rebase on the main branch) and the count is of a history the
// base is not in; every git error is reported as null, never as 0.
export function baseBehind(projectRoot, baseCommit) {
  if (!projectRoot || !baseCommit || !existsSync(projectRoot)) return { behind: null, contains_base: null, ref: null };
  let ref = null;
  try {
    ref = git(projectRoot, ["symbolic-ref", "--short", "-q", "HEAD"]).trim() || "HEAD";
  } catch {
    ref = "HEAD";
  }
  try {
    const behind = Number(git(projectRoot, ["rev-list", "--count", `${baseCommit}..HEAD`]).trim());
    let containsBase = true;
    try {
      git(projectRoot, ["merge-base", "--is-ancestor", baseCommit, "HEAD"]);
    } catch (error) {
      if (error.status === 1) containsBase = false;
      else return { behind: null, contains_base: null, ref };
    }
    return { behind: Number.isFinite(behind) ? behind : null, contains_base: containsBase, ref };
  } catch {
    return { behind: null, contains_base: null, ref };
  }
}
