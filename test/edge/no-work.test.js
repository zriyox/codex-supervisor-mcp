import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { dispatchArgs, git, makeRepo, tempHome, waitFor, withMcp } from "./helpers.js";

test("a write run with no new output or command is marked no_work even when its previous run worked", async () => {
  const home = await tempHome("supervisor-no-work-");
  const { dir } = await makeRepo(join(home, "repo"));
  let worker;
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    worker = await call("create_codex_worker", dispatchArgs("write work", dir, { sandbox: "workspace-write", ownedPaths: ["first.txt"] }));
    await waitFor(call, worker.id, (row) => row.exit_code === 0);
  });
  await writeFile(join(worker.worktree_path, "first.txt"), "earlier work\n");
  git(worker.worktree_path, ["commit", "-q", "-am", "earlier result"]);
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "echo-prompt" }, async ({ call }) => {
    await call("resume_codex_worker", { task_id: worker.id, prompt: "make further progress" });
    await waitFor(call, worker.id, (row) => row.exit_code === 0 && row.run_count === 2);
    const db = new DatabaseSync(join(home, "data", "supervisor.sqlite"));
    try {
      const row = db.prepare("SELECT attention_reason, run_evidence FROM tasks WHERE id=?").get(worker.id);
      assert.equal(row.attention_reason, "no_work");
      const evidence = JSON.parse(row.run_evidence);
      assert.equal(evidence.run, 2);
      assert.equal(evidence.commands_run, 0);
      assert.equal(evidence.output_changed, false);
    } finally { db.close(); }
    const result = await call("get_worker_result", { task_id: worker.id });
    assert.equal(result.verification.commands_run, 0, "previous commands cannot validate this run");
  });
});

test("read-only research without editing or shell commands is not called no_work", async () => {
  const home = await tempHome("supervisor-research-");
  const { dir } = await makeRepo(join(home, "repo"));
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "echo-prompt" }, async ({ call }) => {
    const worker = await call("create_codex_worker", dispatchArgs("research", dir, { ownedPaths: [] }));
    await waitFor(call, worker.id, (row) => row.exit_code === 0);
    const db = new DatabaseSync(join(home, "data", "supervisor.sqlite"));
    try { assert.equal(db.prepare("SELECT attention_reason FROM tasks WHERE id=?").get(worker.id).attention_reason, null); }
    finally { db.close(); }
  });
});
