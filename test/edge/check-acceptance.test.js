import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tempHome, makeRepo, withMcp, listWorkers } from "./helpers.js";

test("acceptance preflight runs in the requested repo and creates no worker", async () => {
  const home = await tempHome("supervisor-preflight-");
  const { dir, second } = await makeRepo(join(home, "repo"));
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const result = await call("preflight_worker", {
      cwd: dir,
      acceptance: { commands: 'node -e "console.log(process.env.AGENT_SUPERVISOR_BASE_COMMIT)"' }
    });
    assert.equal(result.phase, "preflight");
    assert.equal(result.passed, true);
    assert.equal(result.base_commit, second);
    assert.equal(result.checks[0].output_tail, second);
    assert.equal(result.proves_worker_completion, false);
    const workers = await listWorkers(call);
    assert.deepEqual(workers, []);
  });
});

test("preflight preserves failure output and distinguishes a bad base reference", async () => {
  const home = await tempHome("supervisor-preflight-");
  const { dir } = await makeRepo(join(home, "repo"));
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const failed = await call("preflight_worker", { cwd: dir, acceptance: { commands: 'node -e "console.error(\'failure evidence\');process.exit(7)"' } });
    assert.equal(failed.passed, false);
    assert.equal(failed.checks[0].exit_code, 7);
    assert.match(failed.checks[0].output_tail, /failure evidence/);
    const invalid = await call("preflight_worker", { cwd: dir, workspace: { base_ref: "missing-ref" }, acceptance: { commands: "true" } });
    assert.equal(invalid.error, "invalid_base_ref");
  });
});

test("preflight flags failure-count greps as insufficient baseline evidence", async () => {
  const home = await tempHome("supervisor-preflight-");
  const { dir } = await makeRepo(join(home, "repo"));
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const result = await call("preflight_worker", { cwd: dir, acceptance: { commands: 'printf "failures=16\\n" | grep -q "failures=16"' } });
    assert.equal(result.passed, true, "the command really exits zero, not a synthetic failure");
    assert.ok(result.warnings.some((warning) => /count.*baseline|baseline.*count/.test(warning)));
    assert.equal(result.proves_worker_completion, false);
  });
});
