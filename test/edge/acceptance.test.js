// Acceptance: the supervisor's own run of the dispatcher's checks after the
// worker exits, the verdict on every read, and the gate on landing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dispatchArgs, git, makeRepo, tempHome, waitFor, withMcp } from "./helpers.js";

// Shell lines that behave the same under sh and cmd: double quotes only.
const PASS = 'node -e "process.exit(0)"';
const FAIL = 'node -e "console.log(\'boom from the check\'); process.exit(3)"';
const HANG = 'node -e "setInterval(function(){}, 1000)"';
const WRITES_MARKER = 'node -e "require(\'fs\').writeFileSync(\'ran.txt\', \'yes\')"';

function settled(t) {
  return t.status === "completed" && t.exit_code !== null;
}

test("a failing check is recorded with its output, shows on every read, and blocks landing until ignored", async () => {
  const home = await tempHome("supervisor-acceptance-");
  const { dir } = await makeRepo(join(home, "repo"));
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "commit-in-worktree" }, async ({ call }) => {
    const created = await call("create_codex_worker", dispatchArgs("checked", dir, { acceptance: [PASS, FAIL, PASS] }));
    assert.ok(!created.error, JSON.stringify(created).slice(0, 300));
    const waited = await call("wait_codex_workers", { task_ids: [created.id], compact: true, timeoutMs: 15000 });
    assert.equal(waited.timed_out, false);
    assert.equal(waited.acceptance_failed_count, 1);
    const row = waited.workers[0];
    assert.equal(row.status, "completed");
    assert.equal(row.exit_code, 0, "wait does not return before the verdict is written");
    assert.equal(row.acceptance, "failed");

    const result = await call("get_worker_result", { task_id: created.id });
    const a = result.acceptance;
    assert.equal(a.configured, true);
    assert.equal(a.passed, false);
    assert.equal(a.status, "failed");
    assert.equal(a.run, 1);
    assert.equal(a.checks.length, 2, "stops at the first failure");
    assert.equal(a.checks[0].exit_code, 0);
    assert.equal(a.checks[1].exit_code, 3);
    assert.match(a.checks[1].output_tail, /boom from the check/);
    assert.equal(a.checks[1].timed_out, false);
    assert.match(a.next_step, /resume the worker/);

    const status = await call("get_codex_worker_status", { task_id: created.id });
    assert.equal(status.acceptance, "failed");
    assert.match(status.current_action, /Acceptance failed/);
    const overview = await call("get_orchestration_overview", {});
    assert.deepEqual(overview.acceptance_failed, [created.id]);
    assert.deepEqual(overview.needs_attention, [], "a failed acceptance is not a stuck worker");
    assert.equal(overview.workers.find((w) => w.id === created.id).acceptance, "failed");
    const summary = await call("get_worker_summary", { task_id: created.id });
    assert.match(summary.summary ?? JSON.stringify(summary), /acceptance: failed, 1\/3 passed/);
    const events = await call("get_codex_worker_events", { task_id: created.id, kinds: ["supervisor.acceptance"] });
    assert.equal((events.events ?? events).length, 1, "the verdict is in the event stream");

    const refused = await call("land_codex_worker", { task_id: created.id });
    assert.equal(refused.error, "acceptance_failed");
    assert.match(refused.reason, /exit 3/);
    assert.equal(git(dir, ["rev-list", "--count", "HEAD"]), "2", "nothing landed");
    const forced = await call("land_codex_worker", { task_id: created.id, ignoreAcceptance: true });
    assert.ok(!forced.error, JSON.stringify(forced).slice(0, 300));
    assert.equal(forced.landed.length, 1);
  });
});

test("passing checks land, the worker sees the commands in its prompt, and no acceptance means null everywhere", async () => {
  const home = await tempHome("supervisor-acceptance-");
  const { dir } = await makeRepo(join(home, "repo"));
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "echo-prompt" }, async ({ call }) => {
    const created = await call("create_codex_worker", dispatchArgs("green", dir, { acceptance: PASS }));
    const done = await waitFor(call, created.id, settled);
    assert.equal(done.acceptance, "passed");
    assert.match(done.current_action, /acceptance passed/);
    const result = await call("get_worker_result", { task_id: created.id, maxChars: 0 });
    assert.equal(result.acceptance.passed, true);
    assert.deepEqual(result.acceptance.commands, [PASS]);
    assert.equal(result.acceptance.next_step, null);
    assert.match(result.reports[0], /Acceptance: when you exit, the supervisor runs these commands/);
    assert.ok(result.reports[0].includes(`- ${PASS}`), "the command itself is in the prompt");
    assert.ok(result.reports[0].indexOf("Final report") < result.reports[0].indexOf("Acceptance:"), "after the report format");

    const bare = await call("create_codex_worker", dispatchArgs("unchecked", dir));
    const bareDone = await waitFor(call, bare.id, settled);
    assert.equal(bareDone.acceptance, null);
    const bareResult = await call("get_worker_result", { task_id: bare.id });
    assert.equal(bareResult.acceptance.configured, false);
    assert.equal(bareResult.acceptance.passed, null);
    const bareEvents = await call("get_codex_worker_events", { task_id: bare.id, kinds: ["supervisor.acceptance"] });
    assert.equal((bareEvents.events ?? bareEvents).length, 0);
  });
});

test("a check that hangs is killed at the timeout and marked, and the worktree is where it ran", async () => {
  const home = await tempHome("supervisor-acceptance-");
  const { dir } = await makeRepo(join(home, "repo"));
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const created = await call("create_codex_worker", dispatchArgs("slow", dir, { acceptance: [WRITES_MARKER, HANG, PASS], acceptanceTimeoutMs: 1500 }));
    const started = Date.now();
    const done = await waitFor(call, created.id, settled, 30000);
    assert.ok(Date.now() - started < 20000, "the hang did not run to the 10-minute default");
    assert.equal(done.acceptance, "failed");
    const { acceptance } = await call("get_worker_result", { task_id: created.id });
    assert.equal(acceptance.checks.length, 2);
    assert.equal(acceptance.checks[1].timed_out, true);
    assert.notEqual(acceptance.checks[1].exit_code, 0);
    assert.ok(acceptance.checks[1].duration_ms >= 1400);
    assert.match(acceptance.next_step, /by timeout/);
    assert.equal(git(created.worktree_path, ["status", "--porcelain", "ran.txt"]), "?? ran.txt", "checks run inside the worktree");
  });
});

test("a resume re-runs the checks, can replace them, and a follow-up inherits them", async () => {
  const home = await tempHome("supervisor-acceptance-");
  const { dir } = await makeRepo(join(home, "repo"));
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const created = await call("create_codex_worker", dispatchArgs("twice", dir, { acceptance: FAIL }));
    await waitFor(call, created.id, settled);
    const first = await call("get_worker_result", { task_id: created.id });
    assert.equal(first.acceptance.passed, false);
    assert.equal(first.acceptance.run, 1);

    const resumed = await call("resume_codex_worker", { task_id: created.id, prompt: "fix it", acceptance: [PASS] });
    assert.ok(!resumed.error, JSON.stringify(resumed).slice(0, 300));
    await waitFor(call, created.id, settled);
    const second = await call("get_worker_result", { task_id: created.id });
    assert.equal(second.acceptance.passed, true);
    assert.equal(second.acceptance.run, 2, "the verdict is the latest run's");
    assert.deepEqual(second.acceptance.commands, [PASS]);

    const followup = await call("create_codex_followup_worker", { task_id: created.id, followup_prompt: "again" });
    assert.ok(!followup.error, JSON.stringify(followup).slice(0, 300));
    await waitFor(call, followup.id, settled);
    const inherited = await call("get_worker_result", { task_id: followup.id });
    assert.deepEqual(inherited.acceptance.commands, [PASS], "inherited from the parent");
    assert.equal(inherited.acceptance.passed, true);

    const cleared = await call("create_codex_followup_worker", { task_id: created.id, followup_prompt: "again", acceptance: [] });
    await waitFor(call, cleared.id, settled);
    const none = await call("get_worker_result", { task_id: cleared.id });
    assert.equal(none.acceptance.configured, false);
  });
});

test("a cancelled worker runs no checks; an interrupted run is reconciled and refused by land", async () => {
  const home = await tempHome("supervisor-acceptance-");
  const { dir } = await makeRepo(join(home, "repo"));
  let id;
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "hang" }, async ({ call }) => {
    const created = await call("create_codex_worker", dispatchArgs("killed", dir, { acceptance: PASS }));
    id = created.id;
    await waitFor(call, id, (t) => t.phase === "thinking");
    await call("cancel_codex_worker", { task_id: id });
    const done = await waitFor(call, id, (t) => t.status === "cancelled");
    assert.equal(done.acceptance, null);
  });
  // A row left mid-acceptance by a supervisor that died.
  const db = new DatabaseSync(join(home, "data", "supervisor.sqlite"));
  db.prepare("UPDATE tasks SET status = 'completed', exit_code = NULL, acceptance_results = ? WHERE id = ?")
    .run(JSON.stringify({ status: "running", passed: null, run: 1, supervisor_pid: 2 ** 22 - 1, started_at: new Date().toISOString() }), id);
  db.close();
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const waited = await call("wait_codex_workers", { task_ids: [id], compact: true, timeoutMs: 3000 });
    assert.equal(waited.timed_out, false, "a dead supervisor pid settles the wait");
    assert.equal(waited.workers[0].acceptance, "interrupted");
    const status = await call("get_codex_worker_status", { task_id: id });
    assert.match(status.current_action, /interrupted/);
    const refused = await call("land_codex_worker", { task_id: id });
    assert.equal(refused.error, "acceptance_not_run");
  });
});

test("a read-only verifier may own nothing; a writing worker may not", async () => {
  const home = await tempHome("supervisor-acceptance-");
  const { dir } = await makeRepo(join(home, "repo"));
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const verifier = await call("create_codex_worker", { ...dispatchArgs("verifier", dir), ownedPaths: [], sandbox: "read-only" });
    assert.ok(!verifier.error, JSON.stringify(verifier).slice(0, 300));
    await waitFor(call, verifier.id, settled);
    const writer = await call("create_codex_worker", { ...dispatchArgs("writer", dir), ownedPaths: [], sandbox: "workspace-write" });
    assert.equal(writer.error, "error");
    assert.match(writer.message, /ownedPaths/);
  });
});
