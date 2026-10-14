import { test } from "node:test";
import assert from "node:assert/strict";
import { collectWorkerChanges } from "../../src/worker-changes.js";

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
