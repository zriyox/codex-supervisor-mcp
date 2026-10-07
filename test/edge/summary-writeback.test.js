// get_worker_summary caches the worktree diff on the row. It must do that
// only for a worker that is done, and must never put a stale copy of a
// running worker's live fields back over what the runner just wrote.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { dispatchArgs, git, makeRepo, tempHome, waitFor, withMcp } from "./helpers.js";

test("a running row keeps its live fields and empty changed_files after a summary read", async () => {
  const home = await tempHome("supervisor-summary-");
  const { dir } = await makeRepo(join(home, "repo"));
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "hang" }, async ({ call }) => {
    const created = await call("create_codex_worker", dispatchArgs("hanging", dir));
    await waitFor(call, created.id, (t) => t.status === "running" && t.phase === "thinking");
    // Work appears in the worktree while the worker is still running.
    await writeFile(join(created.worktree_path, "in-progress.txt"), "x\n");
    const db = new DatabaseSync(join(home, "data", "supervisor.sqlite"));
    const before = db.prepare("SELECT status, phase, current_action, changed_files, updated_at FROM tasks WHERE id = ?").get(created.id);
    const summary = await call("get_worker_summary", { task_id: created.id });
    assert.equal(summary.changed_files.length, 1, "the summary itself still reports the live diff");
    const after = db.prepare("SELECT status, phase, current_action, changed_files, updated_at FROM tasks WHERE id = ?").get(created.id);
    db.close();
    assert.deepEqual(after, before, "a summary read must not write a running row");
    await call("cancel_codex_worker", { task_id: created.id });
    await waitFor(call, created.id, (t) => t.status !== "running");
  });
});

test("a terminal row gets changed_files cached and nothing else touched", async () => {
  const home = await tempHome("supervisor-summary-");
  const { dir } = await makeRepo(join(home, "repo"));
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "commit-in-worktree" }, async ({ call }) => {
    const created = await call("create_codex_worker", dispatchArgs("done", dir));
    await waitFor(call, created.id, (t) => t.status === "completed" && t.exit_code === 0);
    // More work lands on the branch after the exit (a human amended it).
    await writeFile(join(created.worktree_path, "later.txt"), "y\n");
    git(created.worktree_path, ["add", "-A"]);
    git(created.worktree_path, ["commit", "-q", "-m", "later"]);
    const db = new DatabaseSync(join(home, "data", "supervisor.sqlite"));
    const before = db.prepare("SELECT status, exit_code, completed_at, updated_at FROM tasks WHERE id = ?").get(created.id);
    const summary = await call("get_worker_summary", { task_id: created.id });
    assert.ok(summary.changed_files.some((f) => f.endsWith("later.txt")));
    const after = db.prepare("SELECT status, exit_code, completed_at, updated_at, changed_files FROM tasks WHERE id = ?").get(created.id);
    db.close();
    assert.equal(JSON.parse(after.changed_files).length, summary.changed_files.length, "the diff is cached on the terminal row");
    assert.equal(after.status, before.status);
    assert.equal(after.exit_code, before.exit_code);
    assert.equal(after.completed_at, before.completed_at);
    assert.equal(after.updated_at, before.updated_at, "only changed_files moves; updated_at is the runner's");
  });
});
