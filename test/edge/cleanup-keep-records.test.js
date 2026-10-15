import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { tempHome, makeRepo, withMcp, dispatchArgs, waitFor, git, repoRoot } from "./helpers.js";

// Removing a landed worktree should not have to throw away the ledger: --keep-records
// deletes the directory and the branch, keeps the task row and its run log.
test("cleanup --keep-records frees the worktree and keeps the task row and log", async () => {
  const home = await tempHome("supervisor-cleanup-keep-");
  const { dir } = await makeRepo(join(home, "repo"));
  let worker;
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    worker = await call("create_codex_worker", dispatchArgs("kept", dir, { ownedPaths: ["kept.txt"] }));
    await waitFor(call, worker.id, (t) => t.status === "completed" && t.exit_code != null);
    await writeFile(join(worker.worktree_path, "kept.txt"), "kept\n");
    git(worker.worktree_path, ["add", "-A"]);
    git(worker.worktree_path, ["commit", "-q", "-m", "kept"]);
    const landed = await call("land_codex_worker", { task_id: worker.id });
    assert.ok(!landed.error, JSON.stringify(landed));
  });
  const logPath = join(home, "data", "runs", `${worker.id}.jsonl`);
  assert(existsSync(logPath), "the run log exists before cleanup");
  const run = (args) => JSON.parse(execFileSync(process.execPath, [join(repoRoot, "src", "cleanup.js"), "--days", "0", ...args], {
    encoding: "utf8", env: { ...process.env, SUPERVISOR_HOME: home, CODEX_HOME: join(home, "codex") }, timeout: 20000
  }));
  const applied = run(["--apply", "--keep-records"]);
  assert.equal(applied.records_kept, true);
  assert.equal(applied.deleted.worktrees, 1);
  assert.equal(applied.deleted.tasks, 0, "the row is not deleted");
  assert.equal(applied.deleted.jsonl, 0, "the run log is not deleted");
  assert(!existsSync(worker.worktree_path), "the worktree is gone");
  assert.equal(git(dir, ["branch", "--list", `codex/${worker.id}`]), "", "the branch is gone");
  const db = new DatabaseSync(join(home, "data", "supervisor.sqlite"));
  assert.equal(db.prepare("SELECT count(*) AS n FROM tasks").get().n, 1, "the task row stays");
  db.close();
  assert(existsSync(logPath), "the run log stays");
});

