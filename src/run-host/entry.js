#!/usr/bin/env node
// The detached process that owns one run: it reads the worker's output, writes
// the exit and runs acceptance, and outlives the MCP server that started it.
import "../app/compose.js";
import { failedStart } from "../app/run-state.js";
import { upsertTask } from "../infra/store/tasks.js";
import { installCrashGuard } from "../infra/crash-guard.js";
import { trackRunInHost } from "./track.js";

installCrashGuard("run-host", { exitOnRejection: true });

process.once("message", async (job) => {
  const keepAlive = setInterval(() => {}, 1000);
  let result;
  try {
    result = await trackRunInHost(job);
    if (!result.ok) await upsertTask(result.record);
  } catch (error) {
    result = failedStart(job.record, `run host failed: ${error.message}`);
    await upsertTask(result.record);
  }
  if (process.connected) await new Promise((resolveSent) => process.send({ ok: result.ok, record: result.record }, resolveSent));
  if (result.settled) await result.settled;
  clearInterval(keepAlive);
  if (process.connected) process.disconnect();
});
