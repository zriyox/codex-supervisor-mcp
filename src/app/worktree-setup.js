import { newWorkerBranch } from "../domain/worker-branch.js";
import { gitBin, runGit } from "../infra/git.js";
import { worktreesDir } from "../infra/paths.js";
import { runToExit } from "../infra/process.js";
import { resolveWritableRoot } from "../infra/sandbox-roots.js";
import { isPidAlive } from "../infra/store/tasks.js";
import { DEFAULT_ACCEPTANCE_TIMEOUT_MS, runAcceptance } from "./acceptance.js";
import { WORKTREE_LOCK_TIMEOUT_MS } from "./run-state.js";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export function splitLines(buffer, chunk) {
  const next = buffer + chunk;
  const lines = next.split(/\r?\n/);
  return { lines: lines.slice(0, -1), rest: lines.at(-1) ?? "" };
}

export async function exists(path) {
  if (!path) return false;
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export function resolveCommit(cwd, ref) {
  return runGit(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { timeout: 15000, stderr: "ignore" });
}

export function invalidBaseRefError(cwd, baseRef) {
  const error = new Error(`workspace.base_ref "${baseRef}" does not resolve to a commit in ${cwd}`);
  error.code = "invalid_base_ref";
  return error;
}

// The worktree is cut from workspace.base_ref when given, else from the repository's
// HEAD. The resolved commit is recorded on the task: it is what
// readWorktreeChanges diffs against, so committed work stays visible. An
// explicit workspace.base_ref that does not resolve is an error, not a silent fallback
// to HEAD - the caller asked for a specific baseline for a reason.
export async function ensureWorktree(cwd, taskId, baseRef = null) {
  const taskWorktreeDir = join(worktreesDir, taskId);
  await mkdir(worktreesDir, { recursive: true });
  const gitDir = join(cwd, ".git");
  if (!(await exists(cwd)) || !(await exists(gitDir))) {
    if (baseRef) throw invalidBaseRefError(cwd, baseRef);
    return { path: null, baseCommit: null };
  }
  let baseCommit;
  try {
    baseCommit = resolveCommit(cwd, baseRef ?? "HEAD");
  } catch {
    if (baseRef) throw invalidBaseRefError(cwd, baseRef);
    return { path: null, baseCommit: null };
  }
  if (!baseCommit) {
    if (baseRef) throw invalidBaseRefError(cwd, baseRef);
    return { path: null, baseCommit: null };
  }
  try {
    await rm(taskWorktreeDir, { recursive: true, force: true });
    const branch = newWorkerBranch(taskId);
    await runToExit(gitBin(), ["-C", cwd, "worktree", "add", "--detach", taskWorktreeDir, baseCommit]);
    await runToExit(gitBin(), ["-C", taskWorktreeDir, "switch", "-c", branch]);
    return { path: taskWorktreeDir, baseCommit };
  } catch (error) {
    const failure = new Error(`could not create isolated worker checkout: ${error.message}`);
    failure.code = "worktree_creation_failed";
    throw failure;
  }
}

function insidePath(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export function normalizeWorkspaceSetup(value, projectRoot) {
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("workspace.setup must be an object");
  const links = (value.links ?? []).map((entry) => {
    if (!entry || typeof entry.path !== "string" || !entry.path.trim()
      || typeof entry.source !== "string" || !entry.source.trim()) throw new Error("workspace.setup.links requires path and source");
    const path = entry.path.trim();
    if (isAbsolute(path) || path.split(/[\\/]/).includes("..")) throw new Error(`workspace.setup link path must stay inside the worktree: ${path}`);
    return { path, source: resolve(projectRoot, entry.source.trim()) };
  });
  const commands = (value.commands ?? []).map((command) => String(command).trim()).filter(Boolean);
  if (links.length > 20 || commands.length > 20) throw new Error("workspace.setup accepts at most 20 links and 20 commands");
  const submodules = value.submodules === true;
  return links.length || submodules || commands.length ? { links, submodules, commands } : null;
}

const JS_DEPENDENCY_COMMAND = /(?:^|[\s"'/])(?:npm|pnpm|yarn|npx|vitest|jest|vue-tsc|tsc|eslint|oxlint|nuxi)(?:\s|$)/;

export function requireDependencySetup({ kind, projectRoot, setup, commands }) {
  if (kind !== "git_worktree" || setup || !existsSync(join(projectRoot, "package.json"))) return;
  const commandText = (commands ?? []).map((check) => typeof check === "string" ? check : check?.command).filter(Boolean).join("\n");
  if (!JS_DEPENDENCY_COMMAND.test(commandText)) return;
  const error = new Error("workspace_setup_required: this JavaScript acceptance uses local project tooling, but the new worktree has no node_modules or generated prepare files; pass workspace.setup with dependency links and prepare commands (the same setup must be used by preflight)");
  error.code = "workspace_setup_required";
  throw error;
}

export async function prepareWorktreeWorkspace(setup, projectRoot, worktreePath, taskId) {
  if (!setup) return;
  for (const link of setup.links) {
    if (!existsSync(link.source)) throw new Error(`workspace.setup link source does not exist: ${link.source}`);
    const destination = resolve(worktreePath, link.path);
    if (!insidePath(worktreePath, destination)) throw new Error(`workspace.setup link escapes the worktree: ${link.path}`);
    await mkdir(dirname(destination), { recursive: true });
    if (existsSync(destination)) {
      const existing = await lstat(destination);
      if (!existing.isSymbolicLink()) throw new Error(`workspace.setup link destination already exists: ${link.path}`);
      const [actual, expected] = await Promise.all([realpath(destination), realpath(link.source)]);
      if (actual !== expected) throw new Error(`workspace.setup link destination points elsewhere: ${link.path}`);
      continue;
    }
    const sourceInfo = await stat(link.source);
    await symlink(link.source, destination, process.platform === "win32" ? "junction" : sourceInfo.isDirectory() ? "dir" : "file");
    if (basename(link.path) === "node_modules" && sourceInfo.isDirectory()) {
      for (const name of [".vite", ".vite-temp", ".cache"]) await mkdir(join(link.source, name), { recursive: true });
    }
  }
  if (setup.submodules) {
    await runToExit(gitBin(), ["-c", "protocol.file.allow=always", "-C", worktreePath, "submodule", "update", "--init", "--recursive"]);
  }
  if (setup.commands.length) {
    const result = await runAcceptance(setup.commands, { cwd: worktreePath, taskId, timeoutMs: DEFAULT_ACCEPTANCE_TIMEOUT_MS });
    if (!result.passed) {
      const failing = result.checks.find((check) => !check.passed);
      throw new Error(`workspace.setup command failed: ${failing?.command ?? "unknown"}${failing?.output_tail ? `\n${failing.output_tail}` : ""}`);
    }
  }
}

export function workspaceSetupWriteRoots(record) {
  const roots = [];
  for (const link of record.workspace_metadata?.setup?.links ?? []) {
    const source = resolveWritableRoot(link.source);
    if (!source.error) roots.push(source.path);
    if (basename(link.path) !== "node_modules") continue;
    for (const name of [".vite", ".vite-temp", ".cache"]) {
      const candidate = resolveWritableRoot(join(link.source, name));
      if (!candidate.error) roots.push(candidate.path);
    }
  }
  return roots;
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

// A lock whose holder died would otherwise stay for good: nothing else
// removes it, and every later dispatch into that repository would time out.
// The holder writes its pid into the lock; a waiter that finds the pid dead
// takes the lock away by renaming it, which only one waiter can win.
const LOCK_UNCLAIMED_MS = 10000;

async function lockIsAbandoned(lockPath) {
  let owner;
  try {
    owner = Number(await readFile(join(lockPath, "owner"), "utf8"));
  } catch (error) {
    // Only a missing file means "not written yet"; anything else is a lock we cannot judge.
    if (error.code !== "ENOENT") return false;
    owner = 0;
  }
  if (owner) return !isPidAlive(owner);
  // No owner yet: either the holder is between mkdir and its write, or it
  // died there. Age tells them apart.
  const info = await stat(lockPath).catch(() => null);
  return Boolean(info) && Date.now() - info.mtimeMs > LOCK_UNCLAIMED_MS;
}

async function breakAbandonedLock(lockPath) {
  const aside = `${lockPath}.${process.pid}.${Date.now()}.stale`;
  try {
    await rename(lockPath, aside);
  } catch {
    return; // someone else broke it, or the holder released it
  }
  // Between the check and the rename another waiter may have broken the lock
  // and taken a fresh one, which is then what was moved. It goes back.
  if (!await lockIsAbandoned(aside)) {
    await rename(aside, lockPath).catch(() => {});
    return;
  }
  await rm(aside, { recursive: true, force: true }).catch(() => {});
}

export async function withWorktreeCreationLock(cwd, work) {
  const lockName = `create-${createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 24)}.lock`;
  const lockPath = join(worktreesDir, lockName);
  await mkdir(worktreesDir, { recursive: true });
  const deadline = Date.now() + WORKTREE_LOCK_TIMEOUT_MS;
  while (true) {
    try {
      await mkdir(lockPath);
      break;
    } catch (error) {
      if (error.code !== "EEXIST" || Date.now() >= deadline) throw new Error(`worktree creation lock timed out for ${cwd}`, { cause: error });
      if (await lockIsAbandoned(lockPath)) await breakAbandonedLock(lockPath);
      else await sleep(100);
    }
  }
  try {
    await writeFile(join(lockPath, "owner"), String(process.pid));
    return await work();
  } finally {
    await rm(lockPath, { recursive: true, force: true }).catch(() => {});
  }
}
