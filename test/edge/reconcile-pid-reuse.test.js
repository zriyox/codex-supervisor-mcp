// A run host died after its worker finished the turn. The row went to lost,
// and the durable turn event should bring it back to completed; it did not
// when another process had since been given the worker's old pid.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { dispatchArgs, listWorkers, makeRepo, openStore, tempHome, waitFor, waitForRunHostExit, withMcp } from "./helpers.js";

test("a lost row with a finished turn is recovered even when its old pid is alive again", async () => {
  const home = await tempHome("supervisor-reconcile-pid-");
  const { dir } = await makeRepo(join(home, "repo"));
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const worker = await call("create_worker", dispatchArgs("finished", dir, { sandbox: { mode: "read-only" }, owned_paths: [] }));
    await waitFor(call, worker.id, (task) => task.status === "completed" && task.exit_code === 0);
    await waitForRunHostExit(home, worker.id);
    const db = openStore(home);
    // This test process stands in for the stranger that was given the old pids.
    db.prepare("UPDATE tasks SET status='lost', exit_code=NULL, pid=?, run_host_pid=?, error=? WHERE id=?")
      .run(process.pid, process.pid, "Worker ended but its supervisor did not record the process exit", worker.id);
    db.close();
    const row = (await listWorkers(call)).find((task) => task.id === worker.id);
    assert.equal(row.status, "completed", JSON.stringify(row).slice(0, 400));
    assert.equal(row.exit_code, 0);
  });
});
