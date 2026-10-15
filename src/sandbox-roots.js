import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

// Codex 0.162 refuses a writable root that contains a symlink component: the
// worker does not merely lose that directory, every command in it fails with
// UnsupportedOperation("writable root ... contains symlink component ...").
// ~/.cache is a symlink on the machine this was found on, so every candidate is
// resolved to a symlink-free absolute path before the sandbox sees it, and a
// candidate that cannot be resolved that way is dropped instead of poisoning
// the whole run. allow_symlinked_codex_home does not help here: it only covers
// writable roots under CODEX_HOME.
export function symlinkComponents(target) {
  const links = [];
  let current = resolve(target);
  for (;;) {
    try { if (lstatSync(current).isSymbolicLink()) links.push(current); }
    catch { /* a missing component is reported by the caller */ }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return links;
}

export function resolveWritableRoot(candidate) {
  if (typeof candidate !== "string" || !candidate.trim()) return { error: "empty path" };
  if (!isAbsolute(candidate)) return { error: "not an absolute path" };
  let resolved;
  try { resolved = realpathSync(candidate.trim()); } catch { return { error: "does not exist" }; }
  try { if (!lstatSync(resolved).isDirectory()) return { error: "not a directory" }; } catch { return { error: "not a directory" }; }
  const links = symlinkComponents(resolved);
  if (links.length) return { error: "resolved path still contains a symlink component: " + links.join(", ") };
  return { path: resolved };
}

// The OS cache directory is where default build caches live on every platform:
// macOS ~/Library/Caches, Linux/XDG ~/.cache, Windows %LOCALAPPDATA%. It is
// offered to the sandbox as one generic root, so a new language needs no new
// environment variable and no patch.
export function cacheRoots({ env = process.env, platform = process.platform, home = homedir(), resolveRoot = resolveWritableRoot } = {}) {
  const candidates = platform === "win32"
    ? [env.LOCALAPPDATA]
    : [env.XDG_CACHE_HOME, platform === "darwin" ? join(home, "Library", "Caches") : null, join(home, ".cache")];
  const roots = [];
  for (const candidate of candidates) {
    if (!candidate?.trim()) continue;
    const resolved = resolveRoot(candidate.trim());
    if (resolved?.path) roots.push(resolved.path);
  }
  return [...new Set(roots)];
}

