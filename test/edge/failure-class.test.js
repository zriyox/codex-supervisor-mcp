import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyFailure } from "../../src/domain/failure-class.js";

test("failure classification separates provider, supervisor, model, acceptance and worker causes", () => {
  assert.deepEqual(classifyFailure({ status: "failed", error: "upstream_status: 400; provider: DeepSeek" }), {
    source: "provider", code: "provider_http_400", retryable: false
  });
  assert.equal(classifyFailure({ status: "failed", error: "upstream status 503" }).code, "provider_http_503");
  assert.equal(classifyFailure({ status: "lost", error: "Worker ended but its supervisor did not record the process exit" }).code, "exit_unrecorded");
  assert.equal(classifyFailure({ status: "failed", attention_reason: "invalid_report", error: "Invalid final worker report: bad JSON" }).source, "model_output");
  assert.equal(classifyFailure({ status: "completed", acceptance_results: { passed: false } }).code, "acceptance_failed");
  assert.equal(classifyFailure({ status: "completed", attention_reason: "two_stall" }).code, "two_stall");
  assert.equal(classifyFailure({ status: "failed", error: "workspace.setup command failed: nuxi prepare" }).source, "workspace_setup");
});

test("a healthy or merely blocked goal is not mislabeled as an execution failure", () => {
  assert.equal(classifyFailure({ status: "completed", goal_status: "complete" }), null);
  assert.deepEqual(classifyFailure({ status: "completed", goal_status: "blocked" }), {
    source: "goal", code: "goal_blocked", retryable: false
  });
});

// The exit code alone tells a caller nothing; what the process last wrote does.
test("a non-zero exit is attributed from what the worker wrote to stderr", () => {
  const exit = (stderr_tail) => classifyFailure({ status: "failed", error: "codex exited with code 1", stderr_tail });
  assert.deepEqual(exit("warming up\nError: 401 Unauthorized: invalid api key\n"), {
    source: "auth", code: "auth_failed", retryable: false, detail: "Error: 401 Unauthorized: invalid api key"
  });
  assert.equal(exit("stream disconnected before completion: error sending request").code, "provider_unreachable");
  assert.equal(exit("unexpected status 429 Too Many Requests").code, "provider_rate_limited");
  assert.equal(exit("provider error: error sending request: connection refused").code, "provider_unreachable");
  assert.equal(exit("thread panicked at src/main.rs:403:9").code, "process_exit_nonzero", "a line number is not a status");
  assert.equal(exit("error loading config.toml: unknown field").source, "runner_config");
  assert.equal(exit("Error: thread/resume failed: thread 01a2 already has an active writer (code -32600)").code, "session_busy");
  assert.deepEqual(exit("thread panicked at main.rs"), {
    source: "worker_process", code: "process_exit_nonzero", retryable: true, detail: "thread panicked at main.rs"
  });
  assert.deepEqual(exit(""), { source: "worker_process", code: "process_exit_nonzero", retryable: true });
});
