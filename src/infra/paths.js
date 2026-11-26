import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// Runtime state root, one stable directory wherever npm put the package.
// Override with SUPERVISOR_HOME.
//
// The package used to be codex-supervisor-mcp and kept its state in
// ~/.codex-supervisor. A machine that has that directory keeps using it:
// worktrees are registered in each repository by absolute path, so moving or
// copying the directory would orphan them. Only a machine without it starts in
// ~/.agent-supervisor.
export function defaultSupervisorRoot(home = homedir(), exists = existsSync) {
  const legacy = join(home, ".codex-supervisor");
  return exists(legacy) ? legacy : join(home, ".agent-supervisor");
}

export const supervisorRoot = resolve(process.env.SUPERVISOR_HOME?.trim() || defaultSupervisorRoot());

// Codex's own home, used to read native thread goals. Read-only.
// Override with CODEX_HOME.
export const codexHome = resolve(
  process.env.CODEX_HOME?.trim() || join(homedir(), ".codex")
);

export const goalsDbPath = join(codexHome, "goals_1.sqlite");

export const dataDir = join(supervisorRoot, "data");
export const dbPath = join(dataDir, "supervisor.sqlite");
export const runsDir = join(dataDir, "runs");
export const artifactsDir = join(dataDir, "artifacts");
export const stagesDir = join(dataDir, "stages");
export const worktreesDir = join(supervisorRoot, "worktrees");
export const scratchDir = join(supervisorRoot, "scratch");
