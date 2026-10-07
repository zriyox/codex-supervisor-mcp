// Keeps a global npm install current without anyone typing `npm i -g`.
//
// The server never blocks on this. When the update check says a newer
// version is published, a detached worker process (auto-update-worker.js)
// runs `npm install -g codex-supervisor-mcp@<that version>` and writes what
// happened to data/auto-update.json. The running server keeps its own
// already-loaded code; the next MCP session starts on the new files. This is
// the same shape as Claude Code's and opencode's updaters: check in the
// background, install in the background, take effect on the next launch.
//
// It only ever touches a copy that npm installed globally. A git checkout,
// an `npm link`, a project-local dependency and an npx cache copy are left
// alone, and the worker double-checks against `npm root -g` before writing.
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dataDir } from "./paths.js";

const PACKAGE_NAME = "codex-supervisor-mcp";
export const statePath = join(dataDir, "auto-update.json");
export const lockPath = join(dataDir, "auto-update.lock");
export const logPath = join(dataDir, "auto-update.log");
const workerEntry = join(dirname(fileURLToPath(import.meta.url)), "auto-update-worker.js");

export function autoUpdateDisabled(env = process.env) {
  return /^(1|true|yes)$/i.test(env.CODEX_SUPERVISOR_NO_AUTO_UPDATE?.trim() ?? "");
}

// Pure. The reason not to install, or null when an install should start.
export function autoUpdateBlocker(update, env = process.env) {
  if (!update) return "no update check result yet";
  if (autoUpdateDisabled(env)) return "disabled by CODEX_SUPERVISOR_NO_AUTO_UPDATE";
  if (env.CI) return "CI environment";
  if (update.disabled) return "update check is disabled";
  if (!update.update_available) return "already current";
  if (!update.latest?.version) return "registry gave no version";
  const source = update.installed?.source;
  if (source === "npx") return "started through npx, which fetches the latest version itself";
  if (source !== "npm") return `installed from ${source ?? "an unknown source"}, not a global npm install`;
  return null;
}

export async function readAutoUpdateState() {
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
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

// Launches the detached worker. Its stdio goes to a log file, not to the MCP
// transport: anything the updater prints on stdout would corrupt the protocol
// stream.
async function launchWorker({ version, packageRoot, registry }) {
  await mkdir(dataDir, { recursive: true });
  const args = [workerEntry, "--version", version, "--package-root", packageRoot];
  if (registry) args.push("--registry", registry);
  const log = openSync(logPath, "a");
  try {
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: ["ignore", log, log],
      env: { ...process.env, CODEX_SUPERVISOR_NO_AUTO_UPDATE: "1" },
      windowsHide: true
    });
    child.unref();
    return child.pid;
  } finally {
    closeSync(log);
  }
}

// Decides and, at most once per published version, starts the install.
// Returns the auto-update record to show in tool results:
//   { state: "started" | "running" | "done" | "failed" | "skipped", version, reason?, ... }
//
// Calls are serialised: the startup check and a forced check_for_update can
// finish in the same tick, and the second must see the record the first
// wrote rather than launch a worker of its own.
let queue = Promise.resolve();
export function maybeAutoUpdate(update, options = {}) {
  const next = queue.then(() => decide(update, options));
  queue = next.catch(() => {});
  return next;
}

async function decide(update, { env = process.env, launch = launchWorker } = {}) {
  const blocker = autoUpdateBlocker(update, env);
  if (blocker) return { state: "skipped", version: update?.latest?.version ?? null, reason: blocker };

  const version = update.latest.version;
  const prior = await readAutoUpdateState();
  const inFlight = prior && ["started", "running"].includes(prior.state) && processAlive(prior.pid);
  if (prior && prior.version === version) {
    // One attempt per published version: a finished record stands, a live
    // worker is left alone, a worker that died without a verdict gets one retry
    // per check.
    if (inFlight || ["done", "failed", "skipped"].includes(prior.state)) return prior;
  } else if (inFlight) {
    return { ...prior, reason: `an updater for ${prior.version} is still running` };
  }

  let record;
  try {
    const pid = await launch({
      version,
      packageRoot: update.installed.path,
      registry: env.CODEX_SUPERVISOR_REGISTRY?.trim() || null
    });
    record = { state: "started", version, pid, started_at: new Date().toISOString() };
  } catch (error) {
    record = { state: "failed", version, reason: `could not start the updater: ${error.message}` };
  }
  // Recorded by the server too, so ten servers starting together do not each
  // launch a worker (the worker's lock is the second line of defence).
  try {
    await mkdir(dataDir, { recursive: true });
    await writeFile(statePath, JSON.stringify({ ...record, updated_at: record.started_at ?? new Date().toISOString() }, null, 2));
  } catch {
    // the worker rewrites it anyway
  }
  return record;
}

// What a tool result says about it. Null when there is nothing worth a line.
export function autoUpdateSummary(record) {
  if (!record || record.state === "skipped") return null;
  const base = { state: record.state, version: record.version };
  if (record.reason) base.reason = record.reason;
  if (record.state === "done") base.installed_path = record.installed_path ?? null;
  return base;
}
