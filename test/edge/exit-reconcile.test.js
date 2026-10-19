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
