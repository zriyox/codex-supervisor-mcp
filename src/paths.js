import { homedir } from "node:os";
import { join, resolve } from "node:path";

// Runtime state root. Defaults to ~/.codex-supervisor so a globally installed
// package keeps one stable data directory regardless of where npm put it.
// Override with SUPERVISOR_HOME.
export const supervisorRoot = resolve(
  process.env.SUPERVISOR_HOME?.trim() || join(homedir(), ".codex-supervisor")
);

export const dataDir = join(supervisorRoot, "data");
export const dbPath = join(dataDir, "supervisor.sqlite");
export const runsDir = join(dataDir, "runs");
export const worktreesDir = join(supervisorRoot, "worktrees");
