import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runAcceptance, normalizeAcceptance } from "../../src/acceptance.js";
import { tempHome, makeRepo, withMcp, dispatchArgs, waitFor, git } from "./helpers.js";

const baseline = { identity: { base_commit: "base" }, failures: [], required: ["must-run"] };
function emit(overrides = {}) {
  const report = { complete: true, identity: { base_commit: "base" }, executed: ["must-run"], skipped: [], failures: [], ...overrides };
  return `node -e "const r=${JSON.stringify(report).replaceAll('"', '\\"')};r.check_id=process.env.CODEX_SUPERVISOR_CHECK_ID;require('fs').writeFileSync('evidence.json',JSON.stringify(r))"`;
}
const check = (command = emit(), extra = {}) => ({ command, reportPath: "evidence.json", baseline, ...extra });

test("structured checks keep their approved baseline and execute fresh evidence", async () => {
  const cwd = await tempHome("supervisor-evidence-");
  const checks = normalizeAcceptance([check()]);
  assert.deepEqual(checks[0].baseline, baseline);
  const result = await runAcceptance(checks, { cwd, baseCommit: "base", taskId: "task", run: 1 });
  assert.equal(result.status, "passed");
  assert.equal(result.checks[0].baseline.passed, true);
  assert.equal(result.checks[0].exit_code, 0);
});

test("a skipped required test cannot turn a zero-exit command into a passing check", async () => {
  const cwd = await tempHome("supervisor-evidence-");
  const result = await runAcceptance([check(emit({ executed: [], skipped: ["must-run"] }))], { cwd, baseCommit: "base" });
  assert.equal(result.status, "failed");
  assert.equal(result.checks[0].exit_code, 0);
  assert.equal(result.checks[0].passed, false);
  assert.deepEqual(result.checks[0].baseline.missing_required, ["must-run"]);
});

test("missing, reused and wrong-base reports fail closed", async () => {
  for (const mode of ["missing", "reused", "wrong-base"]) {
    const cwd = await tempHome("supervisor-evidence-");
    if (mode === "reused") await writeFile(join(cwd, "evidence.json"), JSON.stringify({ complete: true, check_id: "old", identity: { base_commit: "base" }, executed: ["must-run"], skipped: [], failures: [] }));
    const command = mode === "wrong-base" ? emit({ identity: { base_commit: "old-base" } }) : 'node -e "process.exit(0)"';
    const result = await runAcceptance([check(command)], { cwd, baseCommit: "base" });
    assert.equal(result.status, "failed", mode);
    assert.equal(result.checks[0].passed, false, mode);
  }
});

test("stale approval after rebase fails even when the report matches that stale approval", async () => {
  const cwd = await tempHome("supervisor-evidence-");
  const result = await runAcceptance([check()], { cwd, baseCommit: "new-base" });
  assert.equal(result.status, "failed");
  assert.match(result.checks[0].error, /base/);
});

test("report paths cannot escape the worktree and malformed configuration is rejected", async () => {
  for (const item of [check(emit(), { reportPath: "../outside.json" }), { command: "true", baseline }, { command: "true", reportPath: "evidence.json" }]) {
    assert.throws(() => normalizeAcceptance([item]));
  }
});

test("baseline failures preserve a real nonzero shell status and stop later checks", async () => {
  const cwd = await tempHome("supervisor-evidence-");
  const result = await runAcceptance([check('node -e "process.exit(7)"'), 'node -e "process.exit(0)"'], { cwd, baseCommit: "base" });
  assert.equal(result.status, "failed");
  assert.equal(result.checks.length, 1);
  assert.equal(result.checks[0].exit_code, 7);
});

test("MCP accepts structured evidence checks and refuses skipped required tests at land", async () => {
  const home = await tempHome("supervisor-evidence-mcp-");
  const { dir, second } = await makeRepo(join(home, "repo"));
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "commit-in-worktree" }, async ({ call }) => {
    const evidence = check(emit({ identity: { base_commit: second }, executed: [], skipped: ["must-run"] }), {
      baseline: { ...baseline, identity: { base_commit: second } }
    });
    const worker = await call("create_codex_worker", dispatchArgs("evidence-mcp", dir, { acceptance: [evidence] }));
    assert.ok(worker.id, JSON.stringify(worker));
    await waitFor(call, worker.id, (t) => t.status === "completed" && t.exit_code !== null);
    const result = await call("get_worker_result", { task_id: worker.id });
    assert.equal(result.acceptance.passed, false);
    assert.equal(result.acceptance.checks[0].exit_code, 0);
    assert.equal(result.acceptance.checks[0].passed, false);
    assert.match(result.acceptance.next_step, /evidence|baseline/);
    const summary = await call("get_worker_summary", { task_id: worker.id });
    assert.match(summary.summary, /0\/1 passed/);
    const land = await call("land_codex_worker", { task_id: worker.id });
    assert.equal(land.error, "acceptance_failed");
    assert.equal(git(dir, ["rev-list", "--count", "HEAD"]), "2");
  });
});
