#!/usr/bin/env node
import { DEFAULT_ACCEPTANCE_TIMEOUT_MS, runAcceptance } from "./acceptance.js";
import { getTask } from "./task-store.js";

const taskId = process.env.CODEX_SUPERVISOR_TASK_ID;
if (!taskId) {
  console.error("CODEX_SUPERVISOR_TASK_ID is required");
  process.exit(2);
}

const task = await getTask(taskId);
if (!task) {
  console.error(`unknown supervisor task: ${taskId}`);
  process.exit(2);
}
if (!Array.isArray(task.acceptance) || task.acceptance.length === 0) {
  console.error(`task ${taskId} has no acceptance commands`);
  process.exit(2);
}

const run = Number(process.env.CODEX_SUPERVISOR_RUN);
const result = await runAcceptance(task.acceptance, {
  cwd: task.worktree_path || task.cwd,
  env: process.env,
  timeoutMs: task.acceptance_timeout_ms ?? DEFAULT_ACCEPTANCE_TIMEOUT_MS,
  run: Number.isInteger(run) && run > 0 ? run : task.run_count,
  taskId,
  baseCommit: process.env.CODEX_SUPERVISOR_BASE_COMMIT || task.base_commit || null
});
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exit(result.passed === true ? 0 : 1);
