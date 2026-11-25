// What happens after the worker process closes: decide the terminal status,
// gather the evidence of what the run did, flag runs that need attention, run
// acceptance and write the final row.
import { DEFAULT_ACCEPTANCE_TIMEOUT_MS, runAcceptance } from "../app/acceptance.js";
import { acceptanceRuns, cancelledTasks, processes } from "../app/run-state.js";
import { TERMINAL_STATUSES } from "../domain/status.js";
import { parseWorkerReportForRun } from "../domain/worker-report.js";
import { captureExternalOutputs, compareExternalOutputs } from "../infra/external-output.js";
import { appendTaskEvent, completeRunRecord } from "../infra/store/events.js";
import { updateWorkItemDelivery } from "../infra/store/records.js";
import { getTask } from "../infra/store/tasks.js";
import { captureWorkspaceManifest } from "../infra/workspace-kind.js";
import { readTaskChanges, snapshotTaskOutput } from "../infra/worktree.js";
import { persist } from "./live-run.js";
import { projectOutcomeFacts } from "./outcome-facts.js";
import { queueEventLines } from "./streams.js";
import { createHash } from "node:crypto";
import { appendFile } from "node:fs/promises";

function terminalStatus(run, stored, code, signal) {
  const { live } = run;
  // A cancel can be issued from another MCP process, so the marker is read
  // back from disk rather than trusted to this process's memory.
  const cancelRequested = cancelledTasks.has(run.record.id)
    || Boolean(live.cancel_requested_at)
    || Boolean(stored?.cancel_requested_at);
  if (stored && TERMINAL_STATUSES.has(stored.status) && stored.status !== live.status) return stored.status;
  if (run.terminalEvent && TERMINAL_STATUSES.has(live.status)) return live.status;
  if (cancelRequested) return "cancelled";
  // The supervisor stopped it for running out of time; the signal was its own.
  if (run.quotaReason) return "timed_out";
  // Killed by a signal nobody asked for: the worker did not fail, it
  // vanished. Re-running is the fix, so it is reported as lost.
  if (signal) return "lost";
  if (code === 0) return "lost";
  return "failed";
}

function terminalRow(run, status, code, signal, finishedAt) {
  const { live } = run;
  const next = {
    ...live,
    status,
    phase: null,
    changed_files: readTaskChanges(live),
    exit_code: code,
    signal,
    current_command: null,
    current_action: status === "completed" ? "Completed" : live.current_action,
    completed_at: live.completed_at ?? finishedAt,
    updated_at: finishedAt
  };
  const stdinEpipe = /^stdin write failed:.*\bEPIPE\b/i.test(next.error ?? "");
  if (status === "failed" && (!next.error || stdinEpipe)) {
    next.error = `codex exited with code ${code}${signal ? ` (signal ${signal})` : ""}`;
  }
  if (status === "lost" && (!next.error || stdinEpipe)) {
    next.error = signal ? `codex worker was killed by signal ${signal} before writing a terminal event` : "Codex worker exited without recording a terminal event";
  }
  if (status === "cancelled") next.error = null;
  if (run.quotaReason) {
    next.attention_reason = run.quotaReason;
    next.error = `Supervisor time quota exceeded: ${run.quotaReason}; inspect partial work before changing the budget`;
  }
  return next;
}

async function externalChangesOf(run, next) {
  try {
    return compareExternalOutputs(run.externalBefore, await captureExternalOutputs(run.record.guard_policy?.externalOutputs ?? []));
  } catch (error) {
    next.attention_reason = "external_output_unverified";
    next.error = error.message;
    return [];
  }
}

async function workspaceAfterOf(run, next) {
  const metadata = run.record.workspace_metadata;
  if (!run.workspaceBefore || !Array.isArray(metadata?.manifest_paths)) return null;
  try {
    return await captureWorkspaceManifest(metadata.source_root, metadata.manifest_paths);
  } catch (error) {
    next.attention_reason = "workspace_manifest_unverified";
    next.error = error.message;
    return null;
  }
}

// Records what the run changed and a fingerprint of the attempt, used to tell
// two consecutive runs that made no progress.
async function attachEvidence(run, next) {
  const { live, record, workspaceBefore, outputBefore } = run;
  const outputAfter = snapshotTaskOutput(live);
  const externalChanges = await externalChangesOf(run, next);
  const workspaceAfter = await workspaceAfterOf(run, next);
  const structuredReport = parseWorkerReportForRun(run.rawReport, { outputSchema: run.outputSchema });
  next.run_evidence = {
    run: live.run_count, commands_run: live.commands.length,
    structured_report: structuredReport,
    output_before: outputBefore, output_after: outputAfter,
    output_changed: outputBefore && outputAfter ? outputBefore !== outputAfter : null,
    workspace: workspaceBefore ? {
      kind: record.workspace_kind,
      before_manifest: workspaceBefore,
      after_manifest: workspaceAfter,
      manifest_changed: workspaceAfter ? workspaceBefore.sha256 !== workspaceAfter.sha256 : null
    } : null
  };
  next.run_evidence.external_outputs = externalChanges;
  if (externalChanges.some((entry) => entry.changed)) next.run_evidence.output_changed = true;
  next.changed_files = [...new Set([...next.changed_files, ...externalChanges.filter((entry) => entry.changed).map((entry) => entry.path)])];
  next.run_evidence.attempt_fingerprint = createHash("sha256").update(JSON.stringify({
    output_changed: next.run_evidence.output_changed,
    commands_run: live.commands.length,
    changed_files: next.changed_files,
    acceptance_configured: Array.isArray(live.acceptance) && live.acceptance.length > 0,
    workspace_manifest_changed: next.run_evidence.workspace?.manifest_changed ?? null
  })).digest("hex");
}

// "The evidence could not be read" outranks what the evidence would have
// said: no_work and invalid_report are both conclusions drawn from it.
const UNVERIFIED = new Set(["external_output_unverified", "workspace_manifest_unverified"]);

export function flagAttention(run, next, status, code) {
  const { live } = run;
  if (UNVERIFIED.has(next.attention_reason)) return;
  if (status === "completed" && code === 0 && live.sandbox !== "read-only"
    && !next.run_evidence.output_changed && next.run_evidence.output_changed !== null
    && live.commands.length === 0 && !run.reportOnlyRecovery) {
    next.attention_reason = run.priorAttemptFingerprint === next.run_evidence.attempt_fingerprint ? "two_stall" : "no_work";
    if (next.attention_reason === "two_stall") next.current_action = "No progress in two consecutive runs; needs attention";
  }
  if (status === "completed" && !next.run_evidence.structured_report.valid && !live.guard_policy?.preflight) {
    // The report is a summary, not the business result. Keep the completed
    // lifecycle and let acceptance plus the reviewed diff decide whether it
    // can land; a report-only recovery can still repair the summary.
    next.attention_reason = "invalid_report";
    next.error = `Invalid final worker report: ${next.run_evidence.structured_report.error}`;
    next.current_action = "Work completed, but the final report is invalid; acceptance and diff remain authoritative";
  }
}

// The terminal lifecycle and exit code are primary evidence. Persist them
// before fact projection, which is secondary and may fail on a stale control
// record without turning completed work into lost work.
async function writeFinal(run, finalRecord, factOptions) {
  await persist(run, finalRecord, "final persist");
  await projectOutcomeFacts(run, finalRecord, factOptions);
  if (finalRecord.attention_reason === "two_stall") await updateWorkItemDelivery(finalRecord.id, "needs_attention");
  await completeRunRecord(finalRecord, run.live.run_count);
}

function failingCheckLabel(failing, results) {
  if (!failing) return results.error ?? "see acceptance_results";
  const why = failing.error ?? (failing.baseline?.passed === false ? "baseline/evidence mismatch" : failing.timed_out ? "timeout" : failing.exit_code ?? "?");
  return `${failing.command.slice(0, 80)} exit ${why}`;
}

async function runAcceptanceChecks(run, acceptance) {
  const { record, live } = run;
  const control = { kill: null, cancelled: false, isCancelled: () => control.cancelled };
  acceptanceRuns.set(record.id, control);
  // A fresh MCP has no in-memory acceptance handle. Consume its durable
  // cancellation marker while a command runs, then stop subsequent checks.
  const cancellationWatch = setInterval(async () => {
    const current = await getTask(record.id).catch(() => null);
    if (current?.cancel_requested_at) {
      control.cancelled = true;
      control.kill?.();
    }
  }, 100);
  try {
    return await runAcceptance(acceptance, {
      cwd: record.cwd,
      timeoutMs: live.acceptance_timeout_ms ?? DEFAULT_ACCEPTANCE_TIMEOUT_MS,
      run: live.run_count,
      taskId: record.id,
      baseCommit: live.base_commit,
      control
    });
  } finally {
    clearInterval(cancellationWatch);
  }
}

// Acceptance runs after the worker is gone, in two writes. The first records
// the terminal status with exit_code still null and the run marked as this
// process's, so a wait keeps waiting and reconcile (which sees a dead codex
// pid) leaves the row alone; the second records exit_code and the verdict.
// changed_files is read before the checks run so build output they leave
// behind is not counted as the worker's.
async function settleWithAcceptance(run, next, acceptance, finishedAt) {
  const { record, live } = run;
  await persist(run, {
    ...next,
    exit_code: null,
    signal: null,
    current_action: "Running acceptance",
    acceptance_results: { status: "running", passed: null, run: live.run_count, supervisor_pid: process.pid, started_at: finishedAt }
  });
  const results = await runAcceptanceChecks(run, acceptance);
  acceptanceRuns.delete(record.id);
  const event = { type: "supervisor.acceptance", ...results };
  const acceptanceEvent = await appendTaskEvent(record.id, event, { runId: run.runId, actor: "supervisor" }).catch(() => null);
  await appendFile(run.logPath, `${JSON.stringify(event)}\n`).catch(() => {});
  const failing = results.checks.find((check) => check.passed === false || check.exit_code !== 0 || check.timed_out);
  const finalRecord = {
    ...next,
    acceptance_results: results,
    current_action: results.status === "passed"
      ? "Completed, acceptance passed"
      : results.status === "failed"
        ? `Acceptance failed: ${failingCheckLabel(failing, results)}`
        : next.current_action,
    updated_at: new Date().toISOString()
  };
  await writeFinal(run, finalRecord, { acceptanceEventId: acceptanceEvent?.id ?? null, acceptancePassed: results.passed === true });
}

export async function finalizeChild(run, code, signal) {
  if (run.childSettled) return;
  run.childSettled = true;
  const { record } = run;
  if (run.quotaWatch) clearInterval(run.quotaWatch);
  processes.delete(record.id);
  if (run.stdoutRest.trim()) queueEventLines(run, [run.stdoutRest]);
  await run.eventChain.catch(() => {});
  run.logStream.end();
  const finishedAt = new Date().toISOString();
  const stored = await getTask(record.id).catch(() => null);
  const status = terminalStatus(run, stored, code, signal);
  const next = terminalRow(run, status, code, signal, finishedAt);
  await attachEvidence(run, next);
  flagAttention(run, next, status, code);

  const { live } = run;
  const acceptance = Array.isArray(live.acceptance) && live.acceptance.length > 0 ? live.acceptance : null;
  if (acceptance && (status === "completed" || status === "failed")) await settleWithAcceptance(run, next, acceptance, finishedAt);
  else await writeFinal(run, acceptance ? { ...next, acceptance_results: null } : next);
  cancelledTasks.delete(record.id);
}
