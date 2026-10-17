import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { dispatchArgs, makeRepo, tempHome, waitFor, withMcp } from "./helpers.js";

test("worker context excludes session peers and includes only scoped verified facts", async () => {
  const home = await tempHome("supervisor-context-scope-");
  const { dir } = await makeRepo(join(home, "repo"));
  let target;
  let peer;
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "echo-prompt" }, async ({ call }) => {
    await call("describe_session", { session_id: "batch", objective: "SESSION_SECRET_OBJECTIVE" });
    peer = await call("create_codex_worker", dispatchArgs("PEER_SECRET_TITLE", dir, {
      session_id: "batch", task: "PEER_SECRET_TASK", ownedPaths: ["peer.txt"]
    }));
    await waitFor(call, peer.id, (row) => row.exit_code === 0);
    target = await call("create_codex_worker", dispatchArgs("target", dir, {
      session_id: "batch", task: "TARGET_TASK", ownedPaths: ["target.txt"]
    }));
    await waitFor(call, target.id, (row) => row.exit_code === 0);
  });

  process.env.SUPERVISOR_HOME = home;
  const { getWorkItemForTask, latestContextSnapshotForTask, recordFact } = await import("../../src/task-store.js");
  const ownWork = await getWorkItemForTask(target.id);
  const peerWork = await getWorkItemForTask(peer.id);
  const ownFact = await recordFact({ workItemId: ownWork.id, scopeType: "work_item", scopeId: ownWork.id, key: "own", value: { note: "OWN_VERIFIED_FACT" }, state: "verified", validForSha: target.base_commit });
  await recordFact({ workItemId: ownWork.id, scopeType: "work_item", scopeId: ownWork.id, key: "candidate", value: { note: "CANDIDATE_MUST_NOT_INJECT" }, state: "candidate", validForSha: target.base_commit });
  await recordFact({ workItemId: ownWork.id, scopeType: "repo_verified", scopeId: ownWork.repo_id, key: "repo", value: { note: "REPO_PATH_MATCH" }, state: "verified", validForSha: target.base_commit, watchedPaths: [join(dir, "target.txt")] });
  await recordFact({ workItemId: peerWork.id, scopeType: "work_item", scopeId: peerWork.id, key: "peer", value: { note: "PEER_FACT_MUST_NOT_INJECT" }, state: "verified", validForSha: target.base_commit });

  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "echo-prompt" }, async ({ call }) => {
    await call("resume_codex_worker", { task_id: target.id, prompt: "continue target only" });
    await waitFor(call, target.id, (row) => row.run_count === 2 && row.exit_code === 0);
    const result = await call("get_worker_result", { task_id: target.id, maxChars: 0 });
    const prompt = result.reports[0];
    assert.match(prompt, /OWN_VERIFIED_FACT/);
    assert.match(prompt, /REPO_PATH_MATCH/);
    assert.doesNotMatch(prompt, /CANDIDATE_MUST_NOT_INJECT/);
    assert.doesNotMatch(prompt, /PEER_FACT_MUST_NOT_INJECT/);
    assert.doesNotMatch(prompt, /PEER_SECRET_TITLE|PEER_SECRET_TASK|SESSION_SECRET_OBJECTIVE/);
    const snapshotMeta = await call("get_context_snapshot_meta", { task_id: target.id });
    assert.ok(snapshotMeta.snapshot);
    assert.equal(snapshotMeta.snapshot.fact_ids.length, 2);
    assert.ok(snapshotMeta.snapshot.fact_ids.includes(ownFact.id));
    assert.equal("text" in snapshotMeta.snapshot, false);
    const fact = await call("get_fact", { fact_id: ownFact.id });
    assert.equal(fact.fact.value.note, "OWN_VERIFIED_FACT");
  });
  const snapshot = await latestContextSnapshotForTask(target.id);
  assert.ok(snapshot);
  assert.equal(snapshot.recipient, "worker");
  assert.equal(JSON.parse(snapshot.fact_versions).length, 2);
  assert.ok(snapshot.estimated_tokens <= 1500);
});
