// Landing a worker's commits where they were dispatched from.
//
// A worker's commits live on its own branch inside its own worktree. Getting that
// work onto the branch the main thread integrates on used to be the main
// thread's job, one cherry-pick per step, dozens of times per batch. This
// does the same thing with the same guard rails a careful person would use:
// the target must be clean, it is never switched to another branch, and a
// conflict leaves nothing half-applied.
import { findOutsideOwnedChanges } from "../domain/owned-changes.js";
import { runGit } from "../infra/git.js";
import { filterWorkspaceSetupChanges, parsePorcelainLine, readWorktreeChanges, readWorktreeDiff, resolveWorktreeBase, workspaceSetupIgnorePaths, worktreeRef } from "../infra/worktree.js";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";

const PATCH_ID_MAX_BUFFER = 256 * 1024 * 1024;

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
    name = runGit(cwd, ["config", "user.name"], { stderr: "ignore", timeout: 10000 });
  } catch {
    // unset
  }
  try {
    email = runGit(cwd, ["config", "user.email"], { stderr: "ignore", timeout: 10000 });
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

export function git(cwd, args, { timeout = 60000, input = null, maxBuffer = 1024 * 1024, encoding = "utf8" } = {}) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true", ...identityEnv(cwd) };
  return runGit(cwd, args, { timeout, input, maxBuffer, encoding, env, rawPaths: true, trim: false });
}

export function lines(output) {
  return output.split("\n").map((line) => line.trim()).filter(Boolean);
}

// Porcelain lines carry their status in the first two columns, so they must
// not be trimmed before parsing.
function porcelainPaths(output) {
  return output.split("\n").filter((line) => line.length > 3).map(parsePorcelainLine).filter(Boolean);
}

function patchIdsInRange(cwd, range) {
  const patches = git(cwd, ["log", "--no-merges", "--format=commit %H", "--patch", "--binary", range], {
    timeout: 2 * 60 * 1000,
    encoding: "buffer",
    maxBuffer: PATCH_ID_MAX_BUFFER
  });
  const output = git(cwd, ["patch-id", "--stable"], {
    input: patches,
    timeout: 2 * 60 * 1000,
    maxBuffer: PATCH_ID_MAX_BUFFER
  });
  const ids = new Map();
  for (const line of lines(output)) {
    const [id, sha] = line.split(/\s+/);
    if (id && sha && !/^0+$/.test(id)) ids.set(sha, id);
  }
  return ids;
}

// `git rev-list --cherry-pick` proves an original worker commit is not
// pending, but it does not name the target-side commit that carried the same
// patch. Lifecycle fields need that target-side SHA: using the target's
// current HEAD would point at unrelated later work and make cleanup/push
// verification lie.
function matchAlreadyLanded(cwd, target, targetHead, base, originals, workerHead) {
  if (originals.length === 0) return { matches: [], complete: true, head: null };
  const targetOrder = lines(git(target, ["rev-list", `${base}..${targetHead}`]));
  const targetCommits = new Set(targetOrder);
  const needsPatchIds = originals.some((original) => !targetCommits.has(original));
  const targetByPatch = new Map([...(needsPatchIds ? patchIdsInRange(target, `${base}..${targetHead}`) : [])]
    .map(([sha, id]) => [id, sha]));
  const originalPatches = needsPatchIds ? patchIdsInRange(cwd, `${base}..${workerHead}`) : new Map();
  const matches = originals.flatMap((original) => {
    if (targetCommits.has(original)) return [{ original, target: original }];
    const id = originalPatches.get(original);
    const matched = id ? targetByPatch.get(id) : null;
    return matched ? [{ original, target: matched }] : [];
  });
  const matchedTargets = new Set(matches.map((match) => match.target));
  const head = targetOrder.find((sha) => matchedTargets.has(sha)) ?? null;
  const complete = matches.length === originals.length && matches.every((match) => {
    if (match.target === head) return true;
    try { git(target, ["merge-base", "--is-ancestor", match.target, head]); return true; }
    catch { return false; }
  });
  return { matches, complete, head: complete ? head : null };
}

function currentBranch(cwd) {
  const name = git(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]).trim();
  return name || null;
}

function hasStagedChanges(cwd) {
  try {
    git(cwd, ["diff", "--cached", "--quiet"]);
    return false;
  } catch (error) {
    if (error.status === 1) return true;
    throw error;
  }
}

// Lands task's commits onto the current branch of its dispatch directory
// (task.project_root: the row's cwd is the worktree the worker ran in).
// `onto`, when given, must name that branch: it is a guard, not a switch.
//
// `commit_message` commits what the worker left uncommitted in its worktree
// first, as one commit on its branch. A worker in Codex's workspace-write
// sandbox cannot commit at all (the sandbox keeps .git read-only), so this
// is how "one step, one commit" is kept without giving workers full access.
//
// Returns { landed: [{ sha, original, subject }], onto, head } on success;
// otherwise { error, reason, ... } with nothing changed in the target.
// The dispatcher's own checks are the gate. A failed run is refused until
// it passes; a run that was cut short is refused until it has run.
function acceptanceRefusal(task) {
  const acceptance = task.acceptance_results ?? null;
  if (!acceptance) return null;
  const failing = (acceptance.checks ?? []).find((check) => check.passed === false || check.exit_code !== 0 || check.timed_out) ?? null;
  if (acceptance.passed === false) {
    return {
      error: "acceptance_failed",
      reason: `the worker's acceptance run failed${failing ? ` on "${failing.command.slice(0, 120)}" (exit ${failing.error ?? (failing.baseline?.passed === false ? "baseline/evidence mismatch" : failing.timed_out ? "timeout" : failing.exit_code)})` : acceptance.error ? ` (${acceptance.error})` : ""}; resume the worker with the failing output and land once it passes. ignore_acceptance: true lands anyway, only when the user said to.`,
      acceptance: { status: acceptance.status, passed: false, checks: acceptance.checks ?? [], error: acceptance.error ?? null }
    };
  }
  if (acceptance.status === "running" || acceptance.status === "interrupted" || acceptance.status === "cancelled") {
    return {
      error: "acceptance_not_run",
      reason: `the worker's acceptance is ${acceptance.status}; wait for it (or resume the worker to run it again) before landing. ignore_acceptance: true lands anyway, only when the user said to.`,
      acceptance: { status: acceptance.status, passed: null }
    };
  }
  return null;
}

// The integration checkout must exist, be on the expected branch and be clean.
function targetState(task, onto) {
  const target = task.project_root;
  if (!task.worktree_path || !existsSync(task.worktree_path)) {
    return { error: "no_worktree", reason: "this worker has no worktree (it ran in place), so there is no worker branch to land" };
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
  return { branch };
}

function ownershipRefusal(task) {
  const diff = readWorktreeDiff(task.worktree_path, worktreeRef(task), { maxChars: 0, ignorePaths: workspaceSetupIgnorePaths(task) });
  if (diff.error) return { error: "ownership_unverified", reason: "cannot prove the complete diff before landing", diff_error: diff.error };
  const paths = [...filterWorkspaceSetupChanges(task, readWorktreeChanges(task.worktree_path, worktreeRef(task))),
    ...diff.files.flatMap((file) => [file.path, file.from].filter(Boolean).map((path) => join(task.worktree_path, path)))];
  const { outside } = findOutsideOwnedChanges(task, [...new Set(paths)]);
  if (outside.length) return { error: "outside_owned_paths", reason: "worker changes exceed declared owned_paths; review them and obtain explicit authorization before allowing an exception", outside_paths: outside.map((entry) => relative(task.worktree_path, entry)) };
  return null;
}

// Commits the worker's uncommitted edits as one commit when a message is
// given. A workspace-write worker cannot commit: its sandbox keeps .git
// read-only.
function commitForWorker(task, commits, { commitMessage, allowOutsideOwned }) {
  let uncommitted = porcelainPaths(git(task.worktree_path, ["--no-optional-locks", "status", "--porcelain"]));
  let committedForWorker = null;
  if (uncommitted.length === 0 || !commitMessage) return { uncommitted, committedForWorker };
  try {
    if (allowOutsideOwned) git(task.worktree_path, ["add", "-A"]);
    else {
      const owned = findOutsideOwnedChanges(task, []).mapping.map((entry) => relative(task.worktree_path, entry.worker));
      if (owned.length === 0) return { error: "outside_owned_paths", reason: "the worker left uncommitted changes but owns no landable path" };
      git(task.worktree_path, ["add", "-A", "--", ...owned]);
    }
    if (hasStagedChanges(task.worktree_path)) {
      git(task.worktree_path, ["commit", "-q", "-m", commitMessage]);
      committedForWorker = git(task.worktree_path, ["rev-parse", "HEAD"]).trim();
      commits.push(committedForWorker);
    }
    uncommitted = porcelainPaths(git(task.worktree_path, ["--no-optional-locks", "status", "--porcelain"]));
  } catch (error) {
    const tail = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim().split("\n").slice(-3).join("\n");
    return { error: "commit_failed", reason: `could not commit the worker's uncommitted edits in ${task.worktree_path}: ${tail || error.message.split("\n")[0]}`, uncommitted };
  }
  return { uncommitted, committedForWorker };
}

// Commits whose patch is already on the target (a previous land, or the
// main thread cherry-picked by hand) are skipped by patch id; picking
// them again produces an empty commit and git stops with an error.
function splitAlreadyLanded(task, target, targetHead, base, commits) {
  const proof = { pending: commits, alreadyLanded: [], matches: [], matchedHead: null, matchComplete: true, matchError: null };
  if (commits.length === 0) return proof;
  try {
    const workerHead = git(task.worktree_path, ["rev-parse", "HEAD"]).trim();
    const pending = new Set(lines(git(target, ["rev-list", "--cherry-pick", "--right-only", `${targetHead}...${workerHead}`])));
    proof.alreadyLanded = commits.filter((sha) => !pending.has(sha));
    proof.pending = commits.filter((sha) => pending.has(sha));
    try {
      ({ matches: proof.matches, complete: proof.matchComplete, head: proof.matchedHead } = matchAlreadyLanded(
        task.worktree_path, target, targetHead, base, proof.alreadyLanded, workerHead
      ));
    } catch (error) {
      proof.matchComplete = false;
      proof.matchError = gitTail(error);
    }
  } catch (error) {
    return { error: "landing_proof_failed", reason: "could not prove which worker commits remain unlanded", match_error: gitTail(error) };
  }
  return proof;
}

function nothingToLand(proof, { branch, target, uncommitted, base }) {
  if (proof.pending.length > 0) return null;
  if (proof.alreadyLanded.length > 0) {
    return {
      error: "nothing_to_land",
      reason: `every commit on this worker's branch is already on ${branch} (landed before, by patch); nothing new to land`,
      already_landed: proof.alreadyLanded,
      already_landed_matches: proof.matches,
      matched_head: proof.matchedHead,
      match_error: proof.matchError,
      match_complete: proof.matchComplete,
      onto: branch,
      target,
      uncommitted,
      base_commit: base
    };
  }
  return {
    error: "nothing_to_land",
    reason: uncommitted.length > 0
      ? "the worker made no commits on its branch (a workspace-write worker cannot: the sandbox keeps .git read-only); pass commit_message to commit its edits as one commit and land that"
      : "the worker made no commits and left no edits on its branch",
    uncommitted,
    base_commit: base
  };
}

// Cherry-picks onto the target; a conflict aborts and leaves the target where it was.
function cherryPick(target, commits, { base, uncommitted }) {
  try {
    git(target, ["cherry-pick", "--allow-empty-message", ...commits], { timeout: 10 * 60 * 1000 });
    return null;
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
}

export function landWorker(task, { onto = null, commitMessage = null, ignoreAcceptance = false, allowOutsideOwned = false } = {}) {
  const target = task.project_root;
  const refused = ignoreAcceptance ? null : acceptanceRefusal(task);
  if (refused) return refused;
  const state = targetState(task, onto);
  if (state.error) return state;
  const { branch } = state;

  const base = resolveWorktreeBase(task.worktree_path, worktreeRef(task));
  if (!base) return { error: "no_base_commit", reason: "the commit this worker started from is unknown, so its commits cannot be told apart" };
  const outside = allowOutsideOwned ? null : ownershipRefusal(task);
  if (outside) return outside;
  let commits;
  try {
    commits = lines(git(task.worktree_path, ["rev-list", "--reverse", `${base}..HEAD`]));
  } catch (error) {
    return { error: "no_base_commit", reason: `the base ${base} no longer resolves in the worktree: ${error.message.split("\n")[0]}` };
  }
  const committed = commitForWorker(task, commits, { commitMessage, allowOutsideOwned });
  if (committed.error) return committed;
  const { uncommitted, committedForWorker } = committed;

  const targetHead = git(target, ["rev-parse", "HEAD"]).trim();
  const proof = splitAlreadyLanded(task, target, targetHead, base, commits);
  if (proof.error) return proof;
  const nothing = nothingToLand(proof, { branch, target, uncommitted, base });
  if (nothing) return nothing;
  const conflict = cherryPick(target, proof.pending, { base, uncommitted });
  if (conflict) return conflict;

  const landed = lines(git(target, ["rev-list", "--reverse", `${targetHead}..HEAD`]));
  const subjects = lines(git(target, ["log", "--format=%H%x09%s", `${targetHead}..HEAD`]));
  const subjectOf = new Map(subjects.map((line) => line.split("\t")).map(([sha, subject]) => [sha, subject]));
  return {
    onto: branch,
    target,
    base_commit: base,
    head: landed.at(-1) ?? targetHead,
    landed: landed.map((sha, index) => ({ sha, original: proof.pending[index] ?? null, subject: subjectOf.get(sha) ?? null })),
    already_landed: proof.alreadyLanded,
    already_landed_matches: proof.matches,
    match_error: proof.matchError,
    match_complete: proof.matchComplete,
    committed_for_worker: committedForWorker,
    uncommitted
  };
}

export function gitTail(error) {
  return `${error.stdout ?? ""}${error.stderr ?? ""}`.trim().split("\n").slice(-4).join("\n") || error.message.split("\n")[0];
}
