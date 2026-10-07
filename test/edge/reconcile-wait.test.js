// Ghost rows and the settled wait, pushed to their edges: garbage
// timestamps, a live pid, a dead pid, "any" mode with a laggard.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dispatchArgs, tempHome, withMcp } from "./helpers.js";

function insertRow(home, { id, status = "running", pid = null, created, started = null }) {
  const db = new DatabaseSync(join(home, "data", "supervisor.sqlite"));
  db.prepare(`INSERT INTO tasks (id, title, worker, status, cwd, project_root, sandbox, prompt, created_at, updated_at, started_at, run_log, pid)
              VALUES (?, ?, 'codex', ?, ?, ?, 'workspace-write', 'x', ?, ?, ?, '/tmp/none', ?)`).run(id, id, status, home, home, created, created, started, pid);
  db.close();
}

test("reconcile: garbage created_at, dead pid, live pid, fresh row, and a terminal row are each handled", async () => {
  const home = await tempHome("supervisor-reconcile-");
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    await call("list_codex_workers", {}); // creates the schema
    const old = new Date(Date.now() - 3600_000).toISOString();
    insertRow(home, { id: "garbage-date", created: "not a date" });
    insertRow(home, { id: "dead-pid", created: old, started: old, pid: 2 ** 22 - 1 });
    insertRow(home, { id: "live-pid", created: old, started: old, pid: process.pid });
    insertRow(home, { id: "fresh", created: new Date().toISOString() });
    insertRow(home, { id: "queued-old", status: "queued", created: old });
    insertRow(home, { id: "done", status: "completed", created: old });
    const rows = await call("list_codex_workers", { includeHistory: true });
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    assert.equal(byId["garbage-date"].status, "lost");
    assert.equal(byId["dead-pid"].status, "lost");
    assert.match(byId["dead-pid"].error, /disappeared/);
    assert.equal(byId["live-pid"].status, "running", "a pid that is alive is left alone");
    assert.equal(byId.fresh.status, "running", "a row seconds old may still be spawning");
    assert.equal(byId["queued-old"].status, "lost", "queued counts as active");
    assert.equal(byId.done.status, "completed");
  });
});

test("wait in any mode returns as soon as one worker is settled, and names the rest as running", async () => {
  const home = await tempHome("supervisor-wait-");
  const ws = join(home, "workspace");
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_LINGER_MS: "0" }, async ({ call }) => {
    const quick = await call("create_codex_worker", dispatchArgs("quick", ws));
    const slow = await call("create_codex_worker", dispatchArgs("slow", ws, { sandbox: "read-only" }));
    const waited = await call("wait_codex_workers", { task_ids: [quick.id, slow.id], mode: "any", timeoutMs: 10000 });
    assert.equal(waited.timed_out, false);
    assert.ok(waited.workers.some((w) => w.status === "completed" && w.exit_code === 0));
    assert.equal(waited.workers.length, 2);
  });
});

test("wait with a missing id reports it instead of hanging", async () => {
  const home = await tempHome("supervisor-wait-");
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const waited = await call("wait_codex_workers", { task_ids: ["ghost"], timeoutMs: 1500, pollMs: 250 });
    assert.deepEqual(waited.missing_ids, ["ghost"]);
    assert.equal(waited.timed_out, true);
    assert.match(waited.next_step, /still running/i);
  });
});

test("a worker that lingers after turn.completed is not reported until its exit lands", async () => {
  const home = await tempHome("supervisor-wait-");
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_LINGER_MS: "1200" }, async ({ call }) => {
    const created = await call("create_codex_worker", dispatchArgs("linger", join(home, "workspace")));
    const started = Date.now();
    const waited = await call("wait_codex_workers", { task_ids: [created.id], timeoutMs: 10000, pollMs: 250 });
    assert.ok(Date.now() - started >= 1000, "the wait must outlast the linger");
    assert.equal(waited.workers[0].status, "completed");
    assert.equal(waited.workers[0].exit_code, 0);
  });
});

test("resuming a lost worker clears the error from the lost run", async () => {
  const home = await tempHome("supervisor-resume-clean-");
  const ws = join(home, "workspace");
  let lostId;
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "hang" }, async ({ call }) => {
    const created = await call("create_codex_worker", dispatchArgs("will-be-lost", ws));
    const running = await (async () => {
      const deadline = Date.now() + 10000;
      for (;;) {
        const t = await call("get_codex_worker_status", { task_id: created.id });
        if (t.pid && t.thread_id) return t;
        if (Date.now() > deadline) throw new Error("never started");
        await new Promise((r) => setTimeout(r, 60));
      }
    })();
    process.kill(running.pid, "SIGKILL");
    lostId = created.id;
    const deadline = Date.now() + 10000;
    for (;;) {
      const t = await call("get_codex_worker_status", { task_id: created.id });
      if (t.status === "lost") {
        assert.match(t.error, /killed by signal|disappeared/);
        break;
      }
      if (Date.now() > deadline) throw new Error(`still ${t.status}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  });
  // A fresh MCP process with a well-behaved fake resumes the same row.
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const resumed = await call("resume_codex_worker", { task_id: lostId, prompt: "carry on" });
    assert.equal(resumed.status, "running");
    assert.equal(resumed.error, null, "the receipt of the new run carries no stale error");
    const status = await call("get_codex_worker_status", { task_id: lostId });
    assert.equal(status.error, null, "the row has no stale error while the new run is alive");
    const final = await (async () => {
      const deadline = Date.now() + 10000;
      for (;;) {
        const t = await call("get_codex_worker_status", { task_id: lostId });
        if (t.status !== "running") return t;
        if (Date.now() > deadline) throw new Error("did not finish");
        await new Promise((r) => setTimeout(r, 60));
      }
    })();
    assert.equal(final.status, "completed");
    assert.equal(final.error, null);
    assert.equal(final.run_count, 2);
  });
});
