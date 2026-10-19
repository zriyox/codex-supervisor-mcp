import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { dispatchArgs, makeRepo, repoRoot, tempHome, waitFor, withMcp } from "./helpers.js";

const exec = promisify(execFile);

test("the worker acceptance CLI uses the stored supervisor contract", async () => {
  const home = await tempHome("supervisor-accept-cli-");
  const { dir: repo } = await makeRepo(join(home, "repo"));
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const created = await call("create_codex_worker", dispatchArgs("accept-cli", repo, {
      acceptance: ['node -e "console.log(\'acceptance-cli-ok\')"']
    }));
    const final = await waitFor(call, created.id, (task) => task.exit_code === 0 && task.acceptance === "passed");
    const { stdout } = await exec(process.execPath, [join(repoRoot, "src", "acceptance-cli.js")], {
      env: { ...process.env, SUPERVISOR_HOME: home, CODEX_SUPERVISOR_TASK_ID: created.id,
        CODEX_SUPERVISOR_BASE_COMMIT: final.base_commit, CODEX_SUPERVISOR_RUN: String(final.run_count) },
      cwd: final.worktree_path
    });
    const result = JSON.parse(stdout.trim());
    assert.equal(result.passed, true);
    assert.equal(result.checks.length, 1);
    assert.match(result.checks[0].output_tail, /acceptance-cli-ok/);
  });
});
