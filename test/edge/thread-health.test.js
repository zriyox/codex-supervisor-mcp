import { test } from "node:test";
import assert from "node:assert/strict";
import { handoffTokenThreshold, threadHealth } from "../../src/thread-health.js";

test("thread health warns before and at the handoff threshold", () => {
  assert.equal(threadHealth({ goal_tokens_used: 1000 }, { threshold: 300000 }).state, "ok");
  assert.equal(threadHealth({ goal_tokens_used: 230000 }, { threshold: 300000 }).state, "getting_long");
  assert.equal(threadHealth({ goal_tokens_used: 300000 }, { threshold: 300000 }).state, "handoff_recommended");
  assert.match(threadHealth({ goal_tokens_used: 500000 }, { threshold: 300000 }).next_step, /create_codex_followup_worker/);
});

test("thread health can be disabled and has a stable environment override", () => {
  assert.equal(threadHealth({ goal_tokens_used: 500000 }, { threshold: 0 }).state, "disabled");
  assert.equal(handoffTokenThreshold({ CODEX_SUPERVISOR_HANDOFF_TOKEN_THRESHOLD: "420000" }), 420000);
  assert.equal(handoffTokenThreshold({ CODEX_SUPERVISOR_HANDOFF_TOKEN_THRESHOLD: "bad" }), 300000);
  assert.equal(threadHealth({ goal_tokens_used: 0 }, { threshold: 300000 }).state, "ok");
});
