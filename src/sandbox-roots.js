import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// A worker runs in Codex's workspace-write sandbox, which may write the
// worktree and the temp directory and nothing else. Every toolchain that keeps
// a build cache in the OS cache directory then dies on permissions before it
// runs any project code (Go's ~/Library/Caches/go-build on macOS is the one
// seen in practice). Naming one environment variable per language does not
// hold: the next language adds another name and another patch. The sandbox
// instead gets the OS cache directory itself as a writable root, which is
// where those default caches live on every platform.
export function cacheRoots({ env = process.env, platform = process.platform, home = homedir(), exists = existsSync } = {}) {
  const candidates = platform === "win32"
    ? [env.LOCALAPPDATA]
    : [env.XDG_CACHE_HOME, platform === "darwin" ? join(home, "Library", "Caches") : null, join(home, ".cache")];
  return [...new Set(candidates.map((dir) => dir?.trim()).filter(Boolean))].filter((dir) => exists(dir));
}
