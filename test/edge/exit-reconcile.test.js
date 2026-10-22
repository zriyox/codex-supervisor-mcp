import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { tempHome, withMcp } from "./helpers.js";

test("an interrupted acceptance with no recorded process exit becomes resumable lost work", async () => {
  const home = await tempHome("supervisor-exit-reconcile-");
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    await call("list_codex_workers", { includeHistory: true });
    const db = new DatabaseSync(join(home, "data", "supervisor.sqlite"));
    const old = new Date(Date.now() - 60000).toISOString();
    db.prepare(`
      INSERT INTO tasks
        (id,title,worker,status,cwd,project_root,sandbox,prompt,created_at,updated_at,started_at,run_log,pid,run_host_pid,exit_code,acceptance_results,thread_id,run_count,guard_policy)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      "codex-exit-reconcile", "interrupted exit", "codex", "completed",
      join(home, "workspace"), join(home, "workspace"), "workspace-write", "noop",
      old, old, old, join(home, "run.jsonl"), 999999, 999998, null,
      JSON.stringify({ status: "interrupted", passed: null, run: 1, supervisor_pid: 999997 }),
      "01a0fd0a-0000-7000-8000-000000000099", 1, JSON.stringify({ allowedCommands: [], ownedPaths: [] })
    );
    db.close();
    const rows = await call("list_codex_workers", { includeHistory: true });
    const row = rows.find((entry) => entry.id === "codex-exit-reconcile");
    assert.equal(row.status, "lost", JSON.stringify(row));
    assert.match(row.error ?? "", /before acceptance/);
    assert.equal(row.failure.source, "supervisor_process");
  });
});

for (const acceptanceState of ["none", "interrupted", "passed", "failed"]) test(`a completed turn with ${acceptanceState} acceptance recovers its missing exit independently`, async () => {
  const home = await tempHome("supervisor-exit-recovered-");
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    await call("list_codex_workers", { includeHistory: true });
    const db = new DatabaseSync(join(home, "data", "supervisor.sqlite"));
    const old = new Date(Date.now() - 60000).toISOString();
    const taskId = "codex-exit-recovered";
    const runId = `run-${taskId}-1`;
    db.prepare(`
      INSERT INTO tasks
        (id,title,worker,status,cwd,project_root,sandbox,prompt,created_at,updated_at,started_at,completed_at,run_log,pid,run_host_pid,exit_code,thread_id,run_count,guard_policy,last_event_type)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      taskId, "completed turn without exit", "codex", "completed",
      join(home, "workspace"), join(home, "workspace"), "read-only", "noop",
      old, old, old, old, join(home, "run.jsonl"), 999999, 999998, null,
      "01a0fd0a-0000-7000-8000-000000000100", 1,
      JSON.stringify({ allowedCommands: [], ownedPaths: [] }), "turn.completed"
    );
    db.prepare(`
      INSERT INTO task_events(task_id,run_id,seq,created_at,event_type,payload,actor)
      VALUES(?,?,?,?,?,?,?)
    `).run(taskId, runId, 1, old, "turn.completed", JSON.stringify({ type: "turn.completed" }), "codex");
    db.prepare(`
      INSERT INTO task_events(task_id,run_id,seq,created_at,event_type,payload,actor)
      VALUES(?,?,?,?,?,?,?)
    `).run(taskId, runId, 0, old, "item.completed", JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: JSON.stringify({ result: "recovered", verification: [], not_done: [] }) }
    }), "codex");
    db.prepare("INSERT INTO runs(id,task_id,work_item_id,attempt,run_status,started_at) VALUES(?,?,?,?,?,?)")
      .run(runId, taskId, `work-${taskId}`, 1, "running", old);
    if (acceptanceState !== "none") {
      db.prepare("UPDATE tasks SET acceptance=?, acceptance_results=? WHERE id=?").run(
        JSON.stringify(['node -e "process.exit(0)"']),
        JSON.stringify({ status: "running", passed: null, run: 1, supervisor_pid: 999997 }), taskId
      );
      if (acceptanceState !== "interrupted") {
        db.prepare(`INSERT INTO task_events(task_id,run_id,seq,created_at,event_type,payload,actor) VALUES(?,?,?,?,?,?,?)`)
          .run(taskId, runId, 2, old, "supervisor.acceptance", JSON.stringify({
            type: "supervisor.acceptance", status: acceptanceState, passed: acceptanceState === "passed", run: 1,
            checks: [{ command: 'node -e "process.exit(0)"', passed: acceptanceState === "passed", exit_code: acceptanceState === "passed" ? 0 : 1 }]
          }), "supervisor");
      }
    }
    db.close();

    const rows = await call("list_codex_workers", { includeHistory: true });
    const row = rows.find((entry) => entry.id === taskId);
    assert.equal(row.status, "completed", JSON.stringify(row));
    assert.equal(row.exit_code, 0);
    assert.equal(row.attention_reason, null);
    if (acceptanceState !== "none") {
      const result = await call("get_worker_result", { task_id: taskId });
      assert.equal(result.acceptance.status, acceptanceState);
      assert.equal(result.acceptance.passed, acceptanceState === "interrupted" ? null : acceptanceState === "passed");
      const land = await call("land_codex_worker", { task_id: taskId });
      if (acceptanceState !== "passed") assert.equal(land.error, acceptanceState === "failed" ? "acceptance_failed" : "acceptance_not_run");
    }

    const verify = new DatabaseSync(join(home, "data", "supervisor.sqlite"));
    assert.equal(verify.prepare("SELECT count(*) AS n FROM task_events WHERE task_id=? AND event_type='supervisor.exit_recovered'").get(taskId).n, 1);
    const evidence = JSON.parse(verify.prepare("SELECT run_evidence FROM tasks WHERE id=?").get(taskId).run_evidence);
    assert.equal(evidence.structured_report.valid, true);
    assert.equal(evidence.structured_report.report.result, "recovered");
    const recoveredRun = verify.prepare("SELECT run_status,finished_at FROM runs WHERE id=?").get(runId);
    assert.equal(recoveredRun.run_status, "completed");
    assert.ok(recoveredRun.finished_at);
    verify.close();
  });
});

test("a running row with a durable completed turn is recovered before the lost/resume path", async () => {
  const home = await tempHome("supervisor-exit-running-");
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    await call("list_codex_workers", { includeHistory: true });
    const db = new DatabaseSync(join(home, "data", "supervisor.sqlite"));
    const old = new Date(Date.now() - 60000).toISOString();
    const taskId = "codex-exit-running";
    db.prepare(`
      INSERT INTO tasks
        (id,title,worker,status,cwd,project_root,sandbox,prompt,created_at,updated_at,started_at,run_log,pid,run_host_pid,exit_code,thread_id,run_count,guard_policy,last_event_type)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      taskId, "running row with completed turn", "codex", "running",
      join(home, "workspace"), join(home, "workspace"), "read-only", "noop",
      old, old, old, join(home, "run.jsonl"), 999999, 999998, null,
      "01a0fd0a-0000-7000-8000-000000000101", 1,
      JSON.stringify({ allowedCommands: [], ownedPaths: [] }), "turn.completed"
    );
    db.prepare(`
      INSERT INTO task_events(task_id,run_id,seq,created_at,event_type,payload,actor)
      VALUES(?,?,?,?,?,?,?)
    `).run(taskId, `run-${taskId}-1`, 1, old, "turn.completed", JSON.stringify({ type: "turn.completed" }), "codex");
    db.close();

    const rows = await call("list_codex_workers", { includeHistory: true });
    const row = rows.find((entry) => entry.id === taskId);
    assert.equal(row.status, "completed", JSON.stringify(row));
    assert.equal(row.exit_code, 0);
    assert.equal(row.run_count, 1, "recovery must not trigger a resume");
  });
});

test("exit recovery preserves an existing attention reason and error", async () => {
  const home = await tempHome("supervisor-exit-attention-");
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    await call("list_codex_workers", { includeHistory: true });
    const db = new DatabaseSync(join(home, "data", "supervisor.sqlite"));
    const old = new Date(Date.now() - 60000).toISOString();
    const taskId = "codex-exit-attention";
    db.prepare(`
      INSERT INTO tasks
        (id,title,worker,status,cwd,project_root,sandbox,prompt,created_at,updated_at,started_at,completed_at,run_log,pid,run_host_pid,exit_code,attention_reason,error,thread_id,run_count,guard_policy,last_event_type)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      taskId, "completed turn with invalid report", "codex", "completed",
      join(home, "workspace"), join(home, "workspace"), "read-only", "noop",
      old, old, old, old, join(home, "run.jsonl"), 999999, 999998, null,
      "invalid_report", "Invalid final worker report", "01a0fd0a-0000-7000-8000-000000000102", 1,
      JSON.stringify({ allowedCommands: [], ownedPaths: [] }), "turn.completed"
    );
    db.prepare(`
      INSERT INTO task_events(task_id,run_id,seq,created_at,event_type,payload,actor)
      VALUES(?,?,?,?,?,?,?)
    `).run(taskId, `run-${taskId}-1`, 1, old, "turn.completed", JSON.stringify({ type: "turn.completed" }), "codex");
    db.close();

    const rows = await call("list_codex_workers", { includeHistory: true });
    const row = rows.find((entry) => entry.id === taskId);
    assert.equal(row.status, "completed", JSON.stringify(row));
    assert.equal(row.exit_code, 0);
    assert.equal(row.attention_reason, "invalid_report");
    assert.equal(row.error, "Invalid final worker report");
  });
});

test("exit recovery marks an unparsable durable report as invalid_report", async () => {
  const home = await tempHome("supervisor-exit-invalid-report-");
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    await call("list_codex_workers", { includeHistory: true });
    const db = new DatabaseSync(join(home, "data", "supervisor.sqlite"));
    const old = new Date(Date.now() - 60000).toISOString();
    const taskId = "codex-exit-invalid-report";
    const runId = `run-${taskId}-1`;
    db.prepare(`
      INSERT INTO tasks
        (id,title,worker,status,cwd,project_root,sandbox,prompt,created_at,updated_at,started_at,completed_at,run_log,pid,run_host_pid,exit_code,thread_id,run_count,guard_policy,last_event_type)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      taskId, "completed turn with prose", "codex", "completed",
      join(home, "workspace"), join(home, "workspace"), "read-only", "noop",
      old, old, old, old, join(home, "run.jsonl"), 999999, 999998, null,
      "01a0fd0a-0000-7000-8000-000000000103", 1,
      JSON.stringify({ allowedCommands: [], ownedPaths: [], output_schema: true }), "turn.completed"
    );
    const insert = db.prepare(`
      INSERT INTO task_events(task_id,run_id,seq,created_at,event_type,payload,actor)
      VALUES(?,?,?,?,?,?,?)
    `);
    insert.run(taskId, runId, 0, old, "item.completed", JSON.stringify({
      type: "item.completed", item: { type: "agent_message", text: "finished in prose" }
    }), "codex");
    insert.run(taskId, runId, 1, old, "turn.completed", JSON.stringify({ type: "turn.completed" }), "codex");
    db.close();

    const rows = await call("list_codex_workers", { includeHistory: true });
    const row = rows.find((entry) => entry.id === taskId);
    assert.equal(row.status, "completed", JSON.stringify(row));
    assert.equal(row.exit_code, 0);
    assert.equal(row.attention_reason, "invalid_report");
    assert.match(row.error, /Invalid final worker report/);
  });
});
