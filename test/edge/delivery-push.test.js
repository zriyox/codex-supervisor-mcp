import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { dispatchArgs, git, makeRepo, tempHome, waitFor, withMcp } from "./helpers.js";

test("land and remote push verification are distinct delivery states", async () => {
  const home = await tempHome("supervisor-delivery-");
  const { dir } = await makeRepo(join(home, "repo"));
  const remote = join(home, "remote.git");
  await mkdir(remote, { recursive: true });
  execFileSync("git", ["init", "--bare", "-q", remote]);
  git(dir, ["remote", "add", "origin", remote]);
  git(dir, ["push", "-q", "-u", "origin", "main"]);

  let worker;
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "commit-in-worktree" }, async ({ call }) => {
    worker = await call("create_codex_worker", dispatchArgs("delivery", dir, {
      sandbox: "workspace-write",
      ownedPaths: ["committed.txt", "uncommitted.txt"]
    }));
    await waitFor(call, worker.id, (task) => task.status === "completed" && task.exit_code === 0);
    const landed = await call("land_codex_worker", { task_id: worker.id, commitMessage: "land delivery draft" });
    assert.ok(!landed.error, JSON.stringify(landed));
    const beforePush = await call("verify_delivery_push", { task_id: worker.id });
    assert.equal(beforePush.error, "not_pushed");
    git(dir, ["push", "-q", "origin", "main"]);
    const verified = await call("verify_delivery_push", { task_id: worker.id });
    assert.ok(verified.push_verified_at, JSON.stringify(verified));
  });

  const db = new DatabaseSync(join(home, "data", "supervisor.sqlite"));
  const task = db.prepare("SELECT landed_head, landed_branch, push_verified_at, push_remote, push_branch FROM tasks WHERE id = ?").get(worker.id);
  assert.equal(task.landed_branch, "main");
  assert.equal(task.push_remote, "origin");
  assert.equal(task.push_branch, "main");
  assert.ok(task.push_verified_at);
  assert.equal(db.prepare("SELECT delivery_state FROM work_items WHERE task_id = ?").get(worker.id).delivery_state, "push_verified");
  const keys = db.prepare("SELECT key FROM facts WHERE work_item_id = (SELECT id FROM work_items WHERE task_id = ?) ORDER BY created_at").all(worker.id).map((row) => row.key);
  assert.ok(keys.includes("landed"));
  assert.ok(keys.includes("push_verified"));
  db.close();
});
