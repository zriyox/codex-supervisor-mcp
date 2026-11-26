// The update notice as the MCP client sees it: in the overview always, in
// the dispatch receipt and the wait response only when there is news.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { dispatchArgs, fakeRegistry, packageVersion, tempHome, withMcp } from "./helpers.js";

async function serverWithRegistry(latest, fn) {
  const registry = await fakeRegistry(latest);
  const home = await tempHome("supervisor-mcp-update-");
  try {
    await withMcp(
      { SUPERVISOR_HOME: home, AGENT_SUPERVISOR_REGISTRY: registry.url, AGENT_SUPERVISOR_NO_UPDATE_CHECK: "", AGENT_SUPERVISOR_UPDATE_TIMEOUT_MS: "1500" },
      async (ctx) => {
        // The check starts with the server and runs in the background; the
        // table says "pending" until it has an answer.
        const deadline = Date.now() + 8000;
        for (;;) {
          const { update } = await ctx.call("poll_workers", {});
          if (update.update_available || update.checked !== "pending") break;
          assert.ok(Date.now() < deadline, "the update check never finished");
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        await fn({ ...ctx, home, registry });
      }
    );
  } finally {
    await registry.close();
  }
}

test("newer on the registry: overview, receipt and wait all carry the notice", async () => {
  await serverWithRegistry("9.9.9", async ({ call, home }) => {
    const overview = await call("poll_workers", {});
    assert.equal(overview.version, packageVersion);
    assert.equal(overview.update.update_available, true);
    assert.equal(overview.update.latest_version, "9.9.9");
    assert.match(overview.update.notice, /npm i -g codex-supervisor-mcp@latest/);

    const created = await call("create_worker", dispatchArgs("notice", join(home, "workspace")));
    assert.ok(created.id, JSON.stringify(created));
    assert.equal(created.update?.update_available, true, "the dispatch receipt must carry the notice");

    const waited = await call("wait_workers", { task_ids: [created.id], timeout_ms: 10000 });
    assert.equal(waited.update?.update_available, true, "the wait response must carry the notice");
  });
});

test("current: the overview says so and the other results stay clean", async () => {
  await serverWithRegistry(packageVersion, async ({ call, home }) => {
    const overview = await call("poll_workers", {});
    assert.equal(overview.update.update_available, false);
    assert.equal(overview.update.installed_version, packageVersion);
    const created = await call("create_worker", dispatchArgs("quiet", join(home, "workspace")));
    assert.equal("update" in created, false, "no notice when current");
    const waited = await call("wait_workers", { task_ids: [created.id], timeout_ms: 10000 });
    assert.equal("update" in waited, false);
  });
});

test("registry down: the server still answers everything and reports offline", async () => {
  await serverWithRegistry("500", async ({ call, home }) => {
    const overview = await call("poll_workers", {});
    assert.equal(overview.update.update_available, false);
    assert.equal(overview.update.checked, "offline");
    const created = await call("create_worker", dispatchArgs("offline", join(home, "workspace")));
    assert.ok(created.id);
  });
});
