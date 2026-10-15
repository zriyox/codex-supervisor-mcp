#!/usr/bin/env node
import { rm, lstat, realpath } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";
import { deleteTasks, readTasks, vacuumStore } from "./task-store.js";
import { runsDir, worktreesDir } from "./paths.js";
import { ACTIVE_STATUSES, TERMINAL_STATUSES } from "./status.js";

function parseArgs(argv) {
  const options = {
    days: 14,
    dryRun: true,
    includeFailed: true,
    keepRecords: false,
    vacuum: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--days") {
      options.days = Number(argv[index + 1]);
      index += 1;
    } else if (arg === "--apply") {
      options.dryRun = false;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--keep-failed") {
      options.includeFailed = false;
    } else if (arg === "--keep-records") {
      // Remove the directory and the branch, keep the task row and its run log:
      // the work is merged, but the ledger of what ran stays.
      options.keepRecords = true;
    } else if (arg === "--vacuum") {
      options.vacuum = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isFinite(options.days) || options.days < 0) {
    throw new Error("--days must be a non-negative number");
  }
  return options;
}

function printHelp() {
  console.log(`Usage: npm run cleanup -- [options]

Options:
  --dry-run          Show what would be deleted. Default.
  --apply            Actually delete matching rows, JSONL logs, and worktrees.
  --days <n>         Keep tasks newer than n days. Default: 14.
  --keep-failed      Preserve failed/cancelled tasks even when older than --days.
  --keep-records     Remove the worktree and branch but keep the task row and run log.
  --vacuum           Vacuum SQLite after deleting rows.
  -h, --help         Show help.
`);
}

function isTerminal(task) {
  return TERMINAL_STATUSES.has(task.status);
}

function isDeleteCandidate(task, cutoffMs, includeFailed) {
  if (!isTerminal(task)) return false;
  if (!includeFailed && ["failed", "cancelled", "lost"].includes(task.status)) return false;
  const completedAt = Date.parse(task.completed_at ?? task.updated_at ?? task.created_at);
  return Number.isFinite(completedAt) && completedAt < cutoffMs;
}

async function safeDeleteFile(path, dryRun) {
  try {
    const rel = relative(await realpath(runsDir), await realpath(path));
    if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) return false;
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) return false;
    if (!dryRun) await rm(path, { force: true });
    return true;
  } catch {
    return false;
  }
}

function git(cwd, args) {
  return execFileSync(process.env.GIT_BIN?.trim() || "git", ["--no-optional-locks", "-C", cwd, ...args], { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function cleanupReason(task, tasks) {
  if (task.status !== "completed") return "unfinished, failed or lost work is preserved";
  if (task.acceptance_results && task.acceptance_results.passed !== true) return "acceptance is not passed";
  if (tasks.some((other) => ACTIVE_STATUSES.has(other.status) && (other.depends_on ?? []).includes(task.id))) return "active dependent still needs this worktree";
  if (!task.worktree_path || !task.project_root) return "no registered isolated worktree";
  try {
    const path = resolve(task.worktree_path);
    if (path !== resolve(worktreesDir, task.id)) return "worktree is outside its managed task directory";
    if ((await lstat(path)).isSymbolicLink()) return "symlink worktree is preserved";
    if (await realpath(path) !== await realpath(resolve(worktreesDir, task.id))) return "unexpected worktree path";
    const branch = git(path, ["symbolic-ref", "--short", "HEAD"]);
    if (branch !== `codex/${task.id}`) return "unexpected branch ownership";
    const registrations = git(task.project_root, ["worktree", "list", "--porcelain", "-z"]).split("\0").filter((line) => line.startsWith("worktree "));
    let registered = false;
    for (const line of registrations) {
      if (await realpath(line.slice(9)) === await realpath(path)) registered = true;
    }
    if (!registered) return "worktree registration is missing";
    if (git(path, ["status", "--porcelain", "--untracked-files=all"])) return "dirty worktree contains uncommitted files";
    if (git(path, ["ls-files", "--others", "--ignored", "--exclude-standard"])) return "ignored artifacts are preserved";
    if (task.attention_reason) return `unresolved attention: ${task.attention_reason}`;
    if (task.externalOutputs?.length || task.run_evidence?.external_outputs?.length) return "shared output evidence is preserved";
    if (!task.landed_at || !task.base_commit) return "unlanded work is preserved";
    // Patch equivalence covers cherry-pick landing even when ancestry differs.
    const remaining = git(path, ["cherry", task.project_root ? git(task.project_root, ["rev-parse", "HEAD"]) : "HEAD", "HEAD", task.base_commit]);
    if (remaining.split("\n").some((line) => line.startsWith("+"))) return "unlanded commits remain";
    return null;
  } catch (error) {
    return `cleanup proof failed: ${error.message.split("\n")[0]}`;
  }
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  printHelp();
  process.exit(0);
}

const cutoffMs = Date.now() - options.days * 24 * 60 * 60 * 1000;
const tasks = await readTasks();
const candidates = [];
const skipped = [];
for (const task of tasks.filter((item) => isDeleteCandidate(item, cutoffMs, options.includeFailed))) {
  const reason = await cleanupReason(task, tasks);
  if (reason) skipped.push({ id: task.id, reason });
  else candidates.push(task);
}
const taskIds = candidates.map((task) => task.id);

const deleted = {
  tasks: 0,
  jsonl: 0,
  worktrees: 0
};

const removedIds = [];
for (const task of candidates) {
  if (!options.dryRun) {
    const current = (await readTasks()).find((item) => item.id === task.id);
    const reason = current ? await cleanupReason(current, await readTasks()) : "task disappeared";
    if (reason) { skipped.push({ id: task.id, reason }); continue; }
    try {
      git(task.project_root, ["worktree", "remove", task.worktree_path]);
      git(task.project_root, ["branch", "-D", `codex/${task.id}`]);
    } catch (error) {
      skipped.push({ id: task.id, reason: `git cleanup failed: ${error.message.split("\n")[0]}` });
      continue;
    }
  }
  deleted.worktrees += 1;
  const logPath = task.run_log ?? join(runsDir, `${task.id}.jsonl`);
  if (!options.keepRecords) {
    if (await safeDeleteFile(logPath, options.dryRun)) deleted.jsonl += 1;
    removedIds.push(task.id);
  }
}

if (!options.dryRun && !options.keepRecords && removedIds.length > 0) {
  await deleteTasks(removedIds);
}
deleted.tasks = removedIds.length;

if (!options.dryRun && options.vacuum) {
  await vacuumStore();
}

console.log(JSON.stringify({
  dry_run: options.dryRun,
  keep_days: options.days,
  records_kept: options.keepRecords,
  cutoff: new Date(cutoffMs).toISOString(),
  candidates: taskIds,
  skipped,
  deleted
}, null, 2));
