import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { tempHome, withMcp } from "./helpers.js";

test("native goal updates reach overview and results without overwriting worker lifecycle", async () => {
  const home = await tempHome("supervisor-native-goal-");
  const codexHome = join(home, "codex");
  await mkdir(codexHome);
  const goals = new DatabaseSync(join(codexHome, "goals_1.sqlite"));
  goals.exec(`CREATE TABLE thread_goals (thread_id TEXT PRIMARY KEY,goal_id TEXT,objective TEXT,status TEXT,
    token_budget INTEGER,tokens_used INTEGER,time_used_seconds INTEGER,created_at_ms INTEGER,updated_at_ms INTEGER)`);
  goals.prepare("INSERT INTO thread_goals VALUES (?,?,?,?,?,?,?,?,?)").run("native-thread", "goal", "native objective", "blocked", null, 123, 7, Date.now(), Date.now());
  await withMcp({ SUPERVISOR_HOME: home, CODEX_HOME: codexHome }, async ({ call }) => {
    await call("list_codex_workers", {});
    const db = new DatabaseSync(join(home, "data", "supervisor.sqlite"));
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO tasks (id,title,worker,status,cwd,project_root,sandbox,prompt,created_at,updated_at,run_log,thread_id,exit_code)
      VALUES ('native-worker','goal','codex','completed',?,?,'read-only','test',?,?,'unused','native-thread',0)`).run(home, home, now, now);
    db.close();
    const overview = await call("get_orchestration_overview", {});
    assert.equal(overview.workers[0].status, "completed");
    assert.equal(overview.workers[0].goal_status, "blocked");
    assert.deepEqual(overview.needs_attention, ["native-worker"]);
    const result = await call("get_worker_result", { task_id: "native-worker" });
    assert.equal(result.goal_status, "blocked");
    const goal = await call("get_worker_goal", { task_id: "native-worker" });
    assert.equal(goal.native_goal.tokens_used, 123);
    goals.prepare("UPDATE thread_goals SET status='paused',updated_at_ms=?").run(Date.now());
    const paused = await call("get_orchestration_overview", {});
    assert.equal(paused.workers[0].goal_status, "paused");
    assert.deepEqual(paused.needs_attention, ["native-worker"]);
    goals.prepare("UPDATE thread_goals SET status='complete',updated_at_ms=?").run(Date.now());
    const next = await call("get_orchestration_overview", {});
    assert.equal(next.workers[0].goal_status, "complete");
    assert.deepEqual(next.needs_attention, []);
    goals.prepare("DELETE FROM thread_goals").run();
    const missing = await call("get_worker_goal", { task_id: "native-worker" });
    assert.equal(missing.native_goal, null);
  });
  goals.close();
});
