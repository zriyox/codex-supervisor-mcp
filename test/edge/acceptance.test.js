// Acceptance: the supervisor's own run of the dispatcher's checks after the
// worker exits, the verdict on every read, and the gate on landing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dispatchArgs, git, makeRepo, tempHome, waitFor, withMcp } from "./helpers.js";
import { runAcceptance } from "../../src/acceptance.js";

// Bash shell lines also accepted by the original sh/cmd runner, so RED does
// not depend on a syntax change in the reproducer.
const PASS = 'node -e "process.exit(0)"';
const FAIL = 'node -e "console.log(\'boom from the check\'); process.exit(3)"';
const HANG = 'node -e "setInterval(function(){}, 1000)"';
const WRITES_MARKER = 'node -e "require(\'fs\').writeFileSync(\'ran.txt\', \'yes\')"';
const DRAIN = 'node -e "process.stdin.resume()"';

const READ_IDENTITY = 'node -e "console.log(JSON.stringify([process.env.CODEX_SUPERVISOR_TASK_ID,process.env.CODEX_SUPERVISOR_BASE_COMMIT,process.env.CODEX_SUPERVISOR_RUN]))"';

test("acceptance identity overrides inherited values without mutating the parent environment", async () => {
  const cwd = await tempHome("supervisor-identity-");
  const env = { ...process.env, CODEX_SUPERVISOR_TASK_ID: "stale", CODEX_SUPERVISOR_BASE_COMMIT: "stale", CODEX_SUPERVISOR_RUN: "99" };
  const result = await runAcceptance([READ_IDENTITY], { cwd, env, taskId: "current", baseCommit: "abc123", run: 2 });
  assert.equal(result.status, "passed");
  assert.deepEqual(JSON.parse(result.checks[0].output_tail), ["current", "abc123", "2"]);
  assert.equal(env.CODEX_SUPERVISOR_RUN, "99");
  const anonymous = await runAcceptance([READ_IDENTITY], { cwd, env });
  assert.deepEqual(JSON.parse(anonymous.checks[0].output_tail), ["", "", ""]);
});

test("acceptance sees the current worker identity after rebase, resume and follow-up", async () => {
  const home = await tempHome("supervisor-identity-");
  const { dir, second } = await makeRepo(join(home, "repo"));
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const worker = await call("create_codex_worker", dispatchArgs("identity", dir, { acceptance: READ_IDENTITY }));
    await waitFor(call, worker.id, settled);
    const first = await call("get_worker_result", { task_id: worker.id });
    assert.deepEqual(JSON.parse(first.acceptance.checks[0].output_tail), [worker.id, second, "1"]);
    await writeFile(join(dir, "new-base.txt"), "main advanced\n");
    git(dir, ["add", "new-base.txt"]);
    git(dir, ["commit", "-q", "-m", "main advanced"]);
    const head = git(dir, ["rev-parse", "HEAD"]);
    const resumed = await call("resume_codex_worker", { task_id: worker.id, prompt: "check new base", rebaseOnto: "HEAD" });
    assert.ok(!resumed.error, JSON.stringify(resumed));
    await waitFor(call, worker.id, (t) => settled(t) && t.run_count === 2);
    const next = await call("get_worker_result", { task_id: worker.id });
    assert.deepEqual(JSON.parse(next.acceptance.checks[0].output_tail), [worker.id, head, "2"]);
    const followup = await call("create_codex_followup_worker", { task_id: worker.id, followup_prompt: "verify identity" });
    assert.ok(!followup.error, JSON.stringify(followup));
    await waitFor(call, followup.id, settled);
    const last = await call("get_worker_result", { task_id: followup.id });
    assert.deepEqual(JSON.parse(last.acceptance.checks[0].output_tail), [followup.id, followup.base_commit, "1"]);
  });
});

test("a successful pipeline consumer cannot hide a failing producer, and later checks do not run", async () => {
  const cwd = await tempHome("supervisor-pipeline-");
  const result = await runAcceptance([`${FAIL} | ${DRAIN}`, PASS], { cwd, timeoutMs: 10000 });
  assert.equal(result.status, "failed");
  assert.equal(result.checks.length, 1);
  assert.equal(result.checks[0].exit_code, 3);
  assert.equal(result.checks[0].timed_out, false);
});

test("a failure followed by a successful statement is not reported as passing", async () => {
  const cwd = await tempHome("supervisor-pipeline-");
  const result = await runAcceptance([`${FAIL}; ${PASS}`], { cwd, timeoutMs: 10000 });
  assert.equal(result.status, "failed");
  assert.equal(result.checks[0].exit_code, 3);
  assert.match(result.checks[0].output_tail, /boom from the check/);
});

test("a failed middle pipeline stage propagates its exit code", async () => {
  const cwd = await tempHome("supervisor-pipeline-");
  const result = await runAcceptance([`${PASS} | ${FAIL} | ${DRAIN}`], { cwd, timeoutMs: 10000 });
  assert.equal(result.status, "failed");
  assert.equal(result.checks[0].exit_code, 3);
});

test("successful pipelines and explicitly handled expected failures still pass", async () => {
  const cwd = await tempHome("supervisor-pipeline-");
  const result = await runAcceptance([
    `${PASS} | ${DRAIN}`,
    `${FAIL} || ${PASS}`,
    `if ${FAIL}; then exit 9; else ${PASS}; fi`,
    `! ${FAIL}`
  ], { cwd, timeoutMs: 10000 });
  assert.equal(result.status, "passed");
  assert.equal(result.checks.length, 4);
  assert.ok(result.checks.every((check) => check.exit_code === 0));
});

test("a quoted pipe is ordinary data, and grep -E can validate the output", async () => {
  const cwd = await tempHome("supervisor-pipeline-");
  const result = await runAcceptance([
    'node -e "console.log(\'left|right\')"',
    'printf "PASS\\n" | grep -E "^PASS$"'
  ], { cwd, timeoutMs: 10000 });
  assert.equal(result.status, "passed");
  assert.equal(result.checks[0].output_tail, "left|right");
});

test("clipping UTF-8 error output preserves the failed pipeline's exit code", async () => {
  const cwd = await tempHome("supervisor-pipeline-");
  const command = `node -e "console.error('错'.repeat(4000));process.exit(7)" | ${DRAIN}`;
  const result = await runAcceptance([command], { cwd, timeoutMs: 10000 });
  assert.equal(result.status, "failed");
  assert.equal(result.checks[0].exit_code, 7);
  assert.ok(Buffer.byteLength(result.checks[0].output_tail, "utf8") <= 2010);
  assert.match(result.checks[0].output_tail, /^…错/);
  assert.ok(!result.checks[0].output_tail.includes("\uFFFD"));
});

test("shell startup files cannot silently disable pipeline failure propagation", async () => {
  const cwd = await tempHome("supervisor-pipeline-");
  const startup = join(cwd, "startup.sh");
  await writeFile(startup, "set +e\nset +o pipefail\n");
  const result = await runAcceptance([`${FAIL} | ${DRAIN}`], {
    cwd, timeoutMs: 10000, env: { ...process.env, BASH_ENV: startup, ENV: startup }
  });
  assert.equal(result.status, "failed");
  assert.equal(result.checks[0].exit_code, 3);
});

test("a pipeline timeout kills its children and cannot become a passing check", async () => {
  const cwd = await tempHome("supervisor-pipeline-");
  const result = await runAcceptance([`${HANG} | ${DRAIN}`, PASS], { cwd, timeoutMs: 1500 });
  assert.equal(result.status, "failed");
  assert.equal(result.checks.length, 1);
  assert.equal(result.checks[0].timed_out, true);
  assert.notEqual(result.checks[0].exit_code, 0);
});

test("a timed-out command that traps termination and exits zero still fails", { skip: process.platform === "win32" }, async () => {
  const cwd = await tempHome("supervisor-pipeline-");
  const result = await runAcceptance([`trap 'exit 0' TERM; ${HANG} & wait`, PASS], { cwd, timeoutMs: 1500 });
  assert.equal(result.checks[0].timed_out, true);
  assert.equal(result.checks[0].exit_code, 0, "preserve the actual exit code instead of inventing one");
  assert.equal(result.status, "failed");
  assert.equal(result.checks.length, 1);
});

test("cancelling a pipeline records cancellation and stops subsequent checks", async () => {
  const cwd = await tempHome("supervisor-pipeline-");
  const control = {};
  const pending = runAcceptance([`${HANG} | ${DRAIN}`, PASS], { cwd, timeoutMs: 10000, control });
  assert.equal(typeof control.kill, "function");
  control.kill();
  const result = await pending;
  assert.equal(result.status, "cancelled");
  assert.equal(result.passed, null);
  assert.equal(result.checks.length, 1);
  assert.equal(result.checks[0].cancelled, true);
  assert.equal(control.kill, null);
});

test("immediate cancellation is settled before timeout across repeated starts", { timeout: 30000 }, async () => {
  const cwd = await tempHome("supervisor-cancel-start-");
  for (let i = 0; i < 8; i++) {
    const control = {};
    const started = Date.now();
    const pending = runAcceptance([`${HANG} | ${DRAIN}`], { cwd, timeoutMs: 10000, control });
    control.kill();
    const result = await pending;
    assert.equal(result.status, "cancelled");
    assert.equal(result.checks[0].timed_out, false);
    assert.ok(Date.now() - started < 8000, "cancellation must not wait for the timeout");
  }
});

test("a failed pipeline blocks land even when the worker reports success", async () => {
  const home = await tempHome("supervisor-pipeline-");
  const { dir } = await makeRepo(join(home, "repo"));
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "commit-in-worktree" }, async ({ call }) => {
    const worker = await call("create_codex_worker", dispatchArgs("pipeline-gate", dir, { acceptance: `${FAIL} | ${DRAIN}` }));
    await waitFor(call, worker.id, settled);
    const result = await call("get_worker_result", { task_id: worker.id });
    assert.equal(result.acceptance.passed, false);
    assert.equal(result.acceptance.checks[0].exit_code, 3);
    const land = await call("land_codex_worker", { task_id: worker.id });
    assert.equal(land.error, "acceptance_failed");
    assert.equal(git(dir, ["rev-list", "--count", "HEAD"]), "2");
  });
});

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

test("landing is recorded on the row, a second land skips what is already there, and drift after landing is not stale", async () => {
  const home = await tempHome("supervisor-acceptance-");
  const { dir } = await makeRepo(join(home, "repo"));
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "commit-in-worktree" }, async ({ call }) => {
    const created = await call("create_codex_worker", dispatchArgs("landed-once", dir, { acceptance: PASS }));
    await waitFor(call, created.id, settled);
    const first = await call("land_codex_worker", { task_id: created.id, commitMessage: "the draft too" });
    assert.ok(!first.error, JSON.stringify(first).slice(0, 300));
    assert.equal(first.landed.length, 2);
    assert.deepEqual(first.already_landed, []);
    const mainHead = git(dir, ["rev-parse", "HEAD"]);

    const result = await call("get_worker_result", { task_id: created.id });
    assert.equal(result.landed.head, mainHead);
    assert.ok(result.landed.at);
    assert.equal(result.base_behind.behind, 2, "main moved by the landed commits");
    assert.equal(result.acceptance.stale, false, "the move is the landing itself, not drift");
    assert.equal(result.acceptance.next_step, null);
    const status = await call("get_codex_worker_status", { task_id: created.id });
    assert.ok(status.landed_at);

    const again = await call("land_codex_worker", { task_id: created.id });
    assert.equal(again.error, "nothing_to_land");
    assert.equal(again.already_landed.length, 2, "both commits are recognised by patch");
    assert.match(again.reason, /already on main/);
    assert.equal(git(dir, ["rev-parse", "HEAD"]), mainHead, "the branch did not move");
  });
});
