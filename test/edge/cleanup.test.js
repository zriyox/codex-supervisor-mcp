import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dispatchArgs, git, makeRepo, repoRoot, tempHome, waitFor, waitForRunHostExit, withMcp, openStore } from "./helpers.js";

function runCleanup(home, args) {
  return JSON.parse(execFileSync(process.execPath, [join(repoRoot, "src", "interface", "bin", "cleanup.js"), ...args], {
    encoding: "utf8",
    env: { ...process.env, SUPERVISOR_HOME: home, CODEX_HOME: join(home, "codex") },
    timeout: 30000
  }));
}

function runCleanupWith(home, env, args) {
  return JSON.parse(execFileSync(process.execPath, [join(repoRoot, "src", "interface", "bin", "cleanup.js"), ...args], {
    encoding: "utf8",
    env: { ...process.env, SUPERVISOR_HOME: home, CODEX_HOME: join(home, "codex"), ...env },
    timeout: 30000
  }));
}

test("the cleanup CLI removes landed worktrees, keeps unsaved edits through the hold period, then checkpoints them", async () => {
  const home = await tempHome("supervisor-cleanup-");
  const { dir } = await makeRepo(join(home, "repo"));
  const workers = {};
  await withMcp({ SUPERVISOR_HOME: home, CODEX_SUPERVISOR_NO_AUTO_CLEANUP: "1" }, async ({ call }) => {
    for (const title of ["landed", "edited"]) {
      const worker = await call("create_codex_worker", dispatchArgs(title, dir, {
        sandbox: "workspace-write",
        ownedPaths: [`${title}.txt`]
      }));
      await waitFor(call, worker.id, (task) => task.status === "completed" && task.exit_code === 0);
      await writeFile(join(worker.worktree_path, `${title}.txt`), `${title}\n`);
      git(worker.worktree_path, ["add", "-A"]);
      git(worker.worktree_path, ["commit", "-q", "-m", `land ${title}`]);
      const landed = await call("land_codex_worker", { task_id: worker.id });
      assert.ok(!landed.error, JSON.stringify(landed));
      workers[title] = worker;
    }
  });
  await Promise.all(Object.values(workers).map((worker) => waitForRunHostExit(home, worker.id)));
  // An edit made after landing exists nowhere but this worktree.
  await writeFile(join(workers.edited.worktree_path, "precious.txt"), "keep\n");
  const logPath = join(home, "data", "runs", `${workers.landed.id}.jsonl`);
  const preview = runCleanup(home, ["--dry-run"]);
  const landed = preview.items.find((item) => item.task_id === workers.landed.id);
  const edited = preview.items.find((item) => item.task_id === workers.edited.id);
  assert.equal(landed.verdict, "safe", "landing is enough; no push or acceptance verdict is required");
  assert.equal(edited.verdict, "review");
  assert.ok(Date.parse(edited.eligible_after) > Date.now(), "the item says when it becomes removable");
  assert.throws(() => runCleanup(home, ["--apply", "--task", workers.landed.id]), /--apply requires --plan/);
  const applied = runCleanup(home, ["--apply", "--plan", preview.plan_id, "--item", landed.id, "--item", edited.id]);
  assert.equal(applied.applied.length, 1, JSON.stringify(applied));
  assert(!existsSync(workers.landed.worktree_path));
  assert(existsSync(workers.edited.worktree_path), "a review item is never removed");
  assert.notEqual(git(dir, ["branch", "--list", `codex/${workers.landed.id}`]), "", "branch is retained");
  assert(existsSync(logPath), "JSONL is retained");
  const db = openStore(home);
  assert.equal(db.prepare("SELECT count(*) AS count FROM tasks WHERE id = ?").get(workers.landed.id).count, 1, "task row is retained");
  assert.ok(db.prepare("SELECT count(*) AS count FROM task_events WHERE task_id = ?").get(workers.landed.id).count > 0, "events are retained");
  assert.equal(db.prepare("SELECT delivery_state FROM work_items WHERE task_id = ?").get(workers.landed.id).delivery_state, "cleanup_removed");
  db.close();

  // Once the hold period is over the edits are committed to the branch, then the worktree goes.
  const later = runCleanupWith(home, { CODEX_SUPERVISOR_CLEANUP_HOLD_DAYS: "0" }, ["--dry-run"]);
  const due = later.items.find((item) => item.task_id === workers.edited.id);
  assert.equal(due.verdict, "safe");
  const removed = runCleanupWith(home, { CODEX_SUPERVISOR_CLEANUP_HOLD_DAYS: "0" }, ["--apply", "--plan", later.plan_id, "--item", due.id]);
  assert.equal(removed.applied.length, 1, JSON.stringify(removed));
  assert.ok(removed.applied[0].checkpoint_commit, "the unsaved edit was committed first");
  assert(!existsSync(workers.edited.worktree_path));
  assert.equal(git(dir, ["show", `codex/${workers.edited.id}:precious.txt`]), "keep");
});
