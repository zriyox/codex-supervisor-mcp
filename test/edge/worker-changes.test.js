import { test } from "node:test";
import assert from "node:assert/strict";
import { collectWorkerChanges } from "../../src/worker-changes.js";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dispatchArgs, tempHome, withMcp } from "./helpers.js";

const task = (extra = {}) => ({ id: "worker", status: "completed", exit_code: 0, run_count: 1, ...extra });

test("new completed work is delivered once and unchanged checks are quiet", () => {
  const first = collectWorkerChanges([task()], {});
  assert.equal(first.quiet, false);
  assert.equal(first.transitions[0].reason, "completed");
  assert.equal(collectWorkerChanges([task()], first.cursor).quiet, true);
});

test("an exit event without settled acceptance does not announce completion", () => {
  for (const worker of [task({ exit_code: null }), task({ acceptance_results: { run: 1, status: "running", passed: null } })]) {
    assert.equal(collectWorkerChanges([worker], {}).quiet, true);
  }
});

test("a new resumed run is distinct from the old completed run", () => {
  const first = collectWorkerChanges([task()], {});
  const active = collectWorkerChanges([task({ status: "running", exit_code: null, run_count: 2 })], first.cursor);
  assert.equal(active.quiet, true);
  const done = collectWorkerChanges([task({ run_count: 2 })], active.cursor);
  assert.equal(done.quiet, false);
});

test("goal and acceptance failures carry specific attention and next actions", () => {
  for (const [worker, reason] of [
    [task({ goal_status: "blocked" }), "goal_blocked"],
    [task({ goal_status: "paused" }), "goal_paused"],
    [task({ goal_status: "usage_limited" }), "goal_usage_limited"],
    [task({ goal_status: "budgetLimited" }), "goal_budgetLimited"],
    [task({ acceptance_results: { status: "failed", passed: false, run: 1 } }), "acceptance_failed"],
    [task({ status: "lost" }), "lost"]
  ]) {
    const result = collectWorkerChanges([worker], {});
    assert.equal(result.attention[0].reason, reason);
    assert.ok(result.attention[0].next_step.tool);
  }
});

test("observers own independent cursors and old acceptance is not a current verdict", () => {
  const work = task({ status: "running", run_count: 2, exit_code: null, acceptance_results: { run: 1, status: "failed", passed: false } });
  assert.equal(collectWorkerChanges([work], {}).quiet, true);
  assert.equal(collectWorkerChanges([task()], {}).quiet, false);
  assert.equal(collectWorkerChanges([task()], {}).quiet, false);
});

test("active long threads generate one attention reminder without hiding later completion", () => {
  const original = process.env.CODEX_SUPERVISOR_HANDOFF_TOKEN_THRESHOLD;
  process.env.CODEX_SUPERVISOR_HANDOFF_TOKEN_THRESHOLD = "300000";
  try {
    const active = task({ status: "running", exit_code: null, goal_tokens_used: 378000 });
    const first = collectWorkerChanges([active], {});
    assert.equal(first.quiet, false);
    assert.equal(first.attention[0].reason, "handoff_recommended");
    assert.equal(first.attention[0].next_step.tool, "get_codex_worker_status");
    assert.match(first.attention[0].next_step.instruction, /settle|cancel/i);
    const unchanged = collectWorkerChanges([{ ...active, goal_tokens_used: 400000 }], first.cursor);
    assert.equal(unchanged.quiet, true, "token increments must not spam reminders");
    const temporarilyUnknown = collectWorkerChanges([{ ...active, goal_tokens_used: null }], unchanged.cursor);
    assert.equal(temporarilyUnknown.quiet, true);
    const recoveredRead = collectWorkerChanges([active], temporarilyUnknown.cursor);
    assert.equal(recoveredRead.quiet, true, "a transient unavailable token count must not replay the reminder");
    const done = collectWorkerChanges([task({ goal_tokens_used: 400000 })], recoveredRead.cursor);
    assert.equal(done.transitions.some((notice) => notice.reason === "completed"), true);
    const resumed = collectWorkerChanges([{ ...active, run_count: 2 }], done.cursor);
    assert.equal(resumed.attention[0].reason, "handoff_recommended");
    process.env.CODEX_SUPERVISOR_HANDOFF_TOKEN_THRESHOLD = "0";
    assert.equal(collectWorkerChanges([active], {}).quiet, true);
  } finally {
    if (original === undefined) delete process.env.CODEX_SUPERVISOR_HANDOFF_TOKEN_THRESHOLD;
    else process.env.CODEX_SUPERVISOR_HANDOFF_TOKEN_THRESHOLD = original;
  }
});

test("check_workers returns a threshold reminder through MCP without resuming the live worker", async () => {
  const home = await tempHome("supervisor-handoff-notice-");
  const env = { SUPERVISOR_HOME: home, CODEX_HOME: home, FAKE_CODEX_SCENARIO: "hang", CODEX_SUPERVISOR_HANDOFF_TOKEN_THRESHOLD: "300000", CODEX_SUPERVISOR_OBSERVER_ID: "reconnecting-observer" };
  let worker;
  await withMcp(env, async ({ call }) => {
    worker = await call("create_codex_worker", dispatchArgs("long thread", join(home, "workspace"), {
      sandbox: "read-only", ownedPaths: []
    }));
    try {
      const db = new DatabaseSync(join(home, "data", "supervisor.sqlite"));
      db.prepare("UPDATE tasks SET goal_tokens_used=? WHERE id=?").run(378000, worker.id);
      db.close();
      const notice = await call("check_workers");
      assert.equal(notice.attention[0].reason, "handoff_recommended", JSON.stringify(notice));
      assert.deepEqual(notice.recoveries, []);
      assert.equal((await call("check_workers")).quiet, true);
      const live = await call("get_codex_worker_status", { task_id: worker.id });
      assert.equal(live.status, "running");
      assert.equal(live.run_count, 1);
    } catch (error) {
      await call("cancel_codex_worker", { task_id: worker.id });
      throw error;
    }
  });
  await withMcp(env, async ({ call }) => {
    try {
      const reconnected = await call("check_workers");
      assert.equal(reconnected.quiet, true, JSON.stringify(reconnected));
      assert.deepEqual(reconnected.attention, []);
      assert.deepEqual(reconnected.recoveries, []);
      const live = await call("get_codex_worker_status", { task_id: worker.id });
      assert.equal(live.status, "running");
      assert.equal(live.run_count, 1);
    } finally { await call("cancel_codex_worker", { task_id: worker.id }); }
  });
});
