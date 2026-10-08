// get_worker_result: clipped by default with a way back to the whole report,
// files as a count unless asked (or unless there is no worktree to diff), and
// verification that exposes what the worker actually ran.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { dispatchArgs, makeRepo, tempHome, waitFor, withMcp } from "./helpers.js";

test("a long report is clipped head-and-tail by default and comes back whole on request", async () => {
  const home = await tempHome("supervisor-result-");
  const { dir } = await makeRepo(join(home, "repo"));
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_MESSAGE_LEN: "20000" }, async ({ call }) => {
    const created = await call("create_codex_worker", dispatchArgs("long-report", dir));
    await waitFor(call, created.id, (t) => t.status === "completed" && t.exit_code !== null);
    const clipped = await call("get_worker_result", { task_id: created.id });
    assert.equal(clipped.truncated, true);
    assert.equal(clipped.report_bytes.length, 1);
    assert.ok(clipped.report_bytes[0] >= 20000, "the full size is reported");
    assert.ok(Buffer.byteLength(clipped.reports[0], "utf8") < 6200, "the report is clipped to about maxChars");
    assert.match(clipped.reports[0], /chars truncated/);
    assert.match(clipped.next_step, new RegExp(`maxChars: ${clipped.report_bytes[0]}`), "next_step names the size to ask for");
    const head = clipped.reports[0].indexOf("\n…");
    assert.ok(head > 3500, "most of the budget goes to the head of the report");

    const whole = await call("get_worker_result", { task_id: created.id, maxChars: 0 });
    assert.equal(whole.truncated, false);
    assert.equal(whole.next_step, null);
    assert.equal(Buffer.byteLength(whole.reports[0], "utf8"), whole.report_bytes[0]);
  });
});

test("files are a count by default, a list with includeFiles, and always a list for a worker without a worktree", async () => {
  const home = await tempHome("supervisor-result-");
  const { dir } = await makeRepo(join(home, "repo"));
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const inRepo = await call("create_codex_worker", dispatchArgs("with-worktree", dir));
    await waitFor(call, inRepo.id, (t) => t.status === "completed" && t.exit_code !== null);
    const bare = await call("get_worker_result", { task_id: inRepo.id });
    assert.equal(bare.changed_files, undefined);
    assert.equal(typeof bare.changed_file_count, "number");
    const listed = await call("get_worker_result", { task_id: inRepo.id, includeFiles: true });
    assert.ok(Array.isArray(listed.changed_files));
    assert.equal(listed.changed_files.length, listed.changed_file_count);

    const plain = join(home, "workspace");
    const inPlace = await call("create_codex_worker", dispatchArgs("in-place", plain));
    assert.equal(inPlace.worktree_path, null, "a non-git cwd runs in place");
    await waitFor(call, inPlace.id, (t) => t.status === "completed" && t.exit_code !== null);
    const result = await call("get_worker_result", { task_id: inPlace.id });
    assert.deepEqual(result.changed_files, ["/tmp/fake/one.ts", "/tmp/fake/two.ts"], "event-sourced files are the only record and are never hidden");
    assert.equal(result.changed_file_count, 2);
    const diff = await call("get_worker_diff", { task_id: inPlace.id });
    assert.equal(diff.error, "no_worktree");
    assert.match(diff.reason, /includeFiles: true/);
  });
});

test("verification shows a failing check behind a report that claims success", async () => {
  const home = await tempHome("supervisor-result-");
  const { dir } = await makeRepo(join(home, "repo"));
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "failing-command" }, async ({ call }) => {
    const created = await call("create_codex_worker", dispatchArgs("liar", dir));
    await waitFor(call, created.id, (t) => t.status === "completed" && t.exit_code !== null);
    const result = await call("get_worker_result", { task_id: created.id });
    assert.match(result.reports[0], /All tests pass/);
    const v = result.verification;
    assert.equal(v.runs, 1);
    assert.equal(v.commands_run, 2);
    assert.equal(v.failed_count, 1);
    assert.equal(v.last_exit_code, 0);
    assert.equal(v.last_command_failed, false);
    assert.equal(v.failed.length, 1);
    assert.equal(v.failed[0].command, "npm test");
    assert.equal(v.failed[0].exit_code, 1);
    assert.match(v.failed[0].output_tail, /npm ERR! Test failed/, "the tail of the failing output is kept");
    assert.ok(v.failed[0].output_tail.startsWith("…"), "a cut tail is marked");
    assert.ok(Buffer.byteLength(v.failed[0].output_tail, "utf8") <= 310);
    assert.deepEqual(v.last.map((c) => [c.command, c.exit_code, c.failed]), [["npm test", 1, true], ["echo done", 0, false]]);
  });
});

test("verification on a worker that ran nothing says so", async () => {
  const home = await tempHome("supervisor-result-");
  const { dir } = await makeRepo(join(home, "repo"));
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "echo-prompt" }, async ({ call }) => {
    const created = await call("create_codex_worker", dispatchArgs("no-commands", dir));
    await waitFor(call, created.id, (t) => t.status === "completed" && t.exit_code !== null);
    const { verification } = await call("get_worker_result", { task_id: created.id });
    assert.equal(verification.commands_run, 0);
    assert.equal(verification.last_exit_code, null);
    assert.equal(verification.last_command_failed, false);
    assert.deepEqual(verification.failed, []);
  });
});
