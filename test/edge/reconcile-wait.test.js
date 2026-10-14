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
  if (status === "completed") db.prepare("UPDATE tasks SET exit_code=0 WHERE id=?").run(id);
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

test("a dead worker with a live supervisor does not return a half-written terminal row", async () => {
  const home = await tempHome("supervisor-settle-race-");
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    await call("list_codex_workers", {});
    const db = new DatabaseSync(join(home, "data", "supervisor.sqlite"));
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO tasks (id,title,worker,status,cwd,project_root,sandbox,prompt,created_at,updated_at,run_log,pid,notices)
      VALUES ('draining','draining','codex','completed',?,?,'read-only','test',?,?,'unused',?,'supervisor-alive')`).run(home, home, now, now, 2 ** 22 - 1);
    // Simulate the runner's short close/write gap, without actually failing
    // the process. The watcher must wait for the authoritative exit write.
    const writer = setTimeout(() => {
      db.prepare("UPDATE tasks SET exit_code=0 WHERE id='draining'").run();
    }, 400);
    try {
      const reply = await call("wait_codex_workers", { task_ids: ["draining"], timeoutMs: 2000, pollMs: 250, compact: true });
      assert.equal(reply.workers[0].exit_code, 0);
    } finally { clearTimeout(writer); db.close(); }
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
      // No signals on Windows: a killed worker lands as failed with code 1
      // there, lost everywhere else. Either way the row carries an error.
      if (t.status === "lost" || t.status === "failed") {
        assert.match(t.error, /killed by signal|disappeared|exited with code/);
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

test("worker output and acceptance survive the dispatching MCP being killed", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const { repoRoot, fakeCodex, waitFor } = await import("./helpers.js");
  const home = await tempHome("supervisor-owner-exit-");
  const transport = new StdioClientTransport({
    command: process.execPath, args: [join(repoRoot, "src", "mcp-server.js")],
    env: { ...process.env, SUPERVISOR_HOME: home, CODEX_BIN: fakeCodex,
      CODEX_SUPERVISOR_NO_UPDATE_CHECK: "1", CODEX_SUPERVISOR_SKIP_SKILL_SYNC: "1",
      FAKE_CODEX_STEP_MS: "300" }, stderr: "pipe"
  });
  const client = new Client({ name: "owner-exit", version: "1" });
  await client.connect(transport);
  const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
  let task;
  try {
    task = await call("create_codex_worker", dispatchArgs("survive owner", join(home, "workspace"), {
      acceptance: ["printf owner-survived"]
    }));
    await waitFor(call, task.id, (row) => Boolean(row.thread_id));
    process.kill(transport.pid, "SIGKILL");
    await client.close();
    await withMcp({ SUPERVISOR_HOME: home }, async ({ call: recovered }) => {
      const final = await waitFor(recovered, task.id,
        (row) => row.exit_code === 0 && row.acceptance === "passed", 10000);
      assert.equal(final.status, "completed");
      assert.equal(final.run_count, 1, "completion must not require replaying the model turn");
      assert.equal(final.last_message, "done");
      assert.equal(final.commands.length, 1);
      const result = await recovered("get_worker_result", { task_id: task.id });
      assert.match(result.acceptance.checks[0].output_tail, /owner-survived/);
    });
  } finally {
    await client.close();
    if (task) await withMcp({ SUPERVISOR_HOME: home }, async ({ call: cleanup }) => {
      await cleanup("cancel_codex_worker", { task_id: task.id });
    });
  }
});

test("a fresh MCP can cancel acceptance owned by the independent run host", async () => {
  const home = await tempHome("supervisor-owner-cancel-");
  let id;
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const command = `"${process.execPath}" -e "setTimeout(()=>{},15000)"`;
    const task = await call("create_codex_worker", dispatchArgs("cancel detached acceptance", join(home, "workspace"), {
      acceptance: [command, "printf must-not-run"]
    }));
    id = task.id;
    const { waitFor } = await import("./helpers.js");
    await waitFor(call, id, (row) => row.acceptance === "running");
  });
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const result = await call("cancel_codex_worker", { task_id: id });
    assert.equal(result.cancelled, true);
    assert.equal(result.via, "acceptance");
    const { waitFor } = await import("./helpers.js");
    const final = await waitFor(call, id, (row) => row.acceptance === "cancelled");
    assert.equal(final.status, "completed", "cancel the checks without replacing the worker's completed status");
    const report = await call("get_worker_result", { task_id: id });
    assert.equal(report.acceptance.checks.length, 1);
    assert.equal(report.acceptance.checks[0].cancelled, true);
  });
});

test("two MCP windows cannot resume the same completed run concurrently", async () => {
  const home = await tempHome("supervisor-resume-claim-");
  const { waitFor } = await import("./helpers.js");
  let id;
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const task = await call("create_codex_worker", dispatchArgs("single resume", join(home, "workspace")));
    id = task.id;
    await waitFor(call, id, (row) => row.exit_code === 0);
  });
  const env = { SUPERVISOR_HOME: home, FAKE_CODEX_STEP_MS: "500" };
  await withMcp(env, async ({ call: first }) => {
    await withMcp(env, async ({ call: second }) => {
      try {
        const replies = await Promise.all([first, second].map((call) =>
          call("resume_codex_worker", { task_id: id, prompt: "Continue once only" })));
        assert.equal(replies.filter((reply) => reply.status === "running").length, 1);
        assert.equal(replies.filter((reply) => reply.error === "worker_active").length, 1);
        const row = await first("get_codex_worker_status", { task_id: id });
        assert.equal(row.run_count, 2);
      } finally { await first("cancel_codex_worker", { task_id: id }); }
    });
  });
});
