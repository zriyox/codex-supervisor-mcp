import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { dispatchArgs, tempHome, withMcp, listWorkers } from "./helpers.js";

test("wait sends progress over real MCP transport every 30 seconds", { timeout: 60000 }, async () => {
  const home = await tempHome("supervisor-progress-");
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "hang" }, async ({ call, client }) => {
    const worker = await call("create_worker", dispatchArgs("progress", join(home, "workspace")));
    const notices = [];
    try {
      const result = await client.callTool({ name: "wait_workers", arguments: {
        task_ids: [worker.id], timeout_ms: 35000, poll_ms: 250, emit_progress: true
      } }, undefined, { timeout: 32000, resetTimeoutOnProgress: true, maxTotalTimeout: 50000,
        onprogress: (notice) => notices.push({ ...notice, received: Date.now() }) });
      const reply = JSON.parse(result.content[0].text);
      assert.equal(reply.timed_out, true);
      assert.equal(reply.termination_reason, "budget_exhausted");
      assert.ok(notices.length >= 2, "initial and periodic progress must reach the client");
      assert.ok(notices[1].received - notices[0].received >= 29000);
      assert.ok(notices[1].progress > notices[0].progress);
      assert.equal(reply.workers[0].status, "running", "a wait budget never stops the worker");
    } finally { await call("cancel_worker", { task_id: worker.id }); }
  });
});

test("default wait has a one-minute budget and compact rows", async () => {
  const home = await tempHome("supervisor-wait-default-");
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const worker = await call("create_worker", dispatchArgs("quick", join(home, "workspace")));
    const reply = await call("wait_workers", { task_ids: [worker.id] });
    assert.equal(reply.timeout_ms, 60000);
    assert.equal(reply.termination_reason, "settled");
    assert.equal(reply.workers[0].goal_objective, undefined);
    assert.equal(reply.workers[0].exit_code, 0);
  });
});

test("long waits require an explicit client timeout opt-in", async () => {
  const home = await tempHome("supervisor-wait-client-limit-");
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const worker = await call("create_worker", dispatchArgs("quick", join(home, "workspace")));
    for (const budget of [{ timeout_ms: 15 * 60000 }, { timeout_ms: 900000 }]) {
      const bounded = await call("wait_workers", { task_ids: [worker.id], ...budget });
      assert.equal(bounded.timeout_ms, 60000);
      assert.equal(bounded.requested_timeout_ms, 900000);
      assert.equal(bounded.timeout_capped, true);
      assert.equal(bounded.termination_reason, "settled");
    }
    const extended = await call("wait_workers", {
      task_ids: [worker.id],
      timeout_ms: 900000,
      allow_long_wait: true
    });
    assert.equal(extended.timeout_ms, 900000);
    assert.equal(extended.timeout_capped, false);
    assert.equal(extended.workers[0].exit_code, 0);
    const short = await call("wait_workers", { task_ids: [worker.id], timeout_ms: 5000 });
    assert.equal(short.timeout_ms, 5000);
    assert.equal(short.timeout_capped, false);
  });
});

test("a long request returns within the capped budget while its worker stays active", { timeout: 110000 }, async () => {
  const home = await tempHome("supervisor-wait-capped-active-");
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "hang" }, async ({ call, client }) => {
    const worker = await call("create_worker", dispatchArgs("capped active", join(home, "workspace")));
    try {
      const result = await client.callTool({ name: "wait_workers", arguments: {
        task_ids: [worker.id], timeout_ms: 15 * 60000, poll_ms: 10000
      } }, undefined, { timeout: 80000 });
      const reply = JSON.parse(result.content[0].text);
      assert.equal(reply.requested_timeout_ms, 900000);
      assert.equal(reply.timeout_ms, 60000);
      assert.equal(reply.timeout_capped, true);
      assert.equal(reply.termination_reason, "budget_exhausted");
      assert.ok(reply.waited_ms >= 59000 && reply.waited_ms < 75000, JSON.stringify(reply));
      assert.equal(reply.workers[0].status, "running");
    } finally { await call("cancel_worker", { task_id: worker.id }); }
  });
});

test("a short wait does not sleep past its deadline when pollMs exceeds the budget", async () => {
  const home = await tempHome("supervisor-wait-poll-deadline-");
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    await listWorkers(call, { activeOnly: true });
    const reply = await call("wait_workers", { task_ids: ["missing"], timeout_ms: 1000, poll_ms: 10000 });
    assert.equal(reply.termination_reason, "budget_exhausted");
    assert.ok(reply.waited_ms >= 900 && reply.waited_ms < 8000, JSON.stringify(reply));
  });
});

test("wait is quiet by default and only emits progress when requested", { timeout: 20000 }, async () => {
  const home = await tempHome("supervisor-progress-quiet-");
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "hang" }, async ({ call, client }) => {
    const worker = await call("create_worker", dispatchArgs("quiet progress", join(home, "workspace")));
    const notices = [];
    try {
      const result = await client.callTool({ name: "wait_workers", arguments: {
        task_ids: [worker.id], timeout_ms: 5000, poll_ms: 250
      } }, undefined, { timeout: 10000, onprogress: (notice) => notices.push(notice) });
      const reply = JSON.parse(result.content[0].text);
      assert.equal(reply.termination_reason, "budget_exhausted");
      assert.deepEqual(notices, []);
    } finally { await call("cancel_worker", { task_id: worker.id }); }
  });
});

test("cancelling a wait leaves the worker active and allows another bounded read", { timeout: 30000 }, async () => {
  const home = await tempHome("supervisor-wait-client-cancel-");
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "hang" }, async ({ call, client }) => {
    const worker = await call("create_worker", dispatchArgs("cancel wait only", join(home, "workspace")));
    const controller = new AbortController();
    try {
      const pending = client.callTool({ name: "wait_workers", arguments: {
        task_ids: [worker.id], timeout_ms: 15 * 60000, poll_ms: 250, emit_progress: true
      } }, undefined, { timeout: 10000, signal: controller.signal, onprogress: () => controller.abort() });
      await assert.rejects(pending);
      const live = await call("get_worker", { task_id: worker.id, include: ["status"] });
      assert.equal(live.status, "running");
      const reply = await call("wait_workers", { task_ids: [worker.id], timeout_ms: 1000, poll_ms: 250 });
      assert.equal(reply.termination_reason, "budget_exhausted");
      assert.equal(reply.workers[0].status, "running");
    } finally { await call("cancel_worker", { task_id: worker.id }); }
  });
});
