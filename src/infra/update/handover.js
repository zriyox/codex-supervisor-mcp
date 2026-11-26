// This package was renamed to agent-supervisor-mcp. This is its last release
// under the old name, and its one job beyond working as before is to bring the
// machine over without anyone typing a command.
//
// At start-up, if this copy is a global npm install and the new package is
// not installed beside it, a detached worker runs
// `npm install -g agent-supervisor-mcp`. The new package's own install step
// then registers itself with the clients it finds, removes this package's
// registration and retires its skill. The session that is running keeps
// running; the next one starts on the new package. The state directory is
// not touched: the new package keeps using it.
//
// As with auto-update, only a copy npm installed globally is acted on. A
// checkout, an npx copy or a project dependency only gets the notice.
import { spawnProcess } from "../process.js";
import { closeSync, existsSync, openSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dataDir } from "../paths.js";
import { autoUpdateDisabled } from "./auto-update.js";

export const SUCCESSOR = "agent-supervisor-mcp";
export const handoverStatePath = join(dataDir, "handover.json");
const logPath = join(dataDir, "auto-update.log");
const workerEntry = join(dirname(fileURLToPath(import.meta.url)), "auto-update-worker.js");
const RETRY_AFTER_MS = 24 * 60 * 60 * 1000;
const MANUAL = `npm install -g ${SUCCESSOR}`;

// Pure. Why nothing is installed automatically, or null when it should be.
export function handoverBlocker(update, env = process.env) {
  if (!update) return "no update check result yet";
  if (update.disabled) return "update check is disabled";
  if (autoUpdateDisabled(env)) return "disabled by AGENT_SUPERVISOR_NO_AUTO_UPDATE";
  if (env.CI) return "CI environment";
  const source = update.installed?.source;
  if (source !== "npm") return `installed from ${source ?? "an unknown source"}, not a global npm install`;
  return null;
}

async function readState() {
  try {
    return JSON.parse(await readFile(handoverStatePath, "utf8"));
  } catch {
    return null;
  }
}

function processAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function launchWorker({ packageRoot, registry }) {
  await mkdir(dataDir, { recursive: true });
  const args = [workerEntry, "--successor", SUCCESSOR, "--package-root", packageRoot];
  if (registry) args.push("--registry", registry);
  const log = openSync(logPath, "a");
  try {
    const child = spawnProcess(process.execPath, args, {
      detached: true, stdio: ["ignore", log, log], env: { ...process.env, AGENT_SUPERVISOR_NO_AUTO_UPDATE: "1" }, windowsHide: true
    });
    child.unref();
    return child.pid;
  } finally {
    closeSync(log);
  }
}

// Returns the handover record: { state: "done" | "started" | "running" | "failed" | "skipped", reason? }.
let queue = Promise.resolve();
export function maybeHandOver(update, options = {}) {
  const next = queue.then(() => decide(update, options));
  queue = next.catch(() => {});
  return next;
}

async function decide(update, { env = process.env, launch = launchWorker, exists = existsSync } = {}) {
  const blocker = handoverBlocker(update, env);
  if (blocker) return { state: "skipped", reason: blocker };
  // npm puts global packages side by side.
  const successorRoot = join(dirname(update.installed.path), SUCCESSOR);
  if (exists(join(successorRoot, "package.json"))) return { state: "done", installed_path: successorRoot };

  const prior = await readState();
  if (prior && ["started", "running"].includes(prior.state) && processAlive(prior.pid)) return prior;
  const age = prior?.updated_at ? Date.now() - Date.parse(prior.updated_at) : Number.POSITIVE_INFINITY;
  // A failed attempt is not repeated on every start; once a day is enough to get past a registry outage.
  if (prior?.state === "failed" && age < RETRY_AFTER_MS) return prior;

  let record;
  try {
    const pid = await launch({ packageRoot: update.installed.path, registry: env.AGENT_SUPERVISOR_REGISTRY?.trim() || null });
    record = { state: "started", pid };
  } catch (error) {
    record = { state: "failed", reason: `could not start the installer: ${error.message}` };
  }
  try {
    await mkdir(dataDir, { recursive: true });
    await writeFile(handoverStatePath, JSON.stringify({ ...record, updated_at: new Date().toISOString() }, null, 2));
  } catch {
    // the worker rewrites it anyway
  }
  return record;
}

// What every tool result says about it. This package always has something to say.
export function handoverNotice(record) {
  const renamed = `codex-supervisor-mcp is now ${SUCCESSOR}`;
  if (record?.state === "done") {
    return { renamed_to: SUCCESSOR, state: "done",
      notice: `${renamed}, and it has been installed and registered. Start a new session (restart the MCP client) to use it; its tools are the same. Afterwards: npm uninstall -g codex-supervisor-mcp` };
  }
  if (record?.state === "started" || record?.state === "running") {
    return { renamed_to: SUCCESSOR, state: record.state, notice: `${renamed}. It is being installed in the background; the next session starts on it once the install finishes.` };
  }
  const why = record?.reason ? ` (not installed automatically: ${record.reason})` : "";
  return { renamed_to: SUCCESSOR, state: record?.state ?? "pending", install_command: MANUAL,
    notice: `${renamed}. This is the last release under the old name. Run \`${MANUAL}\` and restart the MCP client${why}.` };
}
