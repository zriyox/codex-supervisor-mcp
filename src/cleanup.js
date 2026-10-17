#!/usr/bin/env node
import { createCleanupPlan, removePlannedWorktree } from "./cleanup-plan.js";
import { appendTaskEvent, getTask, markCleanupPlanItemApplied, saveCleanupPlan, updateWorkItemDelivery, runIdFor } from "./task-store.js";

function parseArgs(argv) {
  const options = { apply: false, taskIds: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") options.apply = true;
    else if (arg === "--dry-run") options.apply = false;
    else if (arg === "--task") {
      options.taskIds.push(argv[index + 1]);
      index += 1;
    } else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.taskIds.some((id) => !id)) throw new Error("--task requires a task id");
  return options;
}

function printHelp() {
  console.log(`Usage: npm run cleanup -- [options]

Options:
  --dry-run          Create and print a SAFE / REVIEW / BLOCKED plan. Default.
  --apply            Remove every SAFE worktree in the generated plan.
  --task <task_id>   Limit the plan to one task; repeatable.
  -h, --help         Show help.

Cleanup never removes branches, task rows, events, JSONL logs or artifacts.
`);
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  printHelp();
  process.exit(0);
}

const plan = await createCleanupPlan({ taskIds: options.taskIds.length ? options.taskIds : null });
await saveCleanupPlan(plan);
const applied = [];
const skipped = [];
if (options.apply) {
  for (const item of plan.items.filter((entry) => entry.verdict === "safe")) {
    const task = await getTask(item.task_id);
    try {
      await removePlannedWorktree(task, item.fingerprint);
      const now = await markCleanupPlanItemApplied(item.id, "cleanup_cli");
      await updateWorkItemDelivery(task.id, "cleanup_removed");
      await appendTaskEvent(task.id, { type: "supervisor.cleanup_removed", plan_id: plan.id, item_id: item.id, removed_at: now, retained: ["branch", "task", "events", "jsonl", "artifacts"] }, {
        runId: runIdFor(task.id, task.run_count ?? 1), actor: "supervisor"
      });
      applied.push({ task_id: task.id, worktree_path: task.worktree_path, removed_at: now });
    } catch (error) {
      skipped.push({ task_id: item.task_id, reason: error.message.split("\n")[0] });
    }
  }
}

console.log(JSON.stringify({
  dry_run: !options.apply,
  plan_id: plan.id,
  generated_at: plan.generated_at,
  expires_at: plan.expires_at,
  policy: plan.policy,
  summary: plan.summary,
  items: plan.items,
  applied,
  skipped,
  retained: ["branch", "task", "events", "jsonl", "artifacts"]
}, null, 2));
