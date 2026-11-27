// Starts one worker process and tracks it to the end. Runs inside the detached
// run host, so the worker's output, exit and acceptance are recorded even when
// the MCP server that dispatched it is gone.
import "../app/compose.js";
import { failedStart, processes } from "../app/run-state.js";
import { captureExternalOutputs } from "../infra/external-output.js";
import { hideChildConsole, spawnProcess } from "../infra/process.js";
import { clearStage } from "../infra/stage-store.js";
import { appendTaskEvent, ensureRunRecord } from "../infra/store/events.js";
import { getTask } from "../infra/store/tasks.js";
import { snapshotTaskOutput } from "../infra/worktree.js";
import { loadRunner } from "../runners/registry.js";
import { finalizeChild } from "./finalize.js";
import { buildLaunch } from "./launch.js";
import { persist, startingRow, watchQuota } from "./live-run.js";
import { attachStreams } from "./streams.js";
import { createWriteStream, statSync } from "node:fs";

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

// finalizeChild runs detached from any caller. A rejection there would end the
// run host as an unhandled rejection, so it is reported and recorded instead.
// The note goes onto the row as it is stored now, not onto this process's last
// snapshot: another process may already have closed the row, and writing an
// older "running" snapshot over it would reopen a finished worker.
async function noteFinalizeFailure(run, error) {
  process.stderr.write(`[agent-supervisor] finalize failed for ${run.record.id}: ${error.stack ?? error.message}\n`);
  await appendTaskEvent(run.record.id, { type: "supervisor.finalize_failed", error: error.message, stack: String(error.stack ?? "").slice(0, 2000), run: run.live.run_count },
    { runId: run.runId, actor: "supervisor" }).catch(() => null);
  const stored = await getTask(run.record.id).catch(() => null);
  const base = stored ?? run.live;
  await persist(run, { ...base, error: base.error ?? `supervisor could not finish recording this run: ${error.message}`, updated_at: new Date().toISOString() });
}

export async function trackRunInHost({ record, args, prompt, logPath, spawnOptions = {}, outputSchema = true }) {
  // The run host is its own process: a third-party runner is loaded here again.
  const capability = await (await loadRunner(record.worker)).capabilityPreflight();
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
    windowsHide: hideChildConsole,
    ...spawnOptions,
    env: { ...launch.env(), ...spawnOptions.env, ...target.env }
  });
  if (spawnError) return failedStart(record, `failed to spawn ${target.cmd}: ${spawnError.message}`);

  const now = new Date().toISOString();
  const run = openRun({ record, child, outputSchema, logPath, before, now });
  processes.set(record.id, child);
  run.quotaWatch = watchQuota(run, now);
  await persist(run, run.live);
  run.runId = await ensureRunRecord(run.live, run.live.run_count);
  // Where the next line will start, so a stored event can say where its full body is.
  run.logOffset = statSync(logPath, { throwIfNoEntry: false })?.size ?? 0;
  run.logStream = createWriteStream(logPath, { flags: "a" });
  // A log that cannot be written is not the place to keep the only copy of anything.
  run.logStream.on("error", () => { run.logFailed = true; });
  child.stdin.on("error", (error) => { noteStdinFailure(run, error); });
  attachStreams(run, earlyOutput);

  let settleRun;
  const settled = new Promise((resolveSettled) => { settleRun = resolveSettled; });
  const finalize = (code, signal) => { void finalizeChild(run, code, signal).catch((error) => noteFinalizeFailure(run, error)).finally(settleRun); };
  child.once("close", finalize);
  if (child.exitCode !== null || child.signalCode !== null) setImmediate(() => finalize(child.exitCode, child.signalCode));

  try {
    child.stdin.end(launch.prompt);
  } catch (error) {
    await noteStdinFailure(run, error);
  }
  return { ok: true, record: run.live, child, settled };
}
