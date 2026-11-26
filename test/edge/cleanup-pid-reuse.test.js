// A finished worker's row keeps the pids its run had. The system reuses them,
// on Windows within seconds, and cleanup then refused the worktree because
// "the worker process is still active".
import { test } from "node:test";
import assert from "node:assert/strict";
import { tempHome } from "./helpers.js";

test("a settled worker is not active because some other process now has its pid", async () => {
  process.env.SUPERVISOR_HOME = await tempHome("supervisor-pid-reuse-");
  const { cleanupFacts } = await import("../../src/app/cleanup-facts.js");
  // This test process stands in for the stranger that was given the old pid.
  const row = { id: "w", pid: process.pid, run_host_pid: process.pid, worktree_path: null, project_root: null };

  const settled = await cleanupFacts({ ...row, status: "completed", exit_code: 0 }, []);
  assert.equal(settled.active, null);

  const unsettled = await cleanupFacts({ ...row, status: "running", exit_code: null }, []);
  assert.match(unsettled.active, /still active/);
});
