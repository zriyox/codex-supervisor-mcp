import "./compose.js";
import { readActiveTasks } from "../infra/store/tasks.js";
import { resolve, sep } from "node:path";

export function normalizeOwnedPaths(ownedPaths, projectRoot) {
  if (!Array.isArray(ownedPaths)) return [];
  return Array.from(new Set(ownedPaths.map((entry) => resolve(projectRoot, String(entry).trim()))));
}

function pathOverlaps(left, right) {
  // Windows paths are case-insensitive and may mix separators, so compare on a
  // normalized form there. macOS and Linux keep the exact previous comparison -
  // a backslash is a legal filename character on those platforms.
  const windows = process.platform === "win32";
  const normalize = (value) => (windows ? value.replace(/[\\/]+/g, sep).toLowerCase() : value);
  const mine = normalize(left);
  const theirs = normalize(right);
  if (mine === theirs) return true;
  const minePrefix = mine.endsWith(sep) ? mine : `${mine}${sep}`;
  const theirsPrefix = theirs.endsWith(sep) ? theirs : `${theirs}${sep}`;
  return minePrefix.startsWith(theirsPrefix) || theirsPrefix.startsWith(minePrefix);
}

// Two workers claiming overlapping paths will collide when their branches are
// merged, so the second dispatch is refused before any worktree is created.
export async function findOwnershipConflicts(ownedPaths, { excludeTaskId = null } = {}) {
  if (!ownedPaths || ownedPaths.length === 0) return [];
  const activeTasks = await readActiveTasks();
  const conflicts = [];
  for (const task of activeTasks) {
    if (task.id === excludeTaskId) continue;
    const theirs = Array.isArray(task.owned_paths) ? task.owned_paths : [];
    const overlap = [];
    for (const mine of ownedPaths) {
      for (const other of theirs) {
        if (pathOverlaps(mine, other)) overlap.push({ incoming: mine, existing: other });
      }
    }
    if (overlap.length > 0) {
      conflicts.push({
        task_id: task.id,
        title: task.title,
        status: task.status,
        overlapping_paths: overlap
      });
    }
  }
  return conflicts;
}

export function ownershipConflictError(conflicts) {
  const owners = conflicts.map((conflict) => conflict.task_id).join(", ");
  const error = new Error(`ownedPaths overlap with active worker(s): ${owners}`);
  error.code = "ownership_conflict";
  error.conflicts = conflicts;
  return error;
}
