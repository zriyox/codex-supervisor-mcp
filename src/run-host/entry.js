#!/usr/bin/env node
// The detached process that owns one run: it reads the worker's output, writes
// the exit and runs acceptance, and outlives the MCP server that started it.
import "../app/compose.js";
import { failedStart } from "../app/run-state.js";
import { upsertTask } from "../infra/store/tasks.js";
import { installCrashGuard } from "../infra/crash-guard.js";
import { trackRunInHost } from "./track.js";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

installCrashGuard("run-host", { exitOnRejection: true });

async function runJob(job, answer) {
  const keepAlive = setInterval(() => {}, 1000);
  let result;
  try {
    result = await trackRunInHost(job);
    if (!result.ok) await upsertTask(result.record);
  } catch (error) {
    result = failedStart(job.record, `run host failed: ${error.message}`);
    await upsertTask(result.record);
  }
  await answer({ ok: result.ok, record: result.record });
  if (result.settled) await result.settled;
  clearInterval(keepAlive);
  if (process.connected) process.disconnect();
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

const jobFile = argValue("--job-file");
if (jobFile) {
  const ackFile = argValue("--ack-file");
  writeFileSync(`${jobFile}.pid`, String(process.pid));
  const claimed = `${jobFile}.claimed`;
  try {
    renameSync(jobFile, claimed);
  } catch (error) {
    rmSync(`${jobFile}.pid`, { force: true });
    console.error(`[ERROR] job ${jobFile} withdrawn before this host claimed it: ${error.message}`);
    process.exit(1);
  }
  const job = JSON.parse(readFileSync(claimed, "utf8"));
  rmSync(claimed);
  rmSync(`${jobFile}.pid`, { force: true });
  runJob(job, (message) => {
    writeFileSync(`${ackFile}.tmp`, JSON.stringify(message));
    renameSync(`${ackFile}.tmp`, ackFile);
  });
} else {
  process.once("message", (job) => runJob(job, (message) => {
    if (!process.connected) return undefined;
    return new Promise((resolveSent) => process.send(message, resolveSent));
  }));
}
