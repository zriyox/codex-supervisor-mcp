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
    const created = await call("create_worker", dispatchArgs("gateway-down", repo));
    const done = await waitFor(call, created.id, (t) => ["failed", "lost", "completed"].includes(t.status) && t.exit_code !== null);
    assert.equal(done.status, "failed", JSON.stringify(done).slice(0, 300));
    assert.equal(done.exit_code, 1);
    assert.equal(typeof done.error, "string");
    assert.match(done.error, /502 Bad Gateway/);
    assert.match(done.notices ?? "", /Reconnecting/, "the retry notice is kept as a notice");
    const waited = await call("wait_workers", { task_ids: [created.id], timeout_ms: 2000 });
    assert.equal(waited.failed_count, 1);
    assert.equal(waited.lost_count, 0);
  });
});

test("the last JSONL event without a newline is drained before classifying the run", async () => {
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "last-line-no-newline" }, async ({ call }) => {
    const worker = await call("create_worker", dispatchArgs("last-line", repo));
    const done = await waitFor(call, worker.id, (t) => t.exit_code !== null);
    assert.equal(done.status, "failed");
    assert.match(done.error, /last line failure/);
    assert.equal(done.exit_code, 0);
  });
});

test("zero exit without a terminal event is lost, not successful completion", async () => {
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "zero-without-terminal" }, async ({ call }) => {
    const worker = await call("create_worker", dispatchArgs("no-terminal", repo));
    const done = await waitFor(call, worker.id, (t) => t.exit_code !== null);
    assert.equal(done.status, "lost");
    assert.match(done.error, /terminal event/);
    assert.doesNotMatch(done.error, /signal null/);
  });
});

// A failed worker's row carries the worker's own error text. Reading it is a
// successful call; only a read that cannot be answered is a failed one.
test("reading a failed worker is not a failed call, in one part or several", async () => {
  const home = await tempHome("supervisor-read-failed-");
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "turn-failed" }, async ({ call, client }) => {
    const worker = await call("create_worker", dispatchArgs("fails", join(home, "workspace")));
    await waitFor(call, worker.id, (task) => task.status === "failed" && task.exit_code !== null);
    const read = (args) => client.callTool({ name: "get_worker", arguments: { task_id: worker.id, ...args } });
    for (const args of [{}, { include: ["status"] }, { include: ["result"] }]) {
      const reply = await read(args);
      assert.notEqual(reply.isError, true, JSON.stringify(args));
      assert.ok(JSON.parse(reply.content[0].text).error, "the worker's error text is in the row");
    }
    const several = await read({ include: ["result", "goal", "events"] });
    assert.notEqual(several.isError, true);
    assert.deepEqual(Object.keys(JSON.parse(several.content[0].text)).sort(), ["events", "goal", "result", "task_id"]);
    const missing = await client.callTool({ name: "get_worker", arguments: { task_id: "no-such-worker", include: ["status"] } });
    assert.equal(missing.isError, true);
    assert.equal(JSON.parse(missing.content[0].text).error, "task_not_found");
  });
});
