#!/usr/bin/env node
import { rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { deleteTasks, readTasks, vacuumStore } from "./task-store.js";
import { runsDir, worktreesDir } from "./paths.js";
import { TERMINAL_STATUSES } from "./status.js";

function parseArgs(argv) {
  const options = {
    days: 14,
    dryRun: true,
    includeFailed: true,
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
    await stat(path);
    if (!dryRun) await rm(path, { force: true });
    return true;
  } catch {
    return false;
  }
}

async function safeDeleteDir(path, dryRun) {
  try {
    await stat(path);
    if (!dryRun) await rm(path, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  printHelp();
  process.exit(0);
}

const cutoffMs = Date.now() - options.days * 24 * 60 * 60 * 1000;
const tasks = await readTasks();
const candidates = tasks.filter((task) => isDeleteCandidate(task, cutoffMs, options.includeFailed));
const taskIds = candidates.map((task) => task.id);

const deleted = {
  tasks: taskIds.length,
  jsonl: 0,
  worktrees: 0
};

for (const task of candidates) {
  const logPath = task.run_log ?? join(runsDir, `${task.id}.jsonl`);
  if (await safeDeleteFile(logPath, options.dryRun)) deleted.jsonl += 1;
  if (task.worktree_path && basename(task.worktree_path) === task.id) {
    if (await safeDeleteDir(task.worktree_path, options.dryRun)) deleted.worktrees += 1;
  } else {
    const fallbackWorktree = join(worktreesDir, task.id);
    if (await safeDeleteDir(fallbackWorktree, options.dryRun)) deleted.worktrees += 1;
  }
}

if (!options.dryRun && taskIds.length > 0) {
  await deleteTasks(taskIds);
}

if (!options.dryRun && options.vacuum) {
  await vacuumStore();
}

console.log(JSON.stringify({
  dry_run: options.dryRun,
  keep_days: options.days,
  cutoff: new Date(cutoffMs).toISOString(),
  candidates: taskIds,
  deleted
}, null, 2));
