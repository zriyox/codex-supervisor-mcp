// This is the last release under the old name. What the MCP client sees in
// every result, whatever the registry says, is where the package went.
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
          if (update.renamed_to || update.checked !== "pending") break;
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

const SUCCESSOR = "agent-supervisor-mcp";

for (const [name, latest] of [["a newer release exists", "9.9.9"], ["this release is current", packageVersion], ["the registry is down", "500"]]) {
  test(`${name}: the table, the receipt and the wait all say the package was renamed`, async () => {
    await serverWithRegistry(latest, async ({ call, home }) => {
      const overview = await call("poll_workers", {});
      assert.equal(overview.version, packageVersion);
      assert.equal(overview.update.renamed_to, SUCCESSOR);
      // The server under test runs from a checkout, which is told and never changed.
      assert.equal(overview.update.install_command, `npm install -g ${SUCCESSOR}`);
      assert.match(overview.update.notice, /codex-supervisor-mcp is now agent-supervisor-mcp/);

      const created = await call("create_worker", dispatchArgs("notice", join(home, "workspace")));
      assert.ok(created.id, JSON.stringify(created));
      assert.equal(created.update?.renamed_to, SUCCESSOR, "the dispatch receipt must say it");
      const waited = await call("wait_workers", { task_ids: [created.id], timeout_ms: 10000 });
      assert.equal(waited.update?.renamed_to, SUCCESSOR, "the wait response must say it");
    });
  });
}
