#!/usr/bin/env node
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_ACCEPTANCE_TIMEOUT_MS, runAcceptance } from "./acceptance.js";
import { dbPath } from "./paths.js";

function readTask(taskId) {
  let db;
  try {
    // A worker runs this command inside its sandbox. Reading the contract must
    // not initialize the schema, switch the journal mode or create state dirs.
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec("PRAGMA busy_timeout=15000;");
    const row = db.prepare(`
      SELECT acceptance, acceptance_timeout_ms, worktree_path, cwd, base_commit, run_count
      FROM tasks WHERE id = ?
    `).get(taskId);
    if (!row) return null;
    let acceptance = null;
    try { acceptance = row.acceptance ? JSON.parse(row.acceptance) : null; } catch {}
    return { ...row, acceptance };
  } finally {
    db?.close();
  }
}

const taskId = process.env.CODEX_SUPERVISOR_TASK_ID;
if (!taskId) {
  console.error("CODEX_SUPERVISOR_TASK_ID is required");
  process.exit(2);
}

let task;
try {
  task = readTask(taskId);
} catch (error) {
  console.error(`cannot read supervisor task ${taskId}: ${error.message}`);
  process.exit(2);
}
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
