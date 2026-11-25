// Polling cleans up after itself: a safe worktree goes without being asked,
// unlanded work is kept through its hold period and then saved on the branch,
// and a worker whose worktree was removed can still be landed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dispatchArgs, git, makeRepo, tempHome, waitFor, waitForRunHostExit, withMcp } from "./helpers.js";

const EVERY_POLL = { CODEX_SUPERVISOR_CLEANUP_INTERVAL_MS: "0" };

async function finishedWorker(home, call, repo, title) {
  const worker = await call("create_codex_worker", dispatchArgs(title, repo, { sandbox: "workspace-write", ownedPaths: ["committed.txt", "uncommitted.txt"] }));
  await waitFor(call, worker.id, (task) => ["completed", "failed"].includes(task.status) && task.exit_code !== null);
  await waitForRunHostExit(home, worker.id);
  return worker;
}

test("a poll removes a failed worker that changed nothing and keeps its branch", async () => {
  const home = await tempHome("supervisor-auto-cleanup-empty-");
  const { dir } = await makeRepo(join(home, "repo"));
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "exit-immediately", ...EVERY_POLL }, async ({ call }) => {
    const worker = await finishedWorker(home, call, dir, "nothing-done");
    assert(existsSync(worker.worktree_path));
    const reply = await call("check_workers", {});
    assert.deepEqual(reply.cleaned.map((entry) => entry.task_id), [worker.id], JSON.stringify(reply.cleaned));
    assert(!existsSync(worker.worktree_path));
    assert.notEqual(git(dir, ["branch", "--list", `codex/${worker.id}`]), "");
  });
});

test("unlanded work survives polls during the hold period and can be switched off entirely", async () => {
  const home = await tempHome("supervisor-auto-cleanup-hold-");
  const { dir } = await makeRepo(join(home, "repo"));
  let worker;
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "commit-in-worktree", ...EVERY_POLL }, async ({ call }) => {
    worker = await finishedWorker(home, call, dir, "unlanded");
    assert.equal((await call("check_workers", {})).cleaned, undefined);
    assert.equal((await call("overview_delta", {})).cleaned, undefined);
    assert(existsSync(worker.worktree_path));
  });
  await withMcp({ SUPERVISOR_HOME: home, ...EVERY_POLL, CODEX_SUPERVISOR_CLEANUP_HOLD_DAYS: "0", CODEX_SUPERVISOR_NO_AUTO_CLEANUP: "1" }, async ({ call }) => {
    assert.equal((await call("check_workers", {})).cleaned, undefined);
    assert(existsSync(worker.worktree_path), "the switch keeps even expired work in place");
  });
});

test("after the hold period the draft is committed to the branch, and the worker can still be landed", async () => {
  const home = await tempHome("supervisor-auto-cleanup-restore-");
  const { dir } = await makeRepo(join(home, "repo"));
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "commit-in-worktree", ...EVERY_POLL, CODEX_SUPERVISOR_CLEANUP_HOLD_DAYS: "0" }, async ({ call }) => {
    const worker = await finishedWorker(home, call, dir, "expired");
    const cleaned = (await call("overview_delta", {})).cleaned;
    assert.equal(cleaned?.[0]?.task_id, worker.id, JSON.stringify(cleaned));
    assert.ok(cleaned[0].checkpoint_commit, "the uncommitted draft was saved first");
    assert(!existsSync(worker.worktree_path));
    assert.equal(git(dir, ["show", `codex/${worker.id}:uncommitted.txt`]), "draft");

    const landed = await call("land_codex_worker", { task_id: worker.id });
    assert.ok(!landed.error, JSON.stringify(landed));
    assert.equal((await readFile(join(dir, "uncommitted.txt"), "utf8")).trim(), "draft", "the checkpointed draft landed with the rest");
    assert(existsSync(join(dir, "committed.txt")));
  });
});

// git status marks an unstaged edit with a leading space, and a path can be a
// single character or not ASCII. Losing either would remove unsaved work.
test("an edit to a one-letter file and a non-ASCII file are both saved before the worktree goes", async () => {
  const home = await tempHome("supervisor-auto-cleanup-paths-");
  const { dir } = await makeRepo(join(home, "repo"));
  await writeFile(join(dir, "a"), "before\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "add a"]);
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "echo-prompt", ...EVERY_POLL, CODEX_SUPERVISOR_CLEANUP_HOLD_DAYS: "0", CODEX_SUPERVISOR_NO_AUTO_CLEANUP: "1" }, async ({ call }) => {
    const worker = await call("create_codex_worker", dispatchArgs("odd paths", dir, { sandbox: "workspace-write", ownedPaths: ["a", "笔记.txt"] }));
    await waitFor(call, worker.id, (task) => task.status === "completed" && task.exit_code === 0);
    await waitForRunHostExit(home, worker.id);
    await writeFile(join(worker.worktree_path, "a"), "after\n");
    const plan = await call("cleanup_plan", { task_ids: [worker.id] });
    assert.equal(plan.items[0].verdict, "safe", JSON.stringify(plan.items));
    const applied = await call("apply_cleanup", { plan_id: plan.plan_id, item_ids: [plan.items[0].id] });
    assert.ok(applied.applied[0]?.checkpoint_commit, JSON.stringify(applied));
    assert.equal(git(dir, ["show", `codex/${worker.id}:a`]), "after");

    const second = await call("create_codex_worker", dispatchArgs("non ascii", dir, { sandbox: "workspace-write", ownedPaths: ["笔记.txt"] }));
    await waitFor(call, second.id, (task) => task.status === "completed" && task.exit_code === 0);
    await waitForRunHostExit(home, second.id);
    await writeFile(join(second.worktree_path, "笔记.txt"), "草稿\n");
    const next = await call("cleanup_plan", { task_ids: [second.id] });
    const removed = await call("apply_cleanup", { plan_id: next.plan_id, item_ids: [next.items[0].id] });
    assert.ok(removed.applied[0]?.checkpoint_commit, JSON.stringify(removed));
    assert.equal(git(dir, ["show", `codex/${second.id}:笔记.txt`]), "草稿");
  });
});
