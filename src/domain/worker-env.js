import { delimiter, dirname } from "node:path";

// Codex may wrap a shell command as either `zsh -lc` or `zsh -c`. The latter
// does not load the user's login profile, so a Homebrew or version-manager
// Node directory can disappear even though the supervisor itself is running
// under that exact executable. Put the current Node directory first and keep
// the inherited PATH for every other toolchain.
export function withWorkerToolPath(env, execPath = process.execPath, pathDelimiter = delimiter) {
  const nodeDir = dirname(execPath);
  const inherited = env.PATH ?? env.Path ?? "";
  const parts = inherited.split(pathDelimiter).filter((part) => part && part !== nodeDir);
  const value = [nodeDir, ...parts].join(pathDelimiter);
  return { ...env, PATH: value, ...(process.platform === "win32" ? { Path: value } : {}) };
}
