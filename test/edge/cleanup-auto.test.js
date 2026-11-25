// Polling cleans up after itself: a safe worktree goes without being asked,
// unlanded work is kept through its hold period and then saved on the branch,
// and a worker whose worktree was removed can still be landed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
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
