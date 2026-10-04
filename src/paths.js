import { homedir } from "node:os";
import { join, resolve } from "node:path";

// Runtime state root. Defaults to ~/.codex-supervisor so a globally installed
// package keeps one stable data directory regardless of where npm put it.
// Override with SUPERVISOR_HOME.
export const supervisorRoot = resolve(
  process.env.SUPERVISOR_HOME?.trim() || join(homedir(), ".codex-supervisor")
);

// Codex's own home, used to read native thread goals. Read-only.
// Override with CODEX_HOME.
export const codexHome = resolve(
  process.env.CODEX_HOME?.trim() || join(homedir(), ".codex")
);

export const goalsDbPath = join(codexHome, "goals_1.sqlite");

export const dataDir = join(supervisorRoot, "data");
export const dbPath = join(dataDir, "supervisor.sqlite");
export const runsDir = join(dataDir, "runs");
export const worktreesDir = join(supervisorRoot, "worktrees");
