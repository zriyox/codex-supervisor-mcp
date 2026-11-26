// Command output used to be kept twice, in the run log and in the store, and
// was nearly all of the store's size. The store keeps a clipped copy now and
// the full body is read back from the log.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openStore, tempHome } from "./helpers.js";

test("a large logged event is stored clipped and read back whole from the log", async () => {
  const home = await tempHome("supervisor-event-body-");
  process.env.SUPERVISOR_HOME = home;
  await import("../../src/app/compose.js");
  const { appendTaskEvents, readTaskEvents } = await import("../../src/infra/store/events.js");
  const { restoreEventBodies } = await import("../../src/infra/store/event-body.js");

  const output = "line of build output\n".repeat(5000);
  const command = { type: "item.completed", item: { id: "item_1", type: "command_execution", command: "npm run build", aggregated_output: output, exit_code: 0 } };
  const report = { type: "item.completed", item: { id: "item_2", type: "agent_message", text: "x".repeat(9000) } };
  const small = { type: "item.started", item: { id: "item_3", type: "command_execution", command: "ls" } };
  const logPath = join(home, "run.jsonl");
  await mkdir(home, { recursive: true });
  await writeFile(logPath, [command, report, small].map((event) => `${JSON.stringify(event)}\n`).join(""));
  await appendTaskEvents("w1", [command, report, small], { actor: "codex", bodyInLog: true });
  // The supervisor's own events are in no log and are never clipped.
  await appendTaskEvents("w1", [{ type: "supervisor.acceptance", checks: [{ output_tail: "y".repeat(9000) }] }]);

  const db = openStore(home);
  const sizes = db.prepare("SELECT event_type AS type, length(payload) AS bytes FROM task_events WHERE task_id='w1' ORDER BY seq").all();
  db.close();
  assert.ok(sizes[0].bytes < 3000, `the command output is still whole in the store: ${sizes[0].bytes}`);
  assert.ok(sizes[1].bytes > 9000, "the worker's message is kept whole");
  assert.ok(sizes[3].bytes > 9000, "a supervisor event is kept whole");

  const stored = await readTaskEvents("w1", 10);
  assert.equal(stored[0].item.command, "npm run build", "the clipped copy is still the event");
  assert.equal(stored[0].item.exit_code, 0);
  assert.equal(stored[0].body.stored, "jsonl");
  const restored = await restoreEventBodies(stored, logPath);
  assert.deepEqual(restored.slice(0, 3), [command, report, small]);

  await rm(logPath);
  const withoutLog = await restoreEventBodies(stored, logPath);
  assert.equal(withoutLog[0].body.missing, true, "a lost log leaves the clipped copy and says so");
  assert.equal(withoutLog[0].item.command, "npm run build");
});
