import { readdir } from "node:fs/promises";
import { supervisorRoot, worktreesDir } from "./paths.js";

const DEFAULT_THRESHOLD = 50;

export function cleanupThreshold(raw = process.env.SUPERVISOR_CLEANUP_HINT) {
  if (raw === undefined || raw === "") return DEFAULT_THRESHOLD;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_THRESHOLD;
}

// Safe worktrees are removed automatically, so a store that still holds this
// many has work that is being kept on purpose (unlanded and inside the hold
// period, or needing review) or has automatic cleanup switched off. The hint
// reports the count and where to look.
export async function cleanupHint({ list = readdir, root = supervisorRoot, dir = worktreesDir, threshold = cleanupThreshold() } = {}) {
  if (!threshold) return null;
  let entries;
  try { entries = (await list(dir)).length; } catch { return null; }
  if (entries < threshold) return null;
  return {
    worktrees: entries,
    threshold,
    command: `SUPERVISOR_HOME=${root} codex-supervisor-cleanup --dry-run`,
    apply: null,
    next_step: "Read the plan: REVIEW items say when they become removable. Land or resume the work you still want; cleanup (action apply) removes a SAFE item right away.",
    note: "a worktree is SAFE once its work has landed, or has nothing to keep, or its hold period is over; uncommitted edits are saved on the worker branch first, and branches and evidence are never removed"
  };
}
