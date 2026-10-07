// Copies the bundled skill into the skill directories of the agent clients on
// this machine. setup.js runs it after a global install; mcp-server.js runs it
// every time the server starts, because a server launched through
// `npx -y codex-supervisor-mcp@latest` never runs postinstall, and the skill
// text has to move together with the tool surface it describes.
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export const SKILL_NAME = "codex-supervisor";
export const skillSource = join(packageRoot, "skills", SKILL_NAME, "SKILL.md");

// Resolved on each call so a test can point HOME somewhere else first.
export function skillRoots() {
  const home = homedir();
  return {
    claude: { id: "claude", label: "Claude Code", skillRoot: join(home, ".claude", "skills") },
    agents: { id: "agents", label: "~/.agents", skillRoot: join(home, ".agents", "skills") },
    codex: { id: "codex", label: "Codex", skillRoot: join(home, ".codex", "skills") }
  };
}

// The skill is read by other processes at any moment, and the server that
// writes it may be killed at any moment: write beside it, then rename, so
// the file is always either the old text or the new one, never a torso.
async function writeAtomically(destination, text) {
  const staging = `${destination}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(staging, text);
  await rename(staging, destination);
}

// Writes the bundled skill under client.skillRoot. A file that differs is
// backed up as SKILL.md.bak-<timestamp> first unless options.force is set.
// Returns one of: unchanged, updated, installed, would-update, would-install.
export async function installSkill(client, options = {}, log = () => {}) {
  const destination = join(client.skillRoot, SKILL_NAME, "SKILL.md");
  const source = await readFile(skillSource, "utf8");

  if (existsSync(destination)) {
    const current = await readFile(destination, "utf8");
    if (current === source) {
      log(`skill   ${client.label}: up to date`);
      return "unchanged";
    }
    if (!options.force) {
      const backup = `${destination}.bak-${Date.now()}`;
      if (options.dryRun) {
        log(`skill   ${client.label}: would back up to ${backup} and overwrite`);
        return "would-update";
      }
      await writeAtomically(backup, current);
    }
    if (options.dryRun) {
      log(`skill   ${client.label}: would overwrite`);
      return "would-update";
    }
    await writeAtomically(destination, source);
    log(`skill   ${client.label}: updated`);
    return "updated";
  }

  if (options.dryRun) {
    log(`skill   ${client.label}: would install to ${destination}`);
    return "would-install";
  }
  await mkdir(dirname(destination), { recursive: true });
  await writeAtomically(destination, source);
  log(`skill   ${client.label}: installed`);
  return "installed";
}

// Brings every client whose skill directory already exists up to date. It
// never creates a client's skill directory: a missing ~/.codex/skills means
// Codex is not used here. One client failing does not stop the others.
// Returns { installed, updated, unchanged, failed } as lists of client labels
// (failed entries carry the error message).
export async function syncSkills({ force = false } = {}) {
  const result = { installed: [], updated: [], unchanged: [], failed: [] };
  for (const client of Object.values(skillRoots())) {
    if (!existsSync(client.skillRoot)) continue;
    try {
      const outcome = await installSkill(client, { force });
      result[outcome].push(client.label);
    } catch (error) {
      result.failed.push(`${client.label}: ${error.message}`);
    }
  }
  return result;
}
