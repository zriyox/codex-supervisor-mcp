// When the supervisor could not read what a run changed, that is the thing to
// tell the main thread. It used to be replaced by "no_work", a conclusion
// drawn from the very evidence that was missing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { flagAttention } from "../../src/run-host/finalize.js";

test("unreadable evidence is not relabelled as a worker that did nothing", () => {
  const run = { live: { sandbox: "workspace-write", commands: [], guard_policy: {} }, reportOnlyRecovery: false, priorAttemptFingerprint: null };
  const evidence = { output_changed: false, attempt_fingerprint: "a", structured_report: { valid: false, error: "not JSON" } };
  const unread = { attention_reason: "external_output_unverified", error: "EACCES: /mnt/out", run_evidence: evidence };
  flagAttention(run, unread, "completed", 0);
  assert.equal(unread.attention_reason, "external_output_unverified");
  assert.equal(unread.error, "EACCES: /mnt/out");

  const read = { attention_reason: null, error: null, run_evidence: { ...evidence, structured_report: { valid: true } } };
  flagAttention(run, read, "completed", 0);
  assert.equal(read.attention_reason, "no_work");
});
