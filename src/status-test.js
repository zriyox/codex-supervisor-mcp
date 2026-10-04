// Unit coverage for the goal -> work mapping and the state machine constants.
import assert from "node:assert/strict";
import {
  ACTIVE_STATUSES,
  PHASES,
  TASK_STATUSES,
  TERMINAL_STATUSES,
  isGoalNeedingAttention,
  mapGoalStatus
} from "./status.js";

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

check("status and phase sets are disjoint", () => {
  assert.deepEqual(TASK_STATUSES, ["queued", "running", "completed", "failed", "cancelled", "lost"]);
  assert.deepEqual(PHASES, ["starting", "thinking", "command", "editing", "reporting"]);
  assert.equal(TASK_STATUSES.length + PHASES.length, new Set([...TASK_STATUSES, ...PHASES]).size);
});

check("every status is either active or terminal", () => {
  for (const status of TASK_STATUSES) {
    assert.equal(
      ACTIVE_STATUSES.has(status) !== TERMINAL_STATUSES.has(status),
      true,
      `${status} must be exactly one of active/terminal`
    );
  }
});

check("goal status maps to work status in both storage and RPC spelling", () => {
  const cases = [
    ["active", "running"],
    ["paused", "running"],
    ["blocked", "running"],
    ["usage_limited", "failed"],
    ["usageLimited", "failed"],
    ["budget_limited", "failed"],
    ["budgetLimited", "failed"],
    ["complete", "completed"]
  ];
  for (const [native, expected] of cases) {
    assert.equal(mapGoalStatus(native), expected, `${native} -> ${expected}`);
  }
  assert.equal(mapGoalStatus(null), null);
  assert.equal(mapGoalStatus("somethingNew"), null);
});

check("paused and blocked are flagged as needing attention, complete is not", () => {
  assert.equal(isGoalNeedingAttention("paused"), true);
  assert.equal(isGoalNeedingAttention("blocked"), true);
  assert.equal(isGoalNeedingAttention("active"), false);
  assert.equal(isGoalNeedingAttention("complete"), false);
  assert.equal(isGoalNeedingAttention("usage_limited"), false);
  assert.equal(isGoalNeedingAttention(null), false);
});

console.log(`\n${passed} status checks passed`);
