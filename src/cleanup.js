#!/usr/bin/env node
import { applyCleanupPlan, createCleanupPlan } from "./cleanup-plan.js";
import { getCleanupPlan, saveCleanupPlan } from "./task-store.js";

function parseArgs(argv) {
  const options = { apply: false, taskIds: [], itemIds: [], planId: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") options.apply = true;
    else if (arg === "--dry-run") options.apply = false;
    else if (arg === "--task") {
      options.taskIds.push(argv[index + 1]);
      index += 1;
    } else if (arg === "--plan") {
      options.planId = argv[index + 1];
      index += 1;
    } else if (arg === "--item") {
      options.itemIds.push(argv[index + 1]);
      index += 1;
    } else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.taskIds.some((id) => !id)) throw new Error("--task requires a task id");
  if (options.itemIds.some((id) => !id)) throw new Error("--item requires a cleanup plan item id");
  if (options.apply && (!options.planId || options.itemIds.length === 0)) throw new Error("--apply requires --plan <plan_id> and one or more --item <item_id>");
  if (!options.apply && (options.planId || options.itemIds.length)) throw new Error("--plan and --item are only valid with --apply");
  return options;
}

function printHelp() {
  console.log(`Usage: npm run cleanup -- [options]

Options:
  --dry-run          Create and print a SAFE / REVIEW / BLOCKED plan. Default.
  --apply            Apply selected SAFE items from an existing plan.
  --task <task_id>   Limit the plan to one task; repeatable.
  --plan <plan_id>   Existing cleanup plan to apply (required with --apply).
  --item <item_id>   SAFE item to apply; repeatable (required with --apply).
  -h, --help         Show help.

Cleanup never removes branches, task rows, events, JSONL logs or artifacts.
`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const plan = options.apply
    ? await getCleanupPlan(options.planId)
    : await createCleanupPlan({ taskIds: options.taskIds.length ? options.taskIds : null });
  if (!plan) throw new Error(`cleanup plan not found: ${options.planId}`);
  if (!options.apply) await saveCleanupPlan(plan);
  const outcome = options.apply
    ? await applyCleanupPlan({ plan, itemIds: options.itemIds, actor: "cleanup_cli" })
    : { applied: [], skipped: [] };

  console.log(JSON.stringify({
    dry_run: !options.apply,
    plan_id: plan.id,
    generated_at: plan.generated_at,
    expires_at: plan.expires_at,
    policy: plan.policy,
    summary: plan.summary,
    items: plan.items,
    applied: outcome.applied,
    skipped: outcome.skipped,
    retained: ["branch", "task", "events", "jsonl", "artifacts"]
  }, null, 2));
}

try {
  await main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
