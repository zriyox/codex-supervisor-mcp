import { TERMINAL_STATUSES } from "../../domain/status.js";
import { parseWorkerReportForRun } from "../../domain/worker-report.js";
import { decodeJson, openDb, runIdFor } from "./db.js";
import { appendTaskEvent, completeRunRecord, readTaskEvents } from "./events.js";
import { isPidAlive, neverStarted, readActiveTasks, readTasks, rowToTask, writeTask } from "./tasks.js";
import { createHash } from "node:crypto";

// A terminal row whose acceptance run was cut short: the MCP process that
// was running the checks is gone. Left alone it would read as "running"
// forever and land would treat it as never run.
async function reconcileInterruptedAcceptance() {
  const tasks = await readTasks();
  const interrupted = tasks.filter((task) =>
    TERMINAL_STATUSES.has(task.status)
    && task.acceptance_results?.status === "running"
    && !isPidAlive(task.acceptance_results.supervisor_pid));
  for (const task of interrupted) {
    const now = new Date().toISOString();
    const durable = (await readTaskEvents(task.id, 1, ["supervisor.acceptance"]))[0] ?? null;
    if (durable && durable.run === task.run_count) {
      const reportInvalid = task.attention_reason === "invalid_report";
      await writeTask({
        ...task,
        status: reportInvalid ? "completed" : task.status,
        exit_code: task.exit_code ?? (reportInvalid ? 0 : null),
        acceptance_results: durable,
        current_action: durable.passed === true
          ? "Acceptance passed (recovered from the durable event)"
          : `Acceptance ${durable.status} (recovered from the durable event)`,
        updated_at: now
      });
      continue;
    }
    await writeTask({
      ...task,
      acceptance_results: { ...task.acceptance_results, status: "interrupted", passed: null, finished_at: now },
      current_action: "Acceptance interrupted: the supervisor process exited while running the checks",
      updated_at: now
    });
  }
  return interrupted;
}

function lastReportText(events) {
  let reportText = null;
  for (const event of events) {
    if (event.type === "item.completed" && event.item?.type === "agent_message") reportText = event.item.text ?? null;
  }
  return reportText;
}

function recoveredEvidenceFor(task, structuredReport) {
  const evidence = task.run_evidence
    ? { ...task.run_evidence, structured_report: structuredReport }
    : {
        run: task.run_count,
        commands_run: (task.commands ?? []).length,
        structured_report: structuredReport,
        recovered: "turn_completed_without_process_exit"
      };
  if (!evidence.attempt_fingerprint) {
    evidence.attempt_fingerprint = createHash("sha256").update(JSON.stringify({
      output_changed: evidence.output_changed ?? null,
      commands_run: evidence.commands_run ?? (task.commands ?? []).length,
      changed_files: task.changed_files ?? [],
      acceptance_configured: Array.isArray(task.acceptance) && task.acceptance.length > 0,
      workspace_manifest_changed: evidence.workspace?.manifest_changed ?? null
    })).digest("hex");
  }
  return evidence;
}

function recoveredRow(task, recoveredEvidence, now) {
  const reportInvalid = recoveredEvidence.structured_report?.valid === false && !task.guard_policy?.preflight;
  const attentionReason = task.attention_reason ?? (reportInvalid ? "invalid_report" : null);
  const staleExitError = /did not record the process exit|process disappeared/i.test(task.error ?? "");
  const acceptanceResults = task.acceptance_results ?? (task.acceptance?.length ? {
    status: "interrupted", passed: null, run: task.run_count, finished_at: now,
    error: "worker completed before its acceptance result was recorded; rerun acceptance"
  } : null);
  return {
    ...task,
    status: "completed",
    phase: null,
    exit_code: 0,
    attention_reason: attentionReason,
    error: reportInvalid
      ? (staleExitError ? null : task.error) ?? `Invalid final worker report: ${recoveredEvidence.structured_report.error}`
      : staleExitError ? null : task.error ?? null,
    current_action: attentionReason ? task.current_action : "Completed (exit recovered from the durable turn event)",
    current_command: null,
    acceptance_results: acceptanceResults,
    run_evidence: recoveredEvidence,
    completed_at: task.completed_at ?? now,
    updated_at: now
  };
}

// A run host can disappear after Codex has finished its turn but before it
// writes the process exit. The terminal event is already durable, and the
// work did complete; the missing scalar is a supervisor bookkeeping fault,
// not evidence that the worker vanished. Acceptance keeps its own verdict;
// recovering the worker completion must never imply that checks passed.
async function recoverTerminalTurn(task) {
  if (task.exit_code != null || task.signal || !task.started_at
    || isPidAlive(task.pid) || isPidAlive(task.run_host_pid)) return false;
  const runId = runIdFor(task.id, task.run_count);
  const events = openDb().prepare(`
    SELECT payload FROM task_events WHERE task_id = ? AND run_id = ? ORDER BY seq
  `).all(task.id, runId).map((row) => decodeJson(row.payload, null)).filter(Boolean);
  if (!events.some((event) => event.type === "turn.completed")) return false;
  const structuredReport = parseWorkerReportForRun(lastReportText(events), { outputSchema: task.guard_policy?.output_schema !== false });
  const recoveredEvidence = recoveredEvidenceFor(task, structuredReport);
  const now = new Date().toISOString();
  const recoveredTask = recoveredRow(task, recoveredEvidence, now);
  await writeTask(recoveredTask);
  await completeRunRecord(recoveredTask, task.run_count);
  await appendTaskEvent(task.id, {
    type: "supervisor.exit_recovered",
    reason: "turn_completed_without_process_exit",
    exit_code: 0,
    recovered_at: now
  }, { runId, actor: "supervisor" }).catch(() => null);
  return true;
}

export async function reconcileDetachedActiveTasks() {
  await reconcileInterruptedAcceptance();
  const terminalCandidates = openDb().prepare(`
    SELECT * FROM tasks
    WHERE status IN ('completed','lost') AND exit_code IS NULL AND started_at IS NOT NULL
  `).all().map(rowToTask);
  for (const task of terminalCandidates) await recoverTerminalTurn(task);
  const incomplete = (await readTasks()).filter((task) =>
    ["completed", "failed"].includes(task.status) && task.exit_code == null && task.started_at
    && !isPidAlive(task.pid) && !isPidAlive(task.run_host_pid)
    && (!task.acceptance_results || ["interrupted", "cancelled"].includes(task.acceptance_results.status))
    && Date.now() - Date.parse(task.updated_at) > 5000);
  for (const task of incomplete) {
    await writeTask({ ...task, status: "lost", phase: null,
      error: task.acceptance_results?.status === "interrupted"
        ? "Worker ended but its supervisor did not record the process exit before acceptance; resume this run"
        : "Worker ended but its supervisor did not record the process exit; recover this run before treating it as complete",
      current_action: task.acceptance_results?.status === "interrupted"
        ? "Acceptance interrupted: worker process exit was not recorded; resume this run"
        : "Resume required: process exit was not recorded",
      updated_at: new Date().toISOString() });
  }
  const tasks = await readActiveTasks();
  const staleTasks = tasks.filter((task) => !isPidAlive(task.run_host_pid)
    && ((task.pid && !isPidAlive(task.pid)) || neverStarted(task)));
  for (const task of staleTasks) {
    if (await recoverTerminalTurn(task)) continue;
    const now = new Date().toISOString();
    const vanished = Boolean(task.pid);
    await writeTask({
      ...task,
      status: "lost",
      phase: null,
      current_action: vanished
        ? "Worker process disappeared without a terminal event"
        : "Worker was never started: no process was recorded for this row",
      current_command: null,
      error: task.error ?? (vanished
        ? "Codex worker process disappeared before a terminal event was recorded."
        : "Codex worker row was written but no process was ever recorded for it."),
      completed_at: task.completed_at || now,
      updated_at: now
    });
  }
  return staleTasks;
}
