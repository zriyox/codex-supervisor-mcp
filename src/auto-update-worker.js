#!/usr/bin/env node
// The detached half of auto-update.js. Runs outside the MCP process so a
// session that ends mid-install does not leave npm half way through.
//
//   node auto-update-worker.js --version 0.7.0 --package-root <dir> [--registry <url>]
//
// Writes data/auto-update.json at every step so the server (and a human)
// can see what happened without a terminal: running -> done | failed | skipped.
import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { dataDir } from "./paths.js";
import { resolveCommand } from "./bin-resolver.js";

const run = promisify(execFile);
const PACKAGE_NAME = "codex-supervisor-mcp";
const statePath = join(dataDir, "auto-update.json");
const lockPath = join(dataDir, "auto-update.lock");
const LOCK_STALE_MS = 10 * 60 * 1000;
const NPM_TIMEOUT_MS = 10 * 60 * 1000;

function parseArgs(argv) {
  const options = { version: null, packageRoot: null, registry: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--version") options.version = argv[++index];
    else if (arg === "--package-root") options.packageRoot = argv[++index];
    else if (arg === "--registry") options.registry = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.version || !options.packageRoot) throw new Error("--version and --package-root are required");
  return options;
}

async function writeState(patch) {
  await mkdir(dataDir, { recursive: true });
  let current = {};
  try {
    current = JSON.parse(await readFile(statePath, "utf8"));
  } catch {
    // first write
  }
  const next = { ...current, ...patch, updated_at: new Date().toISOString() };
  await writeFile(statePath, JSON.stringify(next, null, 2));
  return next;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// One updater at a time. A lock whose process is gone, or that is older
// than LOCK_STALE_MS, is taken over.
async function acquireLock() {
  await mkdir(dataDir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
      await handle.close();
      return true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let holder = null;
      try {
        holder = JSON.parse(await readFile(lockPath, "utf8"));
      } catch {
        // unreadable lock counts as stale
      }
      const stale = !holder || !alive(holder.pid) || Date.now() - (holder.at ?? 0) > LOCK_STALE_MS;
      if (!stale) return false;
      await rm(lockPath, { force: true });
    }
  }
  return false;
}

// npm as `node npm-cli.js`: steps over the npm.cmd shim on Windows and uses
// the npm that belongs to the node running this server. CODEX_SUPERVISOR_NPM
// points at another npm-cli.js (or any executable) when that is wrong.
function npmCommand() {
  const override = process.env.CODEX_SUPERVISOR_NPM?.trim();
  if (override) {
    const target = resolveCommand(override);
    return [target.cmd, ...target.prefixArgs];
  }
  const nodeDir = dirname(process.execPath);
  const candidates = [
    join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js")
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found) return [process.execPath, found];
  const target = resolveCommand("npm", { npmEntry: { pkg: "npm", bin: "bin/npm-cli.js" } });
  return [target.cmd, ...target.prefixArgs];
}

async function npm(args, { registry, timeout = NPM_TIMEOUT_MS } = {}) {
  const [cmd, ...prefix] = npmCommand();
  const full = [...prefix, ...args, "--no-fund", "--no-audit", "--loglevel=error"];
  if (registry) full.push(`--registry=${registry}`);
  const env = { ...process.env, CODEX_SUPERVISOR_NO_AUTO_UPDATE: "1" };
  return run(cmd, full, { timeout, env, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
}

function samePath(a, b) {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const stamp = { version: options.version, pid: process.pid, started_at: new Date().toISOString() };

  if (!(await acquireLock())) {
    console.log(`auto-update: another updater holds ${lockPath}; leaving it to that one`);
    return 0;
  }
  try {
    await writeState({ ...stamp, state: "running", reason: null, installed_path: null, exit_code: null, log: null });

    const { stdout: rootOut } = await npm(["root", "-g"], { registry: options.registry, timeout: 60_000 });
    const globalRoot = rootOut.trim();
    const expected = join(globalRoot, PACKAGE_NAME);
    if (!samePath(expected, options.packageRoot)) {
      await writeState({
        state: "skipped",
        reason: `the running copy (${options.packageRoot}) is not npm's global install (${expected}); nothing was changed`
      });
      return 0;
    }

    let output = "";
    try {
      const result = await npm(["install", "-g", `${PACKAGE_NAME}@${options.version}`], { registry: options.registry });
      output = `${result.stdout}${result.stderr}`;
    } catch (error) {
      const tail = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim().split("\n").slice(-12).join("\n");
      await writeState({ state: "failed", reason: `npm install exited ${error.code ?? "?"}`, exit_code: error.code ?? null, log: tail });
      return 1;
    }

    let installed = null;
    try {
      installed = JSON.parse(readFileSync(join(expected, "package.json"), "utf8")).version;
    } catch {
      // verified below
    }
    if (installed !== options.version) {
      await writeState({
        state: "failed",
        reason: `npm reported success but ${expected} holds ${installed ?? "nothing"}, not ${options.version}`,
        exit_code: 0,
        log: output.trim().split("\n").slice(-12).join("\n")
      });
      return 1;
    }
    await writeState({ state: "done", reason: null, installed_path: expected, exit_code: 0, finished_at: new Date().toISOString() });
    console.log(`auto-update: installed ${PACKAGE_NAME}@${options.version} at ${expected}`);
    return 0;
  } finally {
    await rm(lockPath, { force: true });
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  try {
    await writeState({ state: "failed", reason: error.message });
  } catch {
    // nothing left to record to
  }
  console.error(`auto-update: ${error.message}`);
  process.exitCode = 1;
}
