import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { makeRepo, tempHome, waitFor, withMcp, dispatchArgs } from "./helpers.js";

test("a tracked worker has durable repo, work-item, run and event provenance", async () => {
  const home = await tempHome("supervisor-control-store-");
  const { dir } = await makeRepo(join(home, "repo"));
  let worker;
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    worker = await call("create_codex_worker", dispatchArgs("provenance", dir));
    assert.ok(worker.id, JSON.stringify(worker));
    await waitFor(call, worker.id, (task) => task.status === "completed" && task.exit_code !== null);
  });

  const db = new DatabaseSync(join(home, "data", "supervisor.sqlite"));
  const workItem = db.prepare("SELECT * FROM work_items WHERE task_id = ?").get(worker.id);
  assert.ok(workItem);
  assert.equal(workItem.delivery_state, "draft");
  const run = db.prepare("SELECT * FROM runs WHERE task_id = ? AND attempt = 1").get(worker.id);
  assert.ok(run);
  assert.equal(run.run_status, "completed");
  assert.equal(run.id, `run-${worker.id}-1`);
  const events = db.prepare("SELECT run_id, actor, payload, payload_sha256 FROM task_events WHERE task_id = ? ORDER BY seq").all(worker.id);
  assert.ok(events.length > 0);
  for (const event of events) {
    assert.equal(event.run_id, run.id);
    assert.equal(event.actor, "codex");
    assert.equal(event.payload_sha256, createHash("sha256").update(event.payload).digest("hex"));
  }
  db.close();
});
