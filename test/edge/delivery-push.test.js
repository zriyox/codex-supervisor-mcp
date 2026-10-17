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
      ownedPaths: ["committed.txt", "uncommitted.txt"],
      acceptance: ["node -e \"process.exit(0)\""]
    }));
    await waitFor(call, worker.id, (task) => task.status === "completed" && task.exit_code === 0);
    const landed = await call("land_codex_worker", { task_id: worker.id, commitMessage: "land delivery draft" });
    assert.ok(!landed.error, JSON.stringify(landed));
    const beforePush = await call("verify_delivery_push", { task_id: worker.id });
    assert.equal(beforePush.error, "not_pushed");
    git(dir, ["push", "-q", "origin", "main"]);
    const verified = await call("verify_delivery_push", { task_id: worker.id });
    assert.ok(verified.push_verified_at, JSON.stringify(verified));
    assert.match(verified.artifact_id, /^[a-f0-9-]{36}$/);
    const evidence = await call("get_worker_evidence", { task_id: worker.id });
    const proof = evidence.artifacts.find((artifact) => artifact.id === verified.artifact_id);
    assert.equal(proof.type, "push_proof");
    const artifact = await call("get_artifact", { artifact_id: verified.artifact_id });
    const content = JSON.parse(artifact.artifact.content);
    assert.equal(content.landed_head, verified.landed_head);
    assert.equal(content.remote_head, verified.remote_head);
  });

  const db = new DatabaseSync(join(home, "data", "supervisor.sqlite"));
  const task = db.prepare("SELECT landed_head, landed_branch, push_verified_at, push_remote, push_branch, push_remote_head FROM tasks WHERE id = ?").get(worker.id);
  assert.equal(task.landed_branch, "main");
  assert.equal(task.push_remote, "origin");
  assert.equal(task.push_branch, "main");
  assert.match(task.push_remote_head, /^[a-f0-9]{40}$/);
  assert.ok(task.push_verified_at);
  assert.equal(db.prepare("SELECT delivery_state FROM work_items WHERE task_id = ?").get(worker.id).delivery_state, "cleanup_eligible");
  const keys = db.prepare("SELECT key FROM facts WHERE work_item_id = (SELECT id FROM work_items WHERE task_id = ?) ORDER BY created_at").all(worker.id).map((row) => row.key);
  assert.ok(keys.includes("landed"));
  assert.ok(keys.includes("push_verified"));
  const proof = db.prepare("SELECT id, type FROM artifacts WHERE run_id = (SELECT id FROM runs WHERE task_id = ? ORDER BY attempt DESC LIMIT 1)").get(worker.id);
  assert.equal(proof.type, "push_proof");
  db.close();
});
