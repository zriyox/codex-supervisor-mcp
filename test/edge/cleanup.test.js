import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dispatchArgs, git, makeRepo, repoRoot, tempHome, waitFor, withMcp } from "./helpers.js";

function runCleanup(home, args) {
  return JSON.parse(execFileSync(process.execPath, [join(repoRoot, "src", "cleanup.js"), ...args], {
    encoding: "utf8",
    env: { ...process.env, SUPERVISOR_HOME: home, CODEX_HOME: join(home, "codex") },
    timeout: 30000
  }));
}

test("cleanup plan only removes verified-safe worktrees and preserves the evidence ledger", async () => {
  const home = await tempHome("supervisor-cleanup-");
  const { dir } = await makeRepo(join(home, "repo"));
  const remote = join(home, "remote.git");
  await mkdir(remote);
  execFileSync("git", ["init", "--bare", "-q", remote]);
  git(dir, ["remote", "add", "origin", remote]);
  git(dir, ["push", "-q", "-u", "origin", "main"]);
  const workers = {};
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    for (const title of ["safe", "dirty", "unverified"]) {
      const worker = await call("create_codex_worker", dispatchArgs(title, dir, { sandbox: "workspace-write", ownedPaths: [`${title}.txt`] }));
      await waitFor(call, worker.id, (task) => task.status === "completed" && task.exit_code === 0);
      await writeFile(join(worker.worktree_path, `${title}.txt`), `${title}\n`);
      git(worker.worktree_path, ["add", "-A"]);
      git(worker.worktree_path, ["commit", "-q", "-m", `land ${title}`]);
      const landed = await call("land_codex_worker", { task_id: worker.id });
      assert.ok(!landed.error, JSON.stringify(landed));
      workers[title] = worker;
      if (title === "safe" || title === "dirty") {
        git(dir, ["push", "-q", "origin", "main"]);
        const verified = await call("verify_delivery_push", { task_id: worker.id });
        assert.ok(verified.push_verified_at, JSON.stringify(verified));
      }
    }
  });
  await writeFile(join(workers.dirty.worktree_path, "precious.txt"), "keep\n");
  const logPath = join(home, "data", "runs", `${workers.safe.id}.jsonl`);
  const branch = `codex/${workers.safe.id}`;
  const preview = runCleanup(home, ["--dry-run"]);
  const safe = preview.items.find((item) => item.task_id === workers.safe.id);
  const dirty = preview.items.find((item) => item.task_id === workers.dirty.id);
  const unverified = preview.items.find((item) => item.task_id === workers.unverified.id);
  assert.equal(safe.verdict, "safe");
  assert.equal(dirty.verdict, "blocked");
  assert.equal(unverified.verdict, "blocked");
  assert.match(unverified.reasons.join(" "), /remote delivery/);
  const applied = runCleanup(home, ["--apply", "--task", workers.safe.id]);
  assert.equal(applied.applied.length, 1, JSON.stringify(applied));
  assert(!existsSync(workers.safe.worktree_path));
  assert(existsSync(workers.dirty.worktree_path));
  assert(existsSync(workers.unverified.worktree_path));
  assert.notEqual(git(dir, ["branch", "--list", branch]), "", "branch is retained");
  assert(existsSync(logPath), "JSONL is retained");
  const db = new DatabaseSync(join(home, "data", "supervisor.sqlite"));
  assert.equal(db.prepare("SELECT count(*) AS count FROM tasks WHERE id = ?").get(workers.safe.id).count, 1, "task row is retained");
  assert.ok(db.prepare("SELECT count(*) AS count FROM task_events WHERE task_id = ?").get(workers.safe.id).count > 0, "events are retained");
  assert.equal(db.prepare("SELECT delivery_state FROM work_items WHERE task_id = ?").get(workers.safe.id).delivery_state, "cleanup_removed");
  assert.ok(db.prepare("SELECT applied_at FROM cleanup_plan_items WHERE task_id = ? AND applied_at IS NOT NULL").get(workers.safe.id).applied_at);
  db.close();
});
