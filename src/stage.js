#!/usr/bin/env node
import { writeStage } from "./stage-store.js";

const argv = process.argv.slice(2);
let taskId = process.env.CODEX_SUPERVISOR_TASK_ID;
let detail = null;
const positional = [];
for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] === "--detail") detail = argv[++index];
  else positional.push(argv[index]);
}
const stage = positional.join(" ").trim();
if (!taskId || !stage) {
  console.error('usage: codex-supervisor-stage "gate:s3" [--detail "..."]  (task comes from CODEX_SUPERVISOR_TASK_ID)');
  process.exit(2);
}
process.stdout.write(`${JSON.stringify(writeStage(taskId, stage, detail))}\n`);
