// Auto-update: when the server may start an install, that it starts at most
// one per published version, and that the detached worker installs only
// over npm's own global copy, holds a lock, and records every outcome.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { repoRoot, tempHome } from "./helpers.js";

const run = promisify(execFile);
const home = await tempHome("supervisor-autoupdate-");
process.env.SUPERVISOR_HOME = home;
delete process.env.CODEX_SUPERVISOR_NO_AUTO_UPDATE;
delete process.env.CI;
const { autoUpdateBlocker, maybeAutoUpdate, readAutoUpdateState, statePath, lockPath } = await import("../../src/auto-update.js");
const { installSource, isNpxPath, updateNotice } = await import("../../src/update-check.js");
const workerEntry = join(repoRoot, "src", "auto-update-worker.js");

const check = (over = {}) => ({
  update_available: true,
  disabled: false,
  installed: { version: "0.6.1", source: "npm", path: "/g/lib/node_modules/codex-supervisor-mcp", integrity: "sha512-x", commit: null },
  latest: { version: "0.7.0" },
  install_command: "npm i -g codex-supervisor-mcp@latest",
  notice: "codex-supervisor-mcp 0.6.1 is installed but 0.7.0 is published. Run `npm i -g codex-supervisor-mcp@latest` and restart the MCP client.",
  ...over
});

test("blocker: when an install must not start", () => {
  const env = {};
  assert.equal(autoUpdateBlocker(null, env), "no update check result yet");
  assert.match(autoUpdateBlocker(check(), { CODEX_SUPERVISOR_NO_AUTO_UPDATE: "1" }), /disabled/);
  assert.equal(autoUpdateBlocker(check(), { CI: "true" }), "CI environment");
  assert.equal(autoUpdateBlocker(check({ update_available: false }), env), "already current");
  assert.equal(autoUpdateBlocker(check({ disabled: true, update_available: false }), env), "update check is disabled");
  assert.match(autoUpdateBlocker(check({ installed: { ...check().installed, source: "git" } }), env), /installed from git/);
  assert.match(autoUpdateBlocker(check({ installed: { ...check().installed, source: "npx" } }), env), /npx/);
  assert.equal(autoUpdateBlocker(check(), env), null, "a global npm install with a newer version published may update");
});

test("where a copy came from: git checkout, npx cache, npm install, or unknown", () => {
  const none = { exists: () => false };
  assert.equal(installSource("/Users/z/Workspace/codex-supervisor-mcp", { exists: (p) => p.endsWith("/.git") }), "git");
  assert.equal(installSource("/Users/z/.npm/_npx/4431c98850c9db56/node_modules/codex-supervisor-mcp", none), "npx");
  assert.equal(installSource("/Users/admin/.npm-global/lib/node_modules/codex-supervisor-mcp", none), "npm", "a global install from a tarball has no lockfile entry but is still npm's");
  assert.equal(installSource("/Users/z/.nvm/versions/node/v22.22.2/lib/node_modules/codex-supervisor-mcp", none), "npm");
  assert.equal(installSource("/proj/node_modules/codex-supervisor-mcp", none), "npm", "project-local: the worker's npm root -g check keeps it from being touched");
  assert.equal(installSource("/opt/somewhere/codex-supervisor-mcp", none), "unknown");
});

test("npx cache copies are recognised by their path", () => {
  assert.equal(isNpxPath("/Users/z/.npm/_npx/4431c98850c9db56/node_modules/codex-supervisor-mcp"), true);
  assert.equal(isNpxPath("C:\\Users\\z\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules\\codex-supervisor-mcp"), true);
  assert.equal(isNpxPath("/g/lib/node_modules/codex-supervisor-mcp"), false);
});

test("maybeAutoUpdate launches once per version and records it", async () => {
  await rm(statePath, { force: true });
  const launches = [];
  const launch = async (args) => {
    launches.push(args);
    return process.pid; // "alive" for the duration of the test
  };
  const first = await maybeAutoUpdate(check(), { env: {}, launch });
  assert.equal(first.state, "started");
  assert.equal(first.version, "0.7.0");
  assert.deepEqual(launches, [{ version: "0.7.0", packageRoot: "/g/lib/node_modules/codex-supervisor-mcp", registry: null }]);
  assert.equal((await readAutoUpdateState()).state, "started", "the server records the launch itself");

  const second = await maybeAutoUpdate(check(), { env: {}, launch });
  assert.equal(second.state, "started");
  assert.equal(launches.length, 1, "a live updater for the same version is not launched again");

  const newer = await maybeAutoUpdate(check({ latest: { version: "0.7.1" } }), { env: {}, launch });
  assert.equal(launches.length, 1, "a newer version waits while an updater is still alive");
  assert.match(newer.reason, /still running/);

  await writeFile(statePath, JSON.stringify({ state: "done", version: "0.7.0", pid: 1, installed_path: "/g/x" }));
  const done = await maybeAutoUpdate(check(), { env: {}, launch });
  assert.equal(done.state, "done", "a finished record stands");
  assert.equal(launches.length, 1);

  await writeFile(statePath, JSON.stringify({ state: "failed", version: "0.7.0", pid: 1, reason: "boom" }));
  const failed = await maybeAutoUpdate(check(), { env: {}, launch });
  assert.equal(failed.state, "failed", "a failed version is not retried on every check");

  const next = await maybeAutoUpdate(check({ latest: { version: "0.7.1" } }), { env: {}, launch });
  assert.equal(next.state, "started");
  assert.equal(launches.length, 2, "a newer version after a failure is attempted");

  await writeFile(statePath, JSON.stringify({ state: "done", version: "0.7.1", pid: 1 }));
  const registry = await maybeAutoUpdate(check({ latest: { version: "0.7.2" } }), { env: { CODEX_SUPERVISOR_REGISTRY: "http://127.0.0.1:1/" }, launch });
  assert.equal(registry.state, "started");
  assert.equal(launches[2].registry, "http://127.0.0.1:1/", "a custom registry is handed to the worker");
});

test("two checks finishing together launch one worker", async () => {
  await rm(statePath, { force: true });
  let launches = 0;
  const launch = async () => {
    launches += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return process.pid;
  };
  const results = await Promise.all([
    maybeAutoUpdate(check({ latest: { version: "0.8.0" } }), { env: {}, launch }),
    maybeAutoUpdate(check({ latest: { version: "0.8.0" } }), { env: {}, launch }),
    maybeAutoUpdate(check({ latest: { version: "0.8.0" } }), { env: {}, launch })
  ]);
  assert.equal(launches, 1);
  assert.deepEqual(results.map((r) => r.state), ["started", "started", "started"]);
});

test("the notice tells the user to restart instead of to run npm once the install is under way", () => {
  const plain = updateNotice(check());
  assert.match(plain.notice, /npm i -g/);
  const started = updateNotice(check(), { state: "started", version: "0.7.0" });
  assert.equal(started.install_command, null);
  assert.match(started.notice, /being installed in the background/);
  assert.equal(started.auto_update.state, "started");
  const done = updateNotice(check(), { state: "done", version: "0.7.0" });
  assert.match(done.notice, /has been installed in the background/);
  assert.match(done.notice, /Start a new session/);
  const failed = updateNotice(check(), { state: "failed", version: "0.7.0", reason: "EACCES" });
  assert.match(failed.notice, /npm i -g/);
  assert.match(failed.notice, /automatic install failed: EACCES/);
  const other = updateNotice(check(), { state: "done", version: "0.6.9" });
  assert.equal(other.auto_update, undefined, "a record for another version says nothing");
  const npx = updateNotice(check({ installed: { ...check().installed, source: "npx" } }));
  assert.equal(npx.install_command, null);
  assert.match(npx.notice, /fetches the new one by itself/);
});

// A stand-in npm: `root -g` prints FAKE_GLOBAL_ROOT, `install -g name@ver`
// writes that version's package.json under it, or fails when FAKE_NPM_FAIL is set.
const FAKE_NPM = `#!/usr/bin/env node
const fs = require("node:fs"); const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "root") { process.stdout.write(process.env.FAKE_GLOBAL_ROOT + "\\n"); process.exit(0); }
if (args[0] === "install") {
  if (process.env.FAKE_NPM_FAIL) { process.stderr.write("npm error EACCES: permission denied\\n"); process.exit(243); }
  const [name, version] = args[2].split("@");
  const dir = path.join(process.env.FAKE_GLOBAL_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version }));
  process.exit(0);
}
process.exit(2);
`;

async function workerHost() {
  const root = join(home, `host-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const globalRoot = join(root, "lib", "node_modules");
  const installed = join(globalRoot, "codex-supervisor-mcp");
  await mkdir(installed, { recursive: true });
  await writeFile(join(installed, "package.json"), JSON.stringify({ name: "codex-supervisor-mcp", version: "0.6.1" }));
  const npm = join(root, "fake-npm.js");
  await writeFile(npm, FAKE_NPM);
  await chmod(npm, 0o755);
  return { root, globalRoot, installed, npm, log: join(root, "npm-calls.log") };
}

function runWorker(host, args, extraEnv = {}) {
  return run(process.execPath, [workerEntry, ...args], {
    env: {
      ...process.env,
      SUPERVISOR_HOME: home,
      CODEX_SUPERVISOR_NPM: host.npm,
      FAKE_GLOBAL_ROOT: host.globalRoot,
      FAKE_NPM_LOG: host.log,
      ...extraEnv
    }
  }).then(
    (result) => ({ ...result, code: 0 }),
    (error) => ({ stdout: error.stdout, stderr: error.stderr, code: error.code })
  );
}

const calls = async (host) =>
  (await readFile(host.log, "utf8").catch(() => ""))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

test("worker: installs the exact version over npm's global copy and records done", async () => {
  await rm(statePath, { force: true });
  await rm(lockPath, { force: true });
  const host = await workerHost();
  const result = await runWorker(host, ["--version", "0.7.0", "--package-root", host.installed, "--registry", "http://127.0.0.1:1/"]);
  assert.equal(result.code, 0, result.stderr);
  const state = await readAutoUpdateState();
  assert.equal(state.state, "done", JSON.stringify(state));
  assert.equal(state.version, "0.7.0");
  assert.equal(state.installed_path, host.installed);
  assert.equal(JSON.parse(await readFile(join(host.installed, "package.json"), "utf8")).version, "0.7.0");
  const seen = await calls(host);
  assert.deepEqual(seen[0].slice(0, 2), ["root", "-g"]);
  assert.deepEqual(seen[1].slice(0, 3), ["install", "-g", "codex-supervisor-mcp@0.7.0"], "pinned to the version the check saw, not to latest");
  assert.ok(seen[1].includes("--registry=http://127.0.0.1:1/"), "the registry override reaches npm");
  assert.equal(await readFile(lockPath, "utf8").catch(() => null), null, "the lock is released");
});

test("worker: a copy that is not npm's global install is left alone", async () => {
  await rm(statePath, { force: true });
  const host = await workerHost();
  const elsewhere = join(host.root, "checkout");
  await mkdir(elsewhere, { recursive: true });
  const result = await runWorker(host, ["--version", "0.7.0", "--package-root", elsewhere]);
  assert.equal(result.code, 0, result.stderr);
  const state = await readAutoUpdateState();
  assert.equal(state.state, "skipped");
  assert.match(state.reason, /not npm's global install/);
  assert.equal((await calls(host)).length, 1, "only `npm root -g` ran; nothing was installed");
  assert.equal(JSON.parse(await readFile(join(host.installed, "package.json"), "utf8")).version, "0.6.1");
});

test("worker: a failing npm install is recorded with npm's last lines", async () => {
  await rm(statePath, { force: true });
  const host = await workerHost();
  const result = await runWorker(host, ["--version", "0.7.0", "--package-root", host.installed], { FAKE_NPM_FAIL: "1" });
  assert.equal(result.code, 1);
  const state = await readAutoUpdateState();
  assert.equal(state.state, "failed");
  assert.match(state.reason, /npm install exited 243/);
  assert.match(state.log, /EACCES/);
  assert.equal(await readFile(lockPath, "utf8").catch(() => null), null, "the lock is released after a failure too");
});

test("worker: a live lock holder wins, a dead one is taken over", async () => {
  await rm(statePath, { force: true });
  const host = await workerHost();
  await mkdir(join(home, "data"), { recursive: true });
  await writeFile(lockPath, JSON.stringify({ pid: process.pid, at: Date.now() }));
  const held = await runWorker(host, ["--version", "0.7.0", "--package-root", host.installed]);
  assert.equal(held.code, 0);
  assert.match(held.stdout, /another updater holds/);
  assert.equal(await readAutoUpdateState(), null, "nothing recorded while another updater runs");
  assert.equal((await calls(host)).length, 0);

  await writeFile(lockPath, JSON.stringify({ pid: 999999, at: Date.now() }));
  const taken = await runWorker(host, ["--version", "0.7.0", "--package-root", host.installed]);
  assert.equal(taken.code, 0, taken.stderr);
  assert.equal((await readAutoUpdateState()).state, "done");
});
