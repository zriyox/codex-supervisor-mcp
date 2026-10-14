import { test } from "node:test";
import assert from "node:assert/strict";
import { tempHome, withMcp } from "./helpers.js";

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
