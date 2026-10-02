import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const supervisorRoot = dirname(dirname(fileURLToPath(import.meta.url)));
export const dataDir = join(supervisorRoot, "data");
export const dbPath = join(dataDir, "supervisor.sqlite");
export const runsDir = join(dataDir, "runs");
export const worktreesDir = join(supervisorRoot, "worktrees");
