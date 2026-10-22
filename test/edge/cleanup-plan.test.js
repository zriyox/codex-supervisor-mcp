import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { dispatchArgs, git, makeRepo, tempHome, waitFor, waitForRunHostExit, withMcp } from "./helpers.js";

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
  const settled = new DatabaseSync(join(home, "data", "supervisor.sqlite"));
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
    const db = new DatabaseSync(join(home, "data", "supervisor.sqlite"));
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

test("cleanup blocks no-acceptance workers and rechecks remote reachability before apply", async () => {
  const home = await tempHome("supervisor-cleanup-remote-recheck-");
  const { dir, first } = await makeRepo(join(home, "repo"));
  const remotePath = join(home, "remote.git");
  await mkdir(remotePath);
  execFileSync("git", ["init", "--bare", "-q", remotePath]);
  git(dir, ["remote", "add", "origin", remotePath]);
  git(dir, ["push", "-q", "-u", "origin", "main"]);
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "commit-in-worktree" }, async ({ call }) => {
    const noAcceptance = await call("create_codex_worker", dispatchArgs("no-acceptance", dir, {
      sandbox: "workspace-write", ownedPaths: ["committed.txt", "uncommitted.txt"]
    }));
    await waitFor(call, noAcceptance.id, (task) => task.status === "completed" && task.exit_code === 0);
    await waitForRunHostExit(home, noAcceptance.id);
    const landedWithoutAcceptance = await call("land_codex_worker", { task_id: noAcceptance.id, commitMessage: "land without acceptance" });
    assert.ok(!landedWithoutAcceptance.error, JSON.stringify(landedWithoutAcceptance));
    git(dir, ["push", "-q", "origin", "main"]);
    assert.ok((await call("verify_delivery_push", { task_id: noAcceptance.id })).push_verified_at);
    const noAcceptancePlan = await call("cleanup_plan", { task_ids: [noAcceptance.id] });
    assert.equal(noAcceptancePlan.items[0].verdict, "blocked");
    assert.match(noAcceptancePlan.items[0].reasons.join(" "), /acceptance is not explicitly passed/);

    const activeWorker = await readyWorker(home, call, dir, "origin");
    const db = new DatabaseSync(join(home, "data", "supervisor.sqlite"));
    db.prepare("UPDATE tasks SET pid = ? WHERE id = ?").run(process.pid, activeWorker.id);
    db.close();
    const activePlan = await call("cleanup_plan", { task_ids: [activeWorker.id] });
    assert.equal(activePlan.items[0].verdict, "blocked");
    assert.match(activePlan.items[0].reasons.join(" "), /worker process is still active/);
    const reset = new DatabaseSync(join(home, "data", "supervisor.sqlite"));
    reset.prepare("UPDATE tasks SET pid = NULL WHERE id = ?").run(activeWorker.id);
    reset.close();

    const worker = await readyWorker(home, call, dir, "origin");
    const plan = await call("cleanup_plan", { task_ids: [worker.id] });
    const safe = plan.items.find((item) => item.verdict === "safe");
    assert.ok(safe, JSON.stringify(plan));
    git(dir, ["push", "-q", "--force", "origin", `${first}:main`]);
    const applied = await call("apply_cleanup", { plan_id: plan.plan_id, item_ids: [safe.id] });
    assert.equal(applied.applied.length, 0);
    assert.match(applied.skipped[0].reason, /landed head is no longer reachable/);
    assert(existsSync(worker.worktree_path));
  });
});
