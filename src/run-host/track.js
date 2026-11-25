// Starts one worker process and tracks it to the end. Runs inside the detached
// run host, so the worker's output, exit and acceptance are recorded even when
// the MCP server that dispatched it is gone.
import "../app/compose.js";
import { failedStart, processes } from "../app/run-state.js";
import { captureExternalOutputs } from "../infra/external-output.js";
import { spawnProcess } from "../infra/process.js";
import { clearStage } from "../infra/stage-store.js";
import { ensureRunRecord } from "../infra/store/events.js";
import { snapshotTaskOutput } from "../infra/worktree.js";
import { codexRunner } from "../runners/codex/adapter.js";
import { finalizeChild } from "./finalize.js";
import { buildLaunch } from "./launch.js";
import { persist, startingRow, watchQuota } from "./live-run.js";
import { attachStreams } from "./streams.js";
import { createWriteStream } from "node:fs";

// Spawn can fail either by throwing synchronously, or by emitting "error"
// instead of "spawn". Both paths are handled so a bad CODEX_BIN marks the task
// failed instead of taking the whole MCP process down.
async function spawnAndAwaitStart(target, args, options) {
  const child = spawnProcess(target.cmd, [...target.prefixArgs, ...args], options);
  const earlyOutput = { stdout: [], stderr: [], capture: true };
  child.stdout?.on("data", (chunk) => { if (earlyOutput.capture) earlyOutput.stdout.push(chunk); });
  child.stderr?.on("data", (chunk) => { if (earlyOutput.capture) earlyOutput.stderr.push(chunk); });
  const spawnError = await new Promise((resolvePromise) => {
    let settled = false;
    child.once("spawn", () => {
      if (!settled) {
        settled = true;
        resolvePromise(null);
      }
    });
    child.once("error", (error) => {
      if (!settled) {
        settled = true;
        resolvePromise(error);
      }
    });
  });
  return { child, spawnError, earlyOutput };
}

// Everything the handlers of one run share. `live` is the task row as last
// written; the chains serialize row writes and event handling.
function openRun({ record, child, outputSchema, logPath, before, now }) {
  return {
    record, child, outputSchema, logPath, ...before,
    priorAttemptFingerprint: record.run_evidence?.attempt_fingerprint ?? null,
    reportOnlyRecovery: record.attention_reason === "invalid_report",
    live: startingRow(record, child, outputSchema, now),
    quotaReason: null, quotaWatch: null,
    writeChain: Promise.resolve(), eventChain: Promise.resolve(),
    terminalEvent: false, rawReport: null, rawReportEventId: null,
    stdoutRest: "", pendingLines: [], eventFlushPending: false, stderr: "",
    childSettled: false, runId: null, logStream: null
  };
}

// A child that exits early makes a stdin write fail with EPIPE. That must not
// reach the process level, or one oversized prompt kills the run host.
function noteStdinFailure(run, error) {
  return persist(run, {
    ...run.live,
    error: run.live.error ?? `stdin write failed: ${error.message}`,
    updated_at: new Date().toISOString()
  });
}

export async function trackRunInHost({ record, args, prompt, logPath, spawnOptions = {}, outputSchema = true }) {
  const capability = codexRunner.capabilityPreflight();
  if (!capability.ok) return failedStart(record, capability.error);
  const target = capability.target;
  const before = {
    outputBefore: snapshotTaskOutput(record),
    workspaceBefore: record.workspace_metadata?.before_manifest ?? null,
    externalBefore: await captureExternalOutputs(record.guard_policy?.externalOutputs ?? [], { checkBaseline: (record.run_count ?? 0) === 0 })
  };
  const launch = buildLaunch({ record, args, prompt, outputSchema, externalBefore: before.externalBefore });
  clearStage(record.id);

  const { child, spawnError, earlyOutput } = await spawnAndAwaitStart(target, launch.guardedArgs, {
    stdio: ["pipe", "pipe", "pipe"],
    env: launch.env(),
    windowsHide: true,
    ...spawnOptions
  });
  if (spawnError) return failedStart(record, `failed to spawn ${target.cmd}: ${spawnError.message}`);

  const now = new Date().toISOString();
  const run = openRun({ record, child, outputSchema, logPath, before, now });
  processes.set(record.id, child);
  run.quotaWatch = watchQuota(run, now);
  await persist(run, run.live);
  run.runId = await ensureRunRecord(run.live, run.live.run_count);
  run.logStream = createWriteStream(logPath, { flags: "a" });
  run.logStream.on("error", () => {});
  child.stdin.on("error", (error) => { noteStdinFailure(run, error); });
  attachStreams(run, earlyOutput);

  let settleRun;
  const settled = new Promise((resolveSettled) => { settleRun = resolveSettled; });
  child.once("close", (code, signal) => { void finalizeChild(run, code, signal).finally(settleRun); });
  if (child.exitCode !== null || child.signalCode !== null) {
    setImmediate(() => { void finalizeChild(run, child.exitCode, child.signalCode).finally(settleRun); });
  }

  try {
    child.stdin.end(launch.prompt);
  } catch (error) {
    await noteStdinFailure(run, error);
  }
  return { ok: true, record: run.live, child, settled };
}
