import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { dispatchArgs, repoRoot, tempHome, withMcp } from "./helpers.js";

test("a worker stage checkpoint is visible live and retained as the last stage", async () => {
  const home = await tempHome("supervisor-stage-");
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "hang" }, async ({ call }) => {
    const worker = await call("create_codex_worker", dispatchArgs("stage", join(home, "workspace")));
    try {
      execFileSync(process.execPath, [join(repoRoot, "src", "stage.js"), "gate:s2", "--detail", "integration queue"], {
        env: { ...process.env, SUPERVISOR_HOME: home, CODEX_SUPERVISOR_TASK_ID: worker.id },
        encoding: "utf8"
      });
      const running = await call("get_codex_worker_status", { task_id: worker.id });
      assert.equal(running.current_stage, "gate:s2", JSON.stringify(running));
      assert.equal(running.current_stage_detail, "integration queue");
      const overview = await call("get_orchestration_overview", {});
      assert.equal(overview.workers.find((entry) => entry.id === worker.id).current_stage, "gate:s2");
    } finally {
      await call("cancel_codex_worker", { task_id: worker.id });
    }
    const done = await call("get_codex_worker_status", { task_id: worker.id });
    assert.equal(done.current_stage, null);
    assert.equal(done.last_stage, "gate:s2");
  });
});

test("stage CLI refuses a missing task or stage", () => {
  assert.throws(() => execFileSync(process.execPath, [join(repoRoot, "src", "stage.js")], {
    env: { ...process.env, CODEX_SUPERVISOR_TASK_ID: "" }, stdio: "pipe"
  }));
});
