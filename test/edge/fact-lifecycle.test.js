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
    const searched = await call("search_worker_facts", { task_id: passed.id, query: "done" });
    assert.equal(searched.facts.length, 1);
    assert.equal(searched.facts[0].state, "verified");
    assert.equal(searched.facts[0].key, "accepted_outcome");
    assert.equal(searched.facts[0].scope, "work_item");
    assert.ok(searched.facts[0].source_refs.some((ref) => ref.startsWith("event:")));
    assert.equal(searched.next_cursor, null);
    assert.ok(searched.coverage.omitted.some((entry) => entry.reason === "candidate_and_nonverified_facts_excluded"));

    const db = new DatabaseSync(join(home, "data", "supervisor.sqlite"));
    const candidate = db.prepare("SELECT id FROM facts WHERE work_item_id = (SELECT id FROM work_items WHERE task_id = ?) AND state = 'candidate'").get(passed.id);
    db.close();
    const promoted = await call("promote_worker_fact", { fact_id: candidate.id });
    assert.equal(promoted.fact.state, "verified");
    assert.equal(promoted.fact.supersedes_id, candidate.id);
    assert.equal(promoted.fact.verified_by, "main_thread");
    const afterPromotion = await call("search_worker_facts", { task_id: passed.id, query: "done" });
    assert.ok(afterPromotion.facts.some((fact) => fact.id === promoted.fact.id));
    const revoked = await call("revoke_worker_fact", { fact_id: promoted.fact.id, reason: "main-thread audit found it redundant" });
    assert.equal(revoked.fact.state, "revoked");
    assert.equal(revoked.fact.supersedes_id, promoted.fact.id);
    const auditDb = new DatabaseSync(join(home, "data", "supervisor.sqlite"));
    assert.equal(auditDb.prepare("SELECT state FROM facts WHERE id = ?").get(promoted.fact.id).state, "verified");
    assert.equal(auditDb.prepare("SELECT state FROM facts WHERE id = ?").get(revoked.fact.id).state, "revoked");
    auditDb.close();
    const original = await call("get_fact", { fact_id: promoted.fact.id });
    assert.equal(original.fact.state, "verified");
    assert.equal(original.effective_state, "revoked");
    const afterRevoke = await call("search_worker_facts", { task_id: passed.id, query: "done" });
    assert.equal(afterRevoke.facts.some((fact) => fact.id === promoted.fact.id), false);
    const evidence = await call("get_worker_evidence", { task_id: passed.id });
    assert.ok(evidence.events.some((event) => event.type === "supervisor.fact_promoted"));
    assert.ok(evidence.events.some((event) => event.type === "supervisor.fact_revoked"));
    const rejectedDb = new DatabaseSync(join(home, "data", "supervisor.sqlite"));
    const rejectedCandidate = rejectedDb.prepare("SELECT id FROM facts WHERE work_item_id = (SELECT id FROM work_items WHERE task_id = ?) AND state = 'candidate'").get(failed.id);
    rejectedDb.close();
    const rejectedRevocation = await call("revoke_worker_fact", { fact_id: rejectedCandidate.id, reason: "candidate was disproved" });
    assert.equal(rejectedRevocation.fact.state, "revoked");
    const refusedPromotion = await call("promote_worker_fact", { fact_id: rejectedCandidate.id });
    assert.equal(refusedPromotion.error, "fact_already_revoked");
  });

  const db = new DatabaseSync(join(home, "data", "supervisor.sqlite"));
  const acceptedFacts = db.prepare("SELECT * FROM facts WHERE work_item_id = (SELECT id FROM work_items WHERE task_id = ?) ORDER BY created_at").all(passed.id);
  assert.equal(acceptedFacts.length, 4);
  assert.deepEqual(acceptedFacts.map((fact) => [fact.state, fact.scope_type, fact.key]), [
    ["candidate", "run", "worker_outcome"],
    ["verified", "work_item", "accepted_outcome"],
    ["verified", "work_item", "worker_outcome"],
    ["revoked", "work_item", "worker_outcome"]
  ]);
  assert.ok(acceptedFacts.every((fact) => fact.source_event_id != null));
  assert.equal(acceptedFacts[1].supersedes_id, acceptedFacts[0].id);
  assert.equal(acceptedFacts[2].supersedes_id, acceptedFacts[0].id);
  assert.equal(acceptedFacts[3].supersedes_id, acceptedFacts[2].id);
  assert.equal(db.prepare("SELECT delivery_state FROM work_items WHERE task_id = ?").get(passed.id).delivery_state, "verified");

  const rejectedFacts = db.prepare("SELECT state, scope_type FROM facts WHERE work_item_id = (SELECT id FROM work_items WHERE task_id = ?)").all(failed.id);
  assert.equal(rejectedFacts.length, 2);
  assert.equal(rejectedFacts[0].state, "candidate");
  assert.equal(rejectedFacts[0].scope_type, "run");
  assert.equal(rejectedFacts[1].state, "revoked");
  assert.equal(db.prepare("SELECT delivery_state FROM work_items WHERE task_id = ?").get(failed.id).delivery_state, "draft");
  db.close();
});
