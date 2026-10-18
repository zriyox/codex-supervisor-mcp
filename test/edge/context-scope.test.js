import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dispatchArgs, git, makeRepo, tempHome, waitFor, withMcp } from "./helpers.js";

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
  await recordFact({ workItemId: peerWork.id, scopeType: "work_item", scopeId: peerWork.id, key: "peer", value: { note: "PEER_FACT_MUST_NOT_INJECT" }, state: "verified", validForSha: target.base_commit });

  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "echo-prompt" }, async ({ call }) => {
    await call("resume_codex_worker", { task_id: target.id, prompt: "continue target only" });
    await waitFor(call, target.id, (row) => row.run_count === 2 && row.exit_code === 0);
    const result = await call("get_worker_result", { task_id: target.id, maxChars: 0 });
    const prompt = result.reports[0];
    assert.match(prompt, /OWN_VERIFIED_FACT/);
    assert.match(prompt, new RegExp(`branch: codex/${target.id}`));
    assert.match(prompt, /acceptance_source: no acceptance configured/);
    assert.doesNotMatch(prompt, /CANDIDATE_MUST_NOT_INJECT/);
    assert.doesNotMatch(prompt, /PEER_FACT_MUST_NOT_INJECT/);
    assert.doesNotMatch(prompt, /PEER_SECRET_TITLE|PEER_SECRET_TASK|SESSION_SECRET_OBJECTIVE/);
    const snapshotMeta = await call("get_context_snapshot_meta", { task_id: target.id });
    assert.ok(snapshotMeta.snapshot);
    assert.equal(snapshotMeta.snapshot.fact_ids.length, 1);
    assert.ok(snapshotMeta.snapshot.fact_ids.includes(ownFact.id));
    assert.equal("text" in snapshotMeta.snapshot, false);
    const fact = await call("get_fact", { fact_id: ownFact.id });
    assert.equal(fact.fact.value.note, "OWN_VERIFIED_FACT");
  });
  const snapshot = await latestContextSnapshotForTask(target.id);
  assert.ok(snapshot);
  assert.equal(snapshot.recipient, "worker");
  assert.equal(JSON.parse(snapshot.fact_versions).length, 1);
  assert.ok(snapshot.estimated_tokens <= 1500);
});

test("searching another repository does not expire the original work's verified facts", async () => {
  const home = await tempHome("supervisor-cross-repo-fact-");
  const { dir: firstRepo } = await makeRepo(join(home, "first-repo"));
  const { dir: secondRepo } = await makeRepo(join(home, "second-repo"));
  await writeFile(join(secondRepo, "second-only.txt"), "different repository history\n");
  git(secondRepo, ["add", "second-only.txt"]);
  git(secondRepo, ["commit", "-q", "-m", "make second repository distinct"]);
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const first = await call("create_codex_worker", dispatchArgs("first repo", firstRepo, {
      acceptance: "node -e \"process.exit(0)\"", ownedPaths: ["first.txt"]
    }));
    await waitFor(call, first.id, (row) => row.exit_code === 0);
    const db = new DatabaseSync(join(home, "data", "supervisor.sqlite"));
    const fact = db.prepare("SELECT id FROM facts WHERE work_item_id = (SELECT id FROM work_items WHERE task_id = ?) AND state = 'verified'").get(first.id);
    assert.ok(fact);
    const second = await call("create_codex_worker", dispatchArgs("second repo", secondRepo, { ownedPaths: ["second.txt"] }));
    await waitFor(call, second.id, (row) => row.exit_code === 0);
    await call("search_worker_facts", { task_id: second.id });
    assert.equal(db.prepare("SELECT state FROM facts WHERE id = ?").get(fact.id).state, "verified");
    db.close();
  });
});

test("concurrent searches append at most one expiry version for the same fact", async () => {
  const home = await tempHome("supervisor-concurrent-fact-expiry-");
  const { dir } = await makeRepo(join(home, "repo"));
  let worker;
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    worker = await call("create_codex_worker", dispatchArgs("expiry race", dir, {
      acceptance: "node -e \"process.exit(0)\"", ownedPaths: ["first.txt"]
    }));
    await waitFor(call, worker.id, (row) => row.exit_code === 0);
  });
  const db = new DatabaseSync(join(home, "data", "supervisor.sqlite"));
  const original = db.prepare("SELECT id FROM facts WHERE work_item_id = (SELECT id FROM work_items WHERE task_id = ?) AND key = 'accepted_outcome' AND state = 'verified'").get(worker.id);
  db.prepare("UPDATE facts SET expires_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", original.id);
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call: first }) => withMcp({ SUPERVISOR_HOME: home }, async ({ call: second }) => {
    const results = await Promise.all([
      first("search_worker_facts", { task_id: worker.id }),
      second("search_worker_facts", { task_id: worker.id })
    ]);
    for (const result of results) assert.equal(result.facts.some((fact) => fact.id === original.id), false);
  }));
  assert.equal(db.prepare("SELECT state FROM facts WHERE id = ?").get(original.id).state, "verified");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM facts WHERE supersedes_id = ? AND state = 'expired'").get(original.id).count, 1);
  db.close();
});

test("a canonical remote shares path-matched repo facts across isolated checkouts", async () => {
  const home = await tempHome("supervisor-canonical-remote-");
  const { dir: firstRepo } = await makeRepo(join(home, "first"));
  await writeFile(join(firstRepo, "shared.txt"), "shared source\n");
  git(firstRepo, ["add", "shared.txt"]);
  git(firstRepo, ["commit", "-q", "-m", "add shared source"]);
  const remote = join(home, "canonical.git");
  await mkdir(remote);
  execFileSync("git", ["init", "--bare", "-q", remote]);
  git(firstRepo, ["remote", "add", "origin", remote]);
  git(firstRepo, ["push", "-q", "-u", "origin", "main"]);
  const secondRepo = join(home, "second");
  execFileSync("git", ["clone", "-q", "-b", "main", remote, secondRepo]);

  let first;
  let second;
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "echo-prompt" }, async ({ call }) => {
    first = await call("create_codex_worker", dispatchArgs("first checkout", firstRepo, { ownedPaths: ["shared.txt"] }));
    second = await call("create_codex_worker", dispatchArgs("second checkout", secondRepo, { ownedPaths: ["shared.txt"] }));
    await waitFor(call, first.id, (row) => row.exit_code === 0);
    await waitFor(call, second.id, (row) => row.exit_code === 0);
  });

  const db = new DatabaseSync(join(home, "data", "supervisor.sqlite"));
  const firstWork = db.prepare("SELECT id, repo_id FROM work_items WHERE task_id = ?").get(first.id);
  assert.ok(firstWork, "the first checkout has a work item");
  const firstRepoRecord = db.prepare("SELECT canonical_remote FROM repos WHERE id = ?").get(firstWork.repo_id);
  assert.ok(firstRepoRecord.canonical_remote, "a checkout with origin records a canonical remote");
  assert.notEqual(firstRepoRecord.canonical_remote, firstWork.repo_id);
  const verified = { id: randomUUID() };
  db.prepare(`
    INSERT INTO facts (id, work_item_id, scope_type, scope_id, key, value_json, state, watched_paths, valid_for_sha, created_at, verified_at, verified_by)
    VALUES (?, ?, 'repo_verified', ?, 'canonical_shared', ?, 'verified', ?, ?, ?, ?, 'main_thread')
  `).run(verified.id, firstWork.id, firstRepoRecord.canonical_remote, JSON.stringify({ note: "CROSS_CHECKOUT_CANONICAL_FACT" }), JSON.stringify(["shared.txt"]), first.base_commit, new Date().toISOString(), new Date().toISOString());
  db.close();
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "echo-prompt" }, async ({ call }) => {
    await call("resume_codex_worker", { task_id: second.id, prompt: "read matching verified repository fact" });
    await waitFor(call, second.id, (row) => row.run_count === 2 && row.exit_code === 0);
    const result = await call("get_worker_result", { task_id: second.id, maxChars: 0 });
    assert.match(result.reports[0], /CROSS_CHECKOUT_CANONICAL_FACT/);
  });
});

test("a verified watched-path fact expires when a resumed worker rebases across that path", async () => {
  const home = await tempHome("supervisor-context-expiry-");
  const { dir } = await makeRepo(join(home, "repo"));
  let worker;
  let originalFactId;
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "echo-prompt" }, async ({ call }) => {
    worker = await call("create_codex_worker", dispatchArgs("watched", dir, {
      ownedPaths: ["watched.txt"],
      acceptance: "node -e \"process.exit(0)\""
    }));
    await waitFor(call, worker.id, (row) => row.exit_code === 0);
    const db = new DatabaseSync(join(home, "data", "supervisor.sqlite"));
    originalFactId = db.prepare("SELECT id FROM facts WHERE work_item_id = (SELECT id FROM work_items WHERE task_id = ?) AND key = 'accepted_outcome' AND state = 'verified'").get(worker.id).id;
    db.close();
  });
  await writeFile(join(dir, "watched.txt"), "main changed this path\n");
  git(dir, ["add", "watched.txt"]);
  git(dir, ["commit", "-q", "-m", "change watched path"]);

  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "echo-prompt" }, async ({ call }) => {
    await call("resume_codex_worker", { task_id: worker.id, prompt: "recheck on new base", rebaseOnto: "main" });
    await waitFor(call, worker.id, (row) => row.run_count === 2 && row.exit_code === 0);
    const original = await call("get_fact", { fact_id: originalFactId });
    assert.equal(original.fact.state, "verified");
    assert.equal(original.effective_state, "expired");
    await call("search_worker_facts", { task_id: worker.id });
    await call("search_worker_facts", { task_id: worker.id });
  });
  const db = new (await import("node:sqlite")).DatabaseSync(join(home, "data", "supervisor.sqlite"));
  const facts = db.prepare("SELECT state, key FROM facts WHERE work_item_id = (SELECT id FROM work_items WHERE task_id = ?) ORDER BY created_at").all(worker.id);
  assert.ok(facts.some((fact) => fact.key === "accepted_outcome" && fact.state === "expired"), JSON.stringify(facts));
  assert.ok(facts.some((fact) => fact.key === "accepted_outcome" && fact.state === "verified"), JSON.stringify(facts));
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM facts WHERE supersedes_id = ? AND state = 'expired'").get(originalFactId).count, 1);
  db.close();
});
