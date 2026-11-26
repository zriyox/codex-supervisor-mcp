// The last release under the old name installs the renamed package in the
// background, once, and only over a copy npm installed globally.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tempHome } from "./helpers.js";

process.env.SUPERVISOR_HOME = await tempHome("supervisor-handover-");
const { handoverNotice, maybeHandOver, SUCCESSOR } = await import("../../src/infra/update/handover.js");
const globalCopy = { installed: { source: "npm", path: join("/usr/lib/node_modules", "codex-supervisor-mcp") } };

test("a global install starts the installer once and reports the new package once it is there", async () => {
  const launches = [];
  const launch = async (options) => { launches.push(options); return process.pid; };
  const first = await maybeHandOver(globalCopy, { env: {}, launch, exists: () => false });
  assert.equal(first.state, "started");
  assert.equal(launches[0].packageRoot, globalCopy.installed.path);
  // The recorded installer is still alive (this process stands in for it): no second one.
  const second = await maybeHandOver(globalCopy, { env: {}, launch, exists: () => false });
  assert.equal(second.state, "started");
  assert.equal(launches.length, 1);

  const beside = join("/usr/lib/node_modules", SUCCESSOR, "package.json");
  const done = await maybeHandOver(globalCopy, { env: {}, launch, exists: (path) => path === beside });
  assert.equal(done.state, "done");
  assert.equal(launches.length, 1);
  assert.match(handoverNotice(done).notice, /installed and registered.*new session/);
});

test("a checkout, an npx copy and an opted-out machine are told, not changed", async () => {
  const launch = async () => assert.fail("nothing may be installed here");
  for (const [update, env] of [
    [{ installed: { source: "git", path: "/work/checkout" } }, {}],
    [{ installed: { source: "npx", path: "/cache/npx/x" } }, {}],
    [globalCopy, { AGENT_SUPERVISOR_NO_AUTO_UPDATE: "1" }],
    [globalCopy, { CI: "true" }]
  ]) {
    const record = await maybeHandOver(update, { env, launch, exists: () => false });
    assert.equal(record.state, "skipped");
    const notice = handoverNotice(record);
    assert.equal(notice.install_command, `npm install -g ${SUCCESSOR}`);
    assert.match(notice.notice, /last release under the old name/);
  }
});
