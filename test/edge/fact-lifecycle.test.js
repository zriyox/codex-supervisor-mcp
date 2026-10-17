import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { dispatchArgs, makeRepo, tempHome, waitFor, withMcp } from "./helpers.js";

const PASS = 'node -e "process.exit(0)"';
const FAIL = 'node -e "process.exit(9)"';

test("worker reports become candidates and acceptance alone promotes verified facts", async () => {
  const home = await tempHome("supervisor-fact-lifecycle-");
  const { dir } = await makeRepo(join(home, "repo"));
  let passed;
  let failed;
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "echo-prompt" }, async ({ call }) => {
    passed = await call("create_codex_worker", dispatchArgs("accepted", dir, { acceptance: PASS, ownedPaths: ["accepted.txt"] }));
    failed = await call("create_codex_worker", dispatchArgs("rejected", dir, { acceptance: FAIL, ownedPaths: ["rejected.txt"] }));
    await waitFor(call, passed.id, (task) => task.status === "completed" && task.exit_code !== null);
    await waitFor(call, failed.id, (task) => task.status === "completed" && task.exit_code !== null);
  });

  const db = new DatabaseSync(join(home, "data", "supervisor.sqlite"));
  const acceptedFacts = db.prepare("SELECT * FROM facts WHERE work_item_id = (SELECT id FROM work_items WHERE task_id = ?) ORDER BY created_at").all(passed.id);
  assert.equal(acceptedFacts.length, 2);
  assert.deepEqual(acceptedFacts.map((fact) => [fact.state, fact.scope_type, fact.key]), [
    ["candidate", "run", "worker_outcome"],
    ["verified", "work_item", "accepted_outcome"]
  ]);
  assert.ok(acceptedFacts.every((fact) => fact.source_event_id != null));
  assert.equal(acceptedFacts[1].supersedes_id, acceptedFacts[0].id);
  assert.equal(db.prepare("SELECT delivery_state FROM work_items WHERE task_id = ?").get(passed.id).delivery_state, "verified");

  const rejectedFacts = db.prepare("SELECT state, scope_type FROM facts WHERE work_item_id = (SELECT id FROM work_items WHERE task_id = ?)").all(failed.id);
  assert.equal(rejectedFacts.length, 1);
  assert.equal(rejectedFacts[0].state, "candidate");
  assert.equal(rejectedFacts[0].scope_type, "run");
  assert.equal(db.prepare("SELECT delivery_state FROM work_items WHERE task_id = ?").get(failed.id).delivery_state, "draft");
  db.close();
});
