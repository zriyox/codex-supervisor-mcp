import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { dispatchArgs, tempHome, withMcp } from "./helpers.js";

test("wait sends progress over real MCP transport every 30 seconds", { timeout: 60000 }, async () => {
  const home = await tempHome("supervisor-progress-");
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "hang" }, async ({ call, client }) => {
    const worker = await call("create_codex_worker", dispatchArgs("progress", join(home, "workspace")));
    const notices = [];
    try {
      const result = await client.callTool({ name: "wait_codex_workers", arguments: {
        task_ids: [worker.id], timeoutMs: 35000, pollMs: 250, emitProgress: true
      } }, undefined, { timeout: 32000, resetTimeoutOnProgress: true, maxTotalTimeout: 50000,
        onprogress: (notice) => notices.push({ ...notice, received: Date.now() }) });
      const reply = JSON.parse(result.content[0].text);
      assert.equal(reply.timed_out, true);
      assert.equal(reply.termination_reason, "budget_exhausted");
      assert.ok(notices.length >= 2, "initial and periodic progress must reach the client");
      assert.ok(notices[1].received - notices[0].received >= 29000);
      assert.ok(notices[1].progress > notices[0].progress);
      assert.equal(reply.workers[0].status, "running", "a wait budget never stops the worker");
    } finally { await call("cancel_codex_worker", { task_id: worker.id }); }
  });
});

test("default wait has a one-minute budget and compact rows", async () => {
  const home = await tempHome("supervisor-wait-default-");
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const worker = await call("create_codex_worker", dispatchArgs("quick", join(home, "workspace")));
    const reply = await call("wait_codex_workers", { task_ids: [worker.id] });
    assert.equal(reply.timeout_ms, 60000);
    assert.equal(reply.termination_reason, "settled");
    assert.equal(reply.workers[0].goal_objective, undefined);
    assert.equal(reply.workers[0].exit_code, 0);
  });
});

test("wait is quiet by default and only emits progress when requested", { timeout: 20000 }, async () => {
  const home = await tempHome("supervisor-progress-quiet-");
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "hang" }, async ({ call, client }) => {
    const worker = await call("create_codex_worker", dispatchArgs("quiet progress", join(home, "workspace")));
    const notices = [];
    try {
      const result = await client.callTool({ name: "wait_codex_workers", arguments: {
        task_ids: [worker.id], timeoutMs: 5000, pollMs: 250
      } }, undefined, { timeout: 10000, onprogress: (notice) => notices.push(notice) });
      const reply = JSON.parse(result.content[0].text);
      assert.equal(reply.termination_reason, "budget_exhausted");
      assert.deepEqual(notices, []);
    } finally { await call("cancel_codex_worker", { task_id: worker.id }); }
  });
});
