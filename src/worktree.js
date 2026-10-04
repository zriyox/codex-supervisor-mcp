// Ground truth for "what did this worker change".
//
// Codex reports edits as file_change items only when it uses its own patch
// tool. A worker that edits through shell commands produces no such item, so
// the worktree itself is the authoritative source: every worker gets its own
// checkout, so `git status` inside it is exactly that worker's diff.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const defaultGitBin = process.env.GIT_BIN?.trim() || "git";

function parsePorcelainLine(line) {
  // " M path", "?? path", "R  old -> new"
  const trimmed = line.replace(/\s+$/, "");
  if (trimmed.length < 4) return null;
  let rest = trimmed.slice(3);
  const arrow = rest.indexOf(" -> ");
  if (arrow !== -1) rest = rest.slice(arrow + 4);
  if (rest.startsWith('"') && rest.endsWith('"')) rest = rest.slice(1, -1);
  return rest.trim() || null;
}

export function readWorktreeChanges(worktreePath) {
  if (!worktreePath || !existsSync(worktreePath)) return [];
  try {
    const output = execFileSync(defaultGitBin, ["-C", worktreePath, "status", "--porcelain"], {
      encoding: "utf8",
      timeout: 15000,
      stdio: ["ignore", "pipe", "ignore"]
    });
    const relative = output
      .split("\n")
      .map(parsePorcelainLine)
      .filter(Boolean);
    return Array.from(new Set(relative.map((entry) => join(worktreePath, entry))));
  } catch {
    return [];
  }
}

export function mergeChangedFiles(existing, discovered) {
  return Array.from(new Set([...(existing ?? []), ...(discovered ?? [])]));
}
