import { createCodexWorker, createFollowupWorker } from "./codex-runner.js";
import { getTask, readTaskEvents, taskEventCount } from "./task-store.js";

const cwd = process.argv[2] ?? process.cwd();

async function waitForTerminal(taskId) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const latest = await getTask(taskId);
    if (["completed", "failed", "cancelled"].includes(latest?.status) && latest.exit_code !== null) {
      return latest;
    }
  }
  throw new Error(`Timed out waiting for ${taskId}`);
}

const parent = await createCodexWorker({
  title: "Follow-up parent smoke",
  task: "Reply with one short sentence. Do not modify files.",
  cwd,
  sandbox: "read-only"
});

const parentFinal = await waitForTerminal(parent.id);
if (parentFinal.status !== "completed") {
  console.log(JSON.stringify({ parent: parentFinal }, null, 2));
  process.exit(1);
}

const followup = await createFollowupWorker({
  taskId: parent.id,
  followupPrompt: "Summarize the parent worker in one short sentence. Do not modify files.",
  title: "Follow-up child smoke",
  sandbox: "read-only"
});

const followupFinal = await waitForTerminal(followup.id);
const followupEvents = await readTaskEvents(followup.id, 8);
const followupEventCount = await taskEventCount(followup.id);

console.log(JSON.stringify({
  parent: parentFinal,
  followup: followupFinal,
  followup_event_count: followupEventCount,
  followup_recent_events: followupEvents
}, null, 2));

process.exit(followupFinal.status === "completed" && followupFinal.followup_of === parent.id ? 0 : 1);
