// Telling a long command from a silent model from a finished worker, from
// the wait snapshot alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { dispatchArgs, makeRepo, tempHome, waitFor, withMcp } from "./helpers.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("a worker stuck in a command shows the command and a growing idle", async () => {
  const home = await tempHome("supervisor-liveness-");
  const { dir } = await makeRepo(join(home, "repo"));
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "hang-in-command" }, async ({ call }) => {
    const created = await call("create_codex_worker", dispatchArgs("long-command", dir));
    await waitFor(call, created.id, (t) => t.phase === "command");
    await sleep(1100);
    const waited = await call("wait_codex_workers", { task_ids: [created.id], compact: true, timeoutMs: 1000 });
    const row = waited.workers[0];
    assert.equal(row.status, "running");
    assert.equal(row.command_running, true);
    assert.match(row.current_command, /sleep 3600/);
    assert.ok(row.idle_seconds >= 1, `idle_seconds is ${row.idle_seconds}`);
    const overview = await call("get_orchestration_overview", {});
    const line = overview.workers.find((w) => w.id === created.id);
    assert.equal(line.command_running, true);
    assert.ok(line.idle_seconds >= 1);
    await call("cancel_codex_worker", { task_id: created.id });
  });
});

test("a worker that is silent with no command running says so, and a finished one has no idle", async () => {
  const home = await tempHome("supervisor-liveness-");
  const { dir } = await makeRepo(join(home, "repo"));
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "hang" }, async ({ call }) => {
    const created = await call("create_codex_worker", dispatchArgs("silent", dir));
    await waitFor(call, created.id, (t) => t.phase === "thinking");
    await sleep(1100);
    const status = await call("get_codex_worker_status", { task_id: created.id });
    assert.equal(status.command_running, false);
    assert.equal(status.current_command, null);
    assert.ok(status.idle_seconds >= 1);
    assert.ok(status.last_event_at);
    await call("cancel_codex_worker", { task_id: created.id });
    const done = await waitFor(call, created.id, (t) => t.status === "cancelled");
    assert.equal(done.idle_seconds, null, "idle has no meaning on a terminal row");
    assert.equal(done.command_running, false);
  });
});

test("idle restarts when a worker is resumed, instead of counting from the old run", async () => {
  const home = await tempHome("supervisor-liveness-");
  const { dir } = await makeRepo(join(home, "repo"));
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "hang", FAKE_CODEX_STEP_MS: "3000" }, async ({ call }) => {
    const created = await call("create_codex_worker", dispatchArgs("resumed", dir));
    await waitFor(call, created.id, (t) => t.thread_id);
    await call("cancel_codex_worker", { task_id: created.id });
    await waitFor(call, created.id, (t) => t.status === "cancelled");
    await sleep(2500);
    const resumed = await call("resume_codex_worker", { task_id: created.id, prompt: "go on" });
    assert.equal(resumed.status, "running");
    const status = await call("get_codex_worker_status", { task_id: created.id });
    assert.ok(status.idle_seconds !== null && status.idle_seconds <= 1, `idle_seconds after resume is ${status.idle_seconds}`);
    await call("cancel_codex_worker", { task_id: created.id });
  });
});
