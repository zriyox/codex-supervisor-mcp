import { createCodexWorker } from "./codex-runner.js";
import { getTask, readTaskEvents, taskEventCount } from "./task-store.js";

const cwd = process.argv[2] ?? process.cwd();
const task = "Reply with one short sentence. Do not modify files.";

const worker = await createCodexWorker({
  title: "Smoke test",
  task,
  cwd,
  sandbox: "read-only"
});

console.log(JSON.stringify({ created: worker.id }, null, 2));

const deadline = Date.now() + 120000;
while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const latest = await getTask(worker.id);
  if (["completed", "failed", "cancelled"].includes(latest?.status) && latest.exit_code !== null) {
    const events = await readTaskEvents(worker.id, 5);
    const eventCount = await taskEventCount(worker.id);
    console.log(JSON.stringify({ latest, event_count: eventCount, recent_events: events }, null, 2));
    process.exit(latest.status === "completed" ? 0 : 1);
  }
}


console.error("Timed out waiting for smoke test worker.");
process.exit(1);
