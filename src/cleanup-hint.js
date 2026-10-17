import { readdir } from "node:fs/promises";
import { supervisorRoot, worktreesDir } from "./paths.js";

const DEFAULT_THRESHOLD = 50;

export function cleanupThreshold(raw = process.env.SUPERVISOR_CLEANUP_HINT) {
  if (raw === undefined || raw === "") return DEFAULT_THRESHOLD;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_THRESHOLD;
}

// A batch that never cleans up should say so instead of quietly growing to
// hundreds of worktrees. The hint only reports a count and the two commands;
// deletion stays a deliberate step, because cleanup only removes worktrees that
// are merged and clean and keeps dirty, unmerged, lost and failed work.
export async function cleanupHint({ list = readdir, root = supervisorRoot, dir = worktreesDir, threshold = cleanupThreshold() } = {}) {
  if (!threshold) return null;
  let entries;
  try { entries = (await list(dir)).length; } catch { return null; }
  if (entries < threshold) return null;
  return {
    worktrees: entries,
    threshold,
    command: `SUPERVISOR_HOME=${root} npm run cleanup -- --dry-run`,
    apply: `SUPERVISOR_HOME=${root} npm run cleanup -- --apply`,
    note: "only push-verified, clean worktrees become SAFE; apply retains branches and evidence"
  };
}

