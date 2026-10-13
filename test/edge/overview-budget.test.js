import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { tempHome, withMcp } from "./helpers.js";

test("twenty active workers with Windows paths and Chinese descriptions fit 7000 bytes", async () => {
  const home = await tempHome("supervisor-overview-budget-");
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    await call("list_codex_workers", {});
    const db = new DatabaseSync(join(home, "data", "supervisor.sqlite"));
    const statement = db.prepare(`INSERT INTO tasks
      (id,title,worker,status,phase,cwd,project_root,sandbox,prompt,created_at,updated_at,run_log,pid,goal_objective,current_action,owned_paths)
      VALUES (?,?,'codex','running','starting',?,?,'read-only','test',?,?,'unused',?,?,?,?)`);
    const now = new Date().toISOString();
    for (let i = 0; i < 20; i++) {
      const path = `C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\overview\\${i}`;
      statement.run(`codex-1791893875707-${String(i).padStart(8,"0")}`, `很长的中文标题第${i}号worker负责改造状态机与并发稳定性`, home, home, now, now, process.pid,
        `这是第${i}个worker的很长的目标描述，用来压测概览接口的预算控制能力`, "正在开始执行工作任务", JSON.stringify([path]));
    }
    db.close();
    const overview = await call("get_orchestration_overview", {});
    assert.equal(overview.workers.length, 20);
    assert.ok(Buffer.byteLength(JSON.stringify(overview), "utf8") <= 7000);
    assert.notEqual(overview.budget_exceeded, true);
    assert.equal(overview.active, 20);
  });
});
