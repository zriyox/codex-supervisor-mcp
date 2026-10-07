// A worker whose turn fails (model gateway down) is reported as failed with
// the gateway's message, not as lost. Codex writes the error as an object;
// stored unconverted it broke the row update and the worker fell through to
// lost once its process was gone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { dispatchArgs, makeRepo, tempHome, waitFor, withMcp } from "./helpers.js";

const home = await tempHome("supervisor-turnfailed-");
const { dir: repo } = await makeRepo(join(home, "repo"));

test("turn.failed with an object error lands as failed, with the message as text", async () => {
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "turn-failed" }, async ({ call }) => {
    const created = await call("create_codex_worker", dispatchArgs("gateway-down", repo));
    const done = await waitFor(call, created.id, (t) => ["failed", "lost", "completed"].includes(t.status) && t.exit_code !== null);
    assert.equal(done.status, "failed", JSON.stringify(done).slice(0, 300));
    assert.equal(done.exit_code, 1);
    assert.equal(typeof done.error, "string");
    assert.match(done.error, /502 Bad Gateway/);
    assert.match(done.notices ?? "", /Reconnecting/, "the retry notice is kept as a notice");
    const waited = await call("wait_codex_workers", { task_ids: [created.id], timeoutMs: 2000 });
    assert.equal(waited.failed_count, 1);
    assert.equal(waited.lost_count, 0);
  });
});
