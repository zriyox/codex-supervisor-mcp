import { test } from "node:test";
import assert from "node:assert/strict";
import { tempHome, withMcp, dispatchArgs, waitFor, makeRepo } from "./helpers.js";
import { join } from "node:path";

test("session policy revisions preserve omitted fields and reject stale updates", async () => {
  const home = await tempHome("supervisor-session-policy-");
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const first = await call("describe_session", { session_id: "policy", objective: "run all tests", default_acceptance: ['node -e "process.exit(0)"'], approval_state: "approved" });
    assert.equal(first.policy_revision, 1);
    assert.equal(first.objective, "run all tests");
    assert.equal(first.default_acceptance.length, 1);
    const title = await call("describe_session", { session_id: "policy", title: "Tests" });
    assert.equal(title.policy_revision, 1);
    assert.equal(title.objective, first.objective);
    const revised = await call("describe_session", { session_id: "policy", expected_revision: 1, objective: "approved known failures", default_acceptance: [], approval_state: "waiting_user" });
    assert.equal(revised.policy_revision, 2);
    assert.equal(revised.approval_state, "waiting_user");
    const stale = await call("describe_session", { session_id: "policy", expected_revision: 1, objective: "stale goal" });
    assert.equal(stale.error, "session_policy_conflict");
    const works = await call("get_session_works", { session_id: "policy" });
    assert.equal(works.policy_revision, 2);
    assert.equal(works.objective, "approved known failures");
    assert.deepEqual(works.default_acceptance, []);
  });
});

test("an approved result from an old session policy cannot land after its requirements change", async () => {
  const home = await tempHome("supervisor-session-land-");
  const { dir } = await makeRepo(join(home, "repo"));
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "commit-in-worktree" }, async ({ call }) => {
    await call("describe_session", { session_id: "batch", objective: "first goal", default_acceptance: ['node -e "process.exit(0)"'] });
    const worker = await call("create_codex_worker", dispatchArgs("old-policy", dir, { session_id: "batch", ownedPaths: ["committed.txt", "uncommitted.txt"] }));
    await waitFor(call, worker.id, (t) => t.exit_code != null && t.status === "completed");
    await call("describe_session", { session_id: "batch", objective: "new goal" });
    const refused = await call("land_codex_worker", { task_id: worker.id });
    assert.equal(refused.error, "session_policy_stale");
    await call("describe_session", { session_id: "batch", approval_state: "waiting_user" });
    const waiting = await call("land_codex_worker", { task_id: worker.id });
    assert.equal(waiting.error, "session_waiting_user");
  });
});

test("session defaults are added to each worker and waiting approval blocks dispatch and resume", async () => {
  const home = await tempHome("supervisor-session-defaults-");
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    await call("describe_session", { session_id: "batch", default_acceptance: ['node -e "console.log(\'common check\')"'] });
    const worker = await call("create_codex_worker", dispatchArgs("default-checks", join(home, "workspace"), {
      session_id: "batch", acceptance: ['node -e "console.log(\'local check\')"']
    }));
    await waitFor(call, worker.id, (t) => t.exit_code != null && t.status === "completed");
    const result = await call("get_worker_result", { task_id: worker.id });
    assert.equal(result.acceptance.checks.length, 2);
    assert.equal(result.acceptance.checks[0].output_tail, "common check");
    assert.equal(result.acceptance.checks[1].output_tail, "local check");
    await call("describe_session", { session_id: "batch", approval_state: "waiting_user" });
    const refused = await call("create_codex_worker", dispatchArgs("not-approved", join(home, "workspace"), { session_id: "batch" }));
    assert.equal(refused.error, "session_waiting_user");
    const resume = await call("resume_codex_worker", { task_id: worker.id, prompt: "continue" });
    assert.equal(resume.error, "session_waiting_user");
    await call("describe_session", { session_id: "batch", approval_state: "approved", default_acceptance: ['node -e "console.log(\'revised common check\')"'] });
    const resumed = await call("resume_codex_worker", { task_id: worker.id, prompt: "approved revision" });
    assert.ok(resumed.id, JSON.stringify(resumed));
    await waitFor(call, worker.id, (t) => t.run_count === 2 && t.exit_code != null);
    const revised = await call("get_worker_result", { task_id: worker.id });
    assert.equal(revised.acceptance.checks[0].output_tail, "revised common check");
    assert.equal(revised.acceptance.checks[1].output_tail, "local check");
  });
});

test("combined defaults exceeding the command limit create no worker", async () => {
  const home = await tempHome("supervisor-session-limit-");
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    await call("describe_session", { session_id: "batch", default_acceptance: Array(10).fill('node -e "process.exit(0)"') });
    const worker = await call("create_codex_worker", dispatchArgs("too-many", join(home, "workspace"), { session_id: "batch", acceptance: ['node -e "process.exit(0)"'] }));
    assert.equal(worker.error, "too_many_acceptance_commands");
    const works = await call("get_session_works", { session_id: "batch" });
    assert.equal(works.count, 0);
  });
});

test("resume receives the latest approved session objective instead of reviving earlier scope", async () => {
  const home = await tempHome("supervisor-current-scope-");
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "echo-prompt" }, async ({ call }) => {
    await call("describe_session", { session_id: "batch", objective: "all tests must pass" });
    const task = await call("create_codex_worker", dispatchArgs("current scope", join(home, "workspace"), { ownedPaths: [], session_id: "batch" }));
    await waitFor(call, task.id, (row) => row.exit_code === 0);
    await call("describe_session", { session_id: "batch", objective: "approved existing failure list and no new failures", approval_state: "approved" });
    await call("resume_codex_worker", { task_id: task.id, prompt: "finish under current approval" });
    await waitFor(call, task.id, (row) => row.run_count === 2 && row.exit_code === 0);
    const result = await call("get_worker_result", { task_id: task.id, maxChars: 0 });
    assert.match(result.reports[0], /Current session objective \(revision 2\): approved existing failure list and no new failures/);
    assert.doesNotMatch(result.reports[0], /Current session objective.*all tests must pass/);
  });
});
