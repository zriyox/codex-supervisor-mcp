import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyFailure } from "../../src/failure-class.js";

test("failure classification separates provider, supervisor, model, acceptance and worker causes", () => {
  assert.deepEqual(classifyFailure({ status: "failed", error: "upstream_status: 400; provider: DeepSeek" }), {
    source: "provider", code: "provider_http_400", retryable: false
  });
  assert.equal(classifyFailure({ status: "failed", error: "upstream status 503" }).code, "provider_http_503");
  assert.equal(classifyFailure({ status: "lost", error: "Worker ended but its supervisor did not record the process exit" }).code, "exit_unrecorded");
  assert.equal(classifyFailure({ status: "failed", attention_reason: "invalid_report", error: "Invalid final worker report: bad JSON" }).source, "model_output");
  assert.equal(classifyFailure({ status: "completed", acceptance_results: { passed: false } }).code, "acceptance_failed");
  assert.equal(classifyFailure({ status: "completed", attention_reason: "two_stall" }).code, "two_stall");
  assert.equal(classifyFailure({ status: "failed", error: "workspaceSetup command failed: nuxi prepare" }).source, "workspace_setup");
});

test("a healthy or merely blocked goal is not mislabeled as an execution failure", () => {
  assert.equal(classifyFailure({ status: "completed", goal_status: "complete" }), null);
  assert.deepEqual(classifyFailure({ status: "completed", goal_status: "blocked" }), {
    source: "goal", code: "goal_blocked", retryable: false
  });
});
