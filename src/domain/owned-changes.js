import path from "node:path";

// Ownership is declared relative to the project but edits live in the worker
// checkout. Segment comparisons reject sibling prefixes and parent traversal.
export function findOutsideOwnedChanges(task, changes, { platform = process.platform } = {}) {
  const p = platform === "win32" ? path.win32 : path.posix;
  const fold = (value) => platform === "win32" ? value.toLowerCase() : value;
  const root = p.resolve(task.project_root);
  const worktree = p.resolve(task.worktree_path ?? task.cwd ?? task.project_root);
  const within = (base, file) => {
    const rel = p.relative(fold(base), fold(file));
    return rel !== ".." && !rel.startsWith(`..${p.sep}`) && !p.isAbsolute(rel);
  };
  const mapping = (task.owned_paths ?? []).flatMap((entry) => {
    const absolute = p.resolve(root, entry);
    if (!within(root, absolute)) return [];
    return [{ declared: entry, worker: p.resolve(worktree, p.relative(root, absolute)) }];
  });
  const owned = [];
  const outside = [];
  for (const change of changes) {
    const absolute = p.resolve(worktree, change);
    const allowed = within(worktree, absolute) && mapping.some((entry) => within(entry.worker, absolute));
    (allowed ? owned : outside).push(change);
  }
  return { owned, outside, mapping };
}
