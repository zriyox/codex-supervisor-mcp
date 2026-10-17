import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { dispatchArgs, makeRepo, tempHome, waitFor, withMcp } from "./helpers.js";

test("an independent verifier is isolated from the target report and persists finding evidence", async () => {
  const home = await tempHome("supervisor-independent-review-");
  const { dir } = await makeRepo(join(home, "repo"));
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "echo-prompt" }, async ({ call }) => {
    const target = await call("create_codex_worker", dispatchArgs("subject", dir, {
      task: "TARGET_WORKER_SECRET_REPORT_DO_NOT_FORWARD",
      goal: { objective: "Verify the public target objective" },
      ownedPaths: ["subject.txt"]
    }));
    await waitFor(call, target.id, (row) => row.exit_code === 0);
    const verifier = await call("create_independent_verifier", { task_id: target.id });
    assert.ok(verifier.id, JSON.stringify(verifier));
    assert.equal(verifier.workspace_kind, "read_only_in_place");
    assert.equal(verifier.sandbox, "read-only");
    assert.equal(verifier.worktree_path, null);
    assert.equal(verifier.review.subject_task_id, target.id);
    await waitFor(call, verifier.id, (row) => row.exit_code === 0);
    const verifierResult = await call("get_worker_result", { task_id: verifier.id, maxChars: 0 });
    assert.match(verifierResult.reports[0], /Verify the public target objective/);
    assert.doesNotMatch(verifierResult.reports[0], /TARGET_WORKER_SECRET_REPORT_DO_NOT_FORWARD/);

    const finding = await call("record_independent_finding", {
      verifier_task_id: verifier.id,
      verdict: "passes",
      reason: "The independent read-only inspection found the requested evidence."
    });
    assert.equal(finding.review.status, "recorded");
    const artifact = await call("get_artifact", { artifact_id: finding.artifact_id });
    const content = JSON.parse(artifact.artifact.content);
    assert.equal(content.subject_task_id, target.id);
    assert.equal(content.verdict, "passes");
    const resolved = await call("resolve_independent_finding", {
      verifier_task_id: verifier.id,
      resolution: "Accepted as independent verification evidence."
    });
    assert.equal(resolved.review.status, "resolved");
    const review = await call("get_independent_review", { verifier_task_id: verifier.id });
    assert.equal(review.review.resolution, "Accepted as independent verification evidence.");
  });
});
