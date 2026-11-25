import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { dispatchArgs, git, makeRepo, tempHome, waitFor, waitForRunHostExit, withMcp, openStore } from "./helpers.js";

async function readyWorker(home, call, repo, remote) {
  const worker = await call("create_codex_worker", dispatchArgs("ready", repo, {
    sandbox: "workspace-write",
    ownedPaths: ["committed.txt", "uncommitted.txt"],
    acceptance: ["node -e \"process.exit(0)\""]
  }));
  await waitFor(call, worker.id, (task) => task.status === "completed" && task.exit_code === 0);
  await waitForRunHostExit(home, worker.id);
  const landed = await call("land_codex_worker", { task_id: worker.id, commitMessage: "land ready" });
  assert.ok(!landed.error, JSON.stringify(landed));
  git(repo, ["push", "-q", remote, "main"]);
  const verified = await call("verify_delivery_push", { task_id: worker.id, remote });
  assert.ok(verified.push_verified_at, JSON.stringify(verified));
  const settled = openStore(home);
  settled.prepare("UPDATE tasks SET pid=NULL, run_host_pid=NULL, acceptance_results=json_remove(acceptance_results,'$.supervisor_pid') WHERE id=?").run(worker.id);
  settled.close();
  return worker;
}

test("cleanup MCP plans, revalidates fingerprints and retains ledger history", async () => {
  const home = await tempHome("supervisor-cleanup-plan-");
  const { dir } = await makeRepo(join(home, "repo"));
  const remotePath = join(home, "remote.git");
  await mkdir(remotePath);
  execFileSync("git", ["init", "--bare", "-q", remotePath]);
  git(dir, ["remote", "add", "origin", remotePath]);
  git(dir, ["push", "-q", "-u", "origin", "main"]);
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "commit-in-worktree" }, async ({ call }) => {
    const worker = await readyWorker(home, call, dir, "origin");
    const plan = await call("cleanup_plan", { task_ids: [worker.id] });
    assert.equal(plan.summary.safe, 1);
    const item = plan.items[0];
    const db = openStore(home);
    db.prepare("UPDATE cleanup_plans SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), plan.plan_id);
    db.close();
    const expired = await call("apply_cleanup", { plan_id: plan.plan_id, item_ids: [item.id] });
    assert.equal(expired.error, "cleanup_plan_expired");
    const fresh = await call("cleanup_plan", { task_ids: [worker.id] });
    const freshItem = fresh.items[0];
    assert.equal(freshItem.verdict, "safe", JSON.stringify(fresh));
    await writeFile(join(worker.worktree_path, "drift.txt"), "changed after plan\n");
    const drifted = await call("apply_cleanup", { plan_id: fresh.plan_id, item_ids: [freshItem.id] });
    assert.equal(drifted.applied.length, 0);
    assert.match(drifted.skipped[0].reason, /no longer safe|changed since cleanup plan/);
    assert(existsSync(worker.worktree_path));

    await rm(join(worker.worktree_path, "drift.txt"));
    const replanned = await call("cleanup_plan", { task_ids: [worker.id] });
    const safe = replanned.items.find((entry) => entry.verdict === "safe");
    assert.ok(safe, JSON.stringify(replanned));
    const applied = await call("apply_cleanup", { plan_id: replanned.plan_id, item_ids: [safe.id] });
    assert.equal(applied.applied.length, 1);
    assert(!existsSync(worker.worktree_path));
    const history = await call("cleanup_history", { task_id: worker.id });
    assert.ok(history.items.some((entry) => entry.applied_at));
  });
});

test("landing alone makes a worktree safe; a live process blocks it and a landed commit that left the target does not count", async () => {
  const home = await tempHome("supervisor-cleanup-policy-");
  const { dir, first } = await makeRepo(join(home, "repo"));
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "commit-in-worktree", CODEX_SUPERVISOR_NO_AUTO_CLEANUP: "1" }, async ({ call }) => {
    const landedOnly = async (title) => {
      const worker = await call("create_codex_worker", dispatchArgs(title, dir, { sandbox: "workspace-write", ownedPaths: ["committed.txt", "uncommitted.txt"] }));
      await waitFor(call, worker.id, (task) => task.status === "completed" && task.exit_code === 0);
      await waitForRunHostExit(home, worker.id);
      const landed = await call("land_codex_worker", { task_id: worker.id, commitMessage: `land ${title}` });
      assert.ok(!landed.error, JSON.stringify(landed));
      return worker;
    };
    const verdictOf = async (worker) => (await call("cleanup_plan", { task_ids: [worker.id] })).items[0];

    const plain = await landedOnly("no-acceptance-no-push");
    assert.equal((await verdictOf(plain)).verdict, "safe");

    const db = openStore(home);
    db.prepare("UPDATE tasks SET pid = ? WHERE id = ?").run(process.pid, plain.id);
    assert.equal((await verdictOf(plain)).verdict, "blocked");
    db.prepare("UPDATE tasks SET pid = NULL WHERE id = ?").run(plain.id);
    db.close();

    // The plan was made while the commit was on main. Main then loses it.
    const plan = await call("cleanup_plan", { task_ids: [plain.id] });
    git(dir, ["reset", "-q", "--hard", first]);
    const applied = await call("apply_cleanup", { plan_id: plan.plan_id, item_ids: [plan.items[0].id] });
    assert.equal(applied.applied.length, 0, JSON.stringify(applied));
    assert(existsSync(plain.worktree_path));
    assert.equal((await verdictOf(plain)).verdict, "review", "work that is no longer on the target is unlanded work again");
  });
});
