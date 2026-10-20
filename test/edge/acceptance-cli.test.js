import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { join } from "node:path";
import { dispatchArgs, makeRepo, repoRoot, tempHome, waitFor, waitForRunHostExit, withMcp } from "./helpers.js";

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

test("the worker acceptance CLI reads a readonly supervisor store without writing it", {
  skip: process.platform === "win32" ? "POSIX permissions are required" : false
}, async () => {
  const home = await tempHome("supervisor-accept-cli-readonly-");
  const { dir: repo } = await makeRepo(join(home, "repo"));
  let created;
  let final;
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    created = await call("create_codex_worker", dispatchArgs("accept-cli-readonly", repo, {
      acceptance: ['node -e "console.log(\'readonly-store-ok\')"']
    }));
    final = await waitFor(call, created.id, (task) => task.exit_code === 0 && task.acceptance === "passed");
  });
  await waitForRunHostExit(home, created.id);

  const dataDir = join(home, "data");
  const database = join(dataDir, "supervisor.sqlite");
  const db = new DatabaseSync(database);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;");
  db.close();
  const before = readFileSync(database);
  const originalDirMode = 0o755;
  const originalDbMode = 0o644;
  chmodSync(database, 0o444);
  chmodSync(dataDir, 0o555);
  try {
    const { stdout } = await exec(process.execPath, [join(repoRoot, "src", "acceptance-cli.js")], {
      env: { ...process.env, SUPERVISOR_HOME: home, CODEX_SUPERVISOR_TASK_ID: created.id,
        CODEX_SUPERVISOR_BASE_COMMIT: final.base_commit, CODEX_SUPERVISOR_RUN: String(final.run_count) },
      cwd: final.worktree_path
    });
    const result = JSON.parse(stdout.trim());
    assert.equal(result.passed, true);
    assert.match(result.checks[0].output_tail, /readonly-store-ok/);
    assert.deepEqual(readFileSync(database), before, "the self-check must not modify the supervisor database");
  } finally {
    chmodSync(dataDir, originalDirMode);
    chmodSync(database, originalDbMode);
  }
});
