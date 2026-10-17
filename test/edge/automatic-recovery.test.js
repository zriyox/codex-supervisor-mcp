import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { dispatchArgs, tempHome, withMcp, waitFor, makeRepo } from "./helpers.js";
import { DatabaseSync } from "node:sqlite";

test("check_workers recovers an empty write run once and two observers cannot start duplicate retries", async () => {
  const home = await tempHome("supervisor-auto-recovery-");
  const { dir } = await makeRepo(join(home, "repo"));
  let id;
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "echo-prompt" }, async ({ call }) => {
    const worker = await call("create_codex_worker", dispatchArgs("empty write", dir, { sandbox: "workspace-write", ownedPaths: ["result.txt"] }));
    id = worker.id;
    await waitFor(call, id, (row) => row.exit_code === 0);
  });
  const env = { SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "echo-prompt" };
  // The result precedes independent owner teardown; Windows can keep that
  // process alive longer. Recovery correctly refuses to overlap a live owner.
  const db = new DatabaseSync(join(home, "data", "supervisor.sqlite"));
  const deadline = Date.now() + 20000;
  try {
    for (;;) {
      const { run_host_pid: pid } = db.prepare("SELECT run_host_pid FROM tasks WHERE id=?").get(id);
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch {}
      if (!alive) break;
      assert.ok(Date.now() < deadline, "the completed owner must exit before recovery");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } finally { db.close(); }
  await withMcp(env, async ({ call: first }) => withMcp(env, async ({ call: second }) => {
    const replies = await Promise.all([first("check_workers", {}), second("check_workers", {})]);
    assert.equal(replies.flatMap((reply) => reply.recoveries).length, 1);
    const final = await waitFor(first, id, (row) => row.run_count === 2 && row.exit_code === 0);
    assert.equal(final.attention_reason, "two_stall");
    const after = await first("check_workers", {});
    assert.equal(after.recoveries.length, 0);
    assert.ok(after.attention.some((entry) => entry.reason === "two_stall"));
    const db = new DatabaseSync(join(home, "data", "supervisor.sqlite"));
    assert.equal(db.prepare("SELECT delivery_state FROM work_items WHERE task_id = ?").get(id).delivery_state, "needs_attention");
    db.close();
    const events = await first("get_codex_worker_events", { task_id: id, limit: 50 });
    assert.equal(events.events.filter((event) => event.type === "supervisor.recovery").length, 1);
  }));
});

test("approval waits do not auto-recover an empty write run", async () => {
  const home = await tempHome("supervisor-auto-waiting-");
  const { dir } = await makeRepo(join(home, "repo"));
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "echo-prompt" }, async ({ call }) => {
    const worker = await call("create_codex_worker", dispatchArgs("wait for user", dir, {
      session_id: "waiting", sandbox: "workspace-write", ownedPaths: ["result.txt"]
    }));
    await waitFor(call, worker.id, (row) => row.exit_code === 0);
    await call("describe_session", { session_id: "waiting", approval_state: "waiting_user" });
    const result = await call("check_workers", {});
    assert.equal(result.recoveries.length, 0);
    assert.equal((await call("get_codex_worker_status", { task_id: worker.id })).run_count, 1);
  });
});

test("new observers never silently replay historical lost tasks without current-run evidence", async () => {
  const home = await tempHome("supervisor-legacy-recovery-");
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    await call("list_codex_workers", {});
    const db = new DatabaseSync(join(home, "data", "supervisor.sqlite"));
    const now = new Date().toISOString();
    db.prepare("INSERT INTO tasks(id,worker,status,cwd,project_root,sandbox,prompt,created_at,updated_at,run_log,run_count,thread_id) VALUES('historical','codex','lost',?,?,'read-only','old task',?,?,'unused',1,'old-thread')").run(home, home, now, now);
    db.close();
    const result = await call("check_workers", {});
    assert.equal(result.recoveries.length, 0);
    assert.equal((await call("get_codex_worker_status", { task_id: "historical" })).run_count, 1);
  });
});
