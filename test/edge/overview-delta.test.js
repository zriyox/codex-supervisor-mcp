import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOverviewDelta } from "../../src/overview-delta.js";

const task = (extra = {}) => ({
  id: "t1", title: "task", status: "running", exit_code: null, run_count: 1,
  updated_at: "2026-10-17T00:00:00.000Z", delivery_state: "draft", ...extra
});

test("overview delta returns counters and only changes after the cursor", () => {
  const first = buildOverviewDelta([
    task(),
    task({ id: "t2", status: "completed", exit_code: 0, delivery_state: "cleanup_eligible", push_verified_at: "2026-10-17T00:01:00.000Z", updated_at: "2026-10-17T00:01:00.000Z" }),
    task({ id: "t3", status: "failed", exit_code: 1, attention_reason: "build_failed", updated_at: "2026-10-17T00:02:00.000Z" })
  ], {}, { readyToCleanTaskIds: new Set(["t2"]) });
  assert.equal(first.active, 1);
  assert.equal(first.needs_attention, 1);
  assert.equal(first.ready_to_clean, 1);
  assert.equal(first.changes.length, 3);
  const blocked = first.changes.find((entry) => entry.id === "t3");
  assert.equal(blocked.attention_reason, "build_failed");
  assert.match(blocked.next_action, /inspect the worker evidence/);
  const quiet = buildOverviewDelta([
    task(),
    task({ id: "t2", status: "completed", exit_code: 0, delivery_state: "cleanup_eligible", push_verified_at: "2026-10-17T00:01:00.000Z", updated_at: "2026-10-17T00:01:00.000Z" }),
    task({ id: "t3", status: "failed", exit_code: 1, attention_reason: "build_failed", updated_at: "2026-10-17T00:02:00.000Z" })
  ], first.cursor, { readyToCleanTaskIds: new Set(["t2"]) });
  assert.deepEqual(quiet.changes, []);
  assert.equal(quiet.ready_to_clean, 1);

  const stale = buildOverviewDelta([
    task(),
    task({ id: "t2", status: "completed", exit_code: 0, delivery_state: "cleanup_eligible", push_verified_at: "2026-10-17T00:01:00.000Z", updated_at: "2026-10-17T00:01:00.000Z" }),
    task({ id: "t3", status: "failed", exit_code: 1, attention_reason: "build_failed", updated_at: "2026-10-17T00:02:00.000Z" })
  ], first.cursor, { readyToCleanTaskIds: new Set() });
  assert.equal(stale.ready_to_clean, 0);
  assert.equal(stale.changes.find((entry) => entry.id === "t2").next_action, "rerun cleanup_plan; the previous cleanup proof is no longer current");
});
