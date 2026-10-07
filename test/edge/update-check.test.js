// The update check against a registry that is newer, equal, older, down,
// slow, lying, or absent. It must never throw and must never claim an
// update it cannot prove.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { fakeRegistry, packageVersion, tempHome } from "./helpers.js";

const home = await tempHome("supervisor-update-");
process.env.SUPERVISOR_HOME = home;
process.env.CODEX_SUPERVISOR_UPDATE_TIMEOUT_MS = "400";
delete process.env.CODEX_SUPERVISOR_NO_UPDATE_CHECK;
const { checkForUpdate, compareVersions, evaluateUpdate, parseVersion, updateNotice, INSTALL_COMMAND } = await import("../../src/update-check.js");

let registry;
before(async () => {
  registry = await fakeRegistry("9.9.9");
  process.env.CODEX_SUPERVISOR_REGISTRY = registry.url;
});
after(async () => registry.close());

const clearCache = () => rm(join(home, "data", "update-check.json"), { force: true });
const bump = (v, by = 1) => {
  const [a, b, c] = v.split(".").map(Number);
  return `${a}.${b}.${c + by}`;
};

test("version parsing and ordering", () => {
  assert.deepEqual(parseVersion("v1.2.3").parts, [1, 2, 3]);
  assert.equal(parseVersion("garbage"), null);
  assert.equal(compareVersions("0.5.6", "0.5.7"), -1);
  assert.equal(compareVersions("0.10.0", "0.9.9"), 1);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("1.0.0-rc.1", "1.0.0"), -1, "a prerelease precedes its release");
  assert.equal(compareVersions("1.0.0", "1.0.0-rc.1"), 1);
  assert.equal(compareVersions("1.0.0", "nope"), null, "an unparsable side yields no verdict");
});

test("a newer published version is reported with the install command", async () => {
  await clearCache();
  const result = await checkForUpdate({ force: true });
  assert.equal(result.source, "registry");
  assert.equal(result.update_available, true);
  assert.equal(result.latest.version, "9.9.9");
  assert.equal(result.latest.integrity, "sha512-INTEGRITY-9.9.9");
  assert.equal(result.installed.version, packageVersion);
  assert.match(result.notice, /9\.9\.9/);
  assert.match(result.notice, /npm i -g codex-supervisor-mcp@latest/);
  assert.equal(result.install_command, INSTALL_COMMAND);
  const short = updateNotice(result);
  assert.equal(short.update_available, true);
  assert.equal(short.latest_version, "9.9.9");
});

test("the same version is current and the short notice is null", async () => {
  registry.state.plan = packageVersion;
  await clearCache();
  const result = await checkForUpdate({ force: true });
  assert.equal(result.update_available, false);
  assert.equal(result.notice, null);
  assert.equal(updateNotice(result), null, "nothing rides along in tool results when current");
});

test("a registry that is behind the local checkout does not ask for a downgrade", async () => {
  registry.state.plan = "0.0.1";
  await clearCache();
  const result = await checkForUpdate({ force: true });
  assert.equal(result.update_available, false);
  assert.equal(result.notice, null);
});

test("a prerelease on the registry does not beat the installed release", async () => {
  registry.state.plan = `${bump(packageVersion, 0)}-rc.1`;
  await clearCache();
  const result = await checkForUpdate({ force: true });
  assert.equal(result.update_available, false);
});

test("the second call within the hour comes from cache and does not hit the registry", async () => {
  registry.state.plan = bump(packageVersion);
  await clearCache();
  const fresh = await checkForUpdate({ force: true });
  assert.equal(fresh.source, "registry");
  const hitsBefore = registry.state.hits;
  const again = await checkForUpdate();
  assert.equal(again.source, "cache");
  assert.equal(again.update_available, true);
  assert.equal(registry.state.hits, hitsBefore, "cache hit must not call the registry");
});

test("a 500 from the registry falls back to the cached answer, then to offline", async () => {
  registry.state.plan = "500";
  const stale = await checkForUpdate({ force: true });
  assert.equal(stale.source, "stale-cache", "a cached answer beats no answer");
  assert.match(stale.error, /500/);
  await clearCache();
  const offline = await checkForUpdate({ force: true });
  assert.equal(offline.source, "offline");
  assert.equal(offline.update_available, false);
  assert.equal(offline.latest, null);
  assert.equal(offline.notice, null, "offline must not nag");
});

test("a registry that hangs is cut off by the timeout", async () => {
  registry.state.plan = "hang";
  await clearCache();
  const started = Date.now();
  const result = await checkForUpdate({ force: true });
  assert.equal(result.source, "offline");
  assert.ok(Date.now() - started < 3000, "the timeout has to fire well before the default 4s");
  assert.match(result.error, /abort/i);
});

test("a registry that returns garbage is treated as offline", async () => {
  registry.state.plan = "garbage";
  await clearCache();
  const result = await checkForUpdate({ force: true });
  assert.equal(result.source, "offline");
  assert.equal(result.update_available, false);
});

test("a registry reply without dist-tags is rejected, not trusted", async () => {
  registry.state.plan = (req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ name: "codex-supervisor-mcp", versions: {} }));
  };
  await clearCache();
  const result = await checkForUpdate({ force: true });
  assert.equal(result.source, "offline");
  assert.match(result.error, /dist-tags/);
});

test("integrity: a recorded install hash that differs from the published one is flagged", () => {
  const registryView = {
    latest: { version: "1.0.0", integrity: "sha512-A" },
    versions: { "1.0.0": { integrity: "sha512-A" } }
  };
  const good = evaluateUpdate({ version: "1.0.0", integrity: "sha512-A", commit: null, source: "npm", path: "/x" }, registryView, { source: "registry", error: null });
  assert.equal(good.integrity_matches, true);
  assert.equal(good.notice, null);
  const tampered = evaluateUpdate({ version: "1.0.0", integrity: "sha512-B", commit: null, source: "npm", path: "/x" }, registryView, { source: "registry", error: null });
  assert.equal(tampered.integrity_matches, false);
  assert.match(tampered.notice, /does not match the published tarball/);
  assert.equal(updateNotice(tampered).update_available, false, "a mismatch is not an update, it is a reinstall");
  const unknown = evaluateUpdate({ version: "1.0.0", integrity: null, commit: "abc", source: "git", path: "/x" }, registryView, { source: "registry", error: null });
  assert.equal(unknown.integrity_matches, null, "a git checkout has no tarball hash to compare");
});

test("disabled by environment: no network, no notice", async () => {
  registry.state.plan = "9.9.9";
  process.env.CODEX_SUPERVISOR_NO_UPDATE_CHECK = "1";
  const hits = registry.state.hits;
  const result = await checkForUpdate({ force: true });
  delete process.env.CODEX_SUPERVISOR_NO_UPDATE_CHECK;
  assert.equal(result.disabled, true);
  assert.equal(result.source, "disabled");
  assert.equal(result.update_available, false);
  assert.equal(registry.state.hits, hits);
});

test("concurrent calls share one registry request", async () => {
  registry.state.plan = "9.9.9";
  await clearCache();
  const hits = registry.state.hits;
  const results = await Promise.all([checkForUpdate({ force: true }), checkForUpdate({ force: true }), checkForUpdate({ force: true })]);
  assert.equal(registry.state.hits - hits, 1);
  for (const r of results) assert.equal(r.update_available, true);
});
