import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tempHome, withMcp, dispatchArgs } from "./helpers.js";

test("a CLI missing hooks/schema fails before model dispatch and its wait is settled", async () => {
  const home=await tempHome("supervisor-old-cli-");
  await withMcp({SUPERVISOR_HOME:home,FAKE_CODEX_OLD_CAPABILITIES:"1"},async({call})=>{
    const task=await call("create_codex_worker",dispatchArgs("old cli",join(home,"workspace")));
    assert.equal(task.status,"failed");
    const wait=await call("wait_codex_workers",{task_ids:[task.id],timeoutMs:1000});
    assert.equal(wait.timed_out,false);assert.equal(wait.workers[0].status,"failed");
    const row=await call("get_codex_worker_status",{task_id:task.id});
    assert.equal(row.attention_reason,"start_failed");assert.equal(row.thread_id,null);
    assert.match(row.error,/lacks required/);
  });
});

test("an oversized prompt fails before detached host IPC and leaves the MCP server usable", async () => {
  const home = await tempHome("supervisor-oversized-prompt-");
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "exit-immediately" }, async ({ call }) => {
    const task = await call("create_codex_worker", {
      ...dispatchArgs("oversized", join(home, "workspace")),
      task: "x".repeat(8 * 1024 * 1024)
    });
    assert.equal(task.status, "failed");
    assert.match(task.error, /prompt is too large/);
    const overview = await call("get_orchestration_overview", {});
    assert.ok(overview.workers.some((worker) => worker.id === task.id));
  });
});
