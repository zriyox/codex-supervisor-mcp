import "../app/compose.js";
import { DEFAULT_ACCEPTANCE_TIMEOUT_MS, runAcceptance } from "../app/acceptance.js";
import { terminateChild } from "../app/cancel.js";
import { acceptanceRuns, cancelledTasks, failedStart, processes } from "../app/run-state.js";
import { splitLines, workspaceSetupWriteRoots } from "../app/worktree-setup.js";
import { findOutsideOwnedChanges } from "../domain/owned-changes.js";
import { buildGuardPreamble } from "../domain/prompt.js";
import { TERMINAL_STATUSES } from "../domain/status.js";
import { withWorkerToolPath } from "../domain/worker-env.js";
import { parseWorkerReportForRun, workerReportSchemaPath } from "../domain/worker-report.js";
import { captureExternalOutputs, compareExternalOutputs } from "../infra/external-output.js";
import { spawnProcess } from "../infra/process.js";
import { cacheRoots } from "../infra/sandbox-roots.js";
import { clearStage } from "../infra/stage-store.js";
import { runIdFor } from "../infra/store/db.js";
import { appendTaskEvent, appendTaskEvents, completeRunRecord, ensureRunRecord } from "../infra/store/events.js";
import { getWorkItemForTask, recordFact } from "../infra/store/facts.js";
import { updateWorkItemDelivery } from "../infra/store/records.js";
import { getTask, upsertTask } from "../infra/store/tasks.js";
import { captureWorkspaceManifest } from "../infra/workspace-kind.js";
import { readTaskChanges, snapshotTaskOutput } from "../infra/worktree.js";
import { codexRunner } from "../runners/codex/adapter.js";
import { supervisorMcpDisableArgs } from "../runners/codex/mcp-config.js";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

async function recordOutcomeFacts({ task, runId, report, reportEventId = null, acceptanceEventId = null, acceptancePassed = false }) {
  if (!report?.valid) return;
  const workItem = await getWorkItemForTask(task.id);
  if (!workItem) return;
  const validForManifestHash = task.run_evidence?.workspace?.after_manifest?.sha256 ?? null;
  const candidate = await recordFact({
    workItemId: workItem.id,
    scopeType: "run",
    scopeId: runId,
    key: "worker_outcome",
    value: report.report,
    state: "candidate",
    sourceEventId: reportEventId,
    validForSha: task.base_commit ?? null,
    validForContentHash: task.input_context?.content_hash ?? null,
    validForManifestHash,
    watchedPaths: task.owned_paths ?? []
  });
  if (!acceptancePassed || report.format === "text") return;
  await recordFact({
    workItemId: workItem.id,
    scopeType: "work_item",
    scopeId: workItem.id,
    key: "accepted_outcome",
    value: report.report,
    state: "verified",
    sourceEventId: acceptanceEventId,
    validForSha: task.base_commit ?? null,
    validForContentHash: task.input_context?.content_hash ?? null,
    validForManifestHash,
    watchedPaths: task.owned_paths ?? [],
    supersedesId: candidate.id,
    verifiedBy: "supervisor.acceptance"
  });
  await updateWorkItemDelivery(task.id, "verified");
}

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

// Attaches stream handlers and keeps `record` in the supervisor database.
// Every write goes through one serialized chain so concurrent stdout/stderr
// callbacks cannot interleave and persist out of order.
export async function trackRunInHost({ record, args, prompt, logPath, spawnOptions = {}, outputSchema = true }) {
  const capability = codexRunner.capabilityPreflight();
  if (!capability.ok) return failedStart(record, capability.error);
  const target = capability.target;
  const outputBefore = snapshotTaskOutput(record);
  const workspaceBefore = record.workspace_metadata?.before_manifest ?? null;
  const externalBefore = await captureExternalOutputs(record.guard_policy?.externalOutputs ?? [], { checkBaseline: (record.run_count ?? 0) === 0 });
  const owned = [...findOutsideOwnedChanges(record, []).mapping.map((entry) => entry.worker), ...externalBefore.map((entry) => entry.path)];
  const guardPolicy = { cwd: record.cwd, worktree: record.cwd, sandbox: record.sandbox, ownedPaths: owned, ...(record.guard_policy ?? {}),
    output_schema: outputSchema,
    goalTokenBudget: record.goal_token_budget ?? null,
    allowedCommands: [
      ...(record.guard_policy?.allowedCommands ?? []),
      ...(record.acceptance ?? []).map((check) => typeof check === "string" ? check : check.command),
      // This CLI writes only data/stages/<this task>.json. It is part of the
      // runtime contract, not an ad-hoc command the model must declare. The
      // task id comes from the injected environment; stage.js has no override.
      'node "$CODEX_SUPERVISOR_STAGE_CLI"*',
      'node "$CODEX_SUPERVISOR_ACCEPTANCE_CLI"*'
    ] };
  const guard = fileURLToPath(new URL("../runners/codex/tool-guard.js", import.meta.url));
  const stageCli = fileURLToPath(new URL("../interface/bin/stage.js", import.meta.url));
  const acceptanceCli = fileURLToPath(new URL("../interface/bin/acceptance-cli.js", import.meta.url));
  const quoteCommand = (path) => process.platform === "win32" ? `"${path.replace(/"/g, '""')}"` : `'${path.replace(/'/g, "'\\''")}'`;
  const hookCommand = `${quoteCommand(process.execPath)} ${quoteCommand(guard)}`;
  const configArgs = [...(outputSchema ? ["--output-schema", workerReportSchemaPath] : []), "--dangerously-bypass-hook-trust", "-c",
    `hooks.PreToolUse=[{matcher="Bash|apply_patch|create_goal",hooks=[{type="command",command=${JSON.stringify(hookCommand)}}]}]`];
  // A worker may use its explicitly configured business MCP servers, but it
  // must not inherit this supervisor and create a second orchestration tree.
  configArgs.push(...supervisorMcpDisableArgs());
  configArgs.push("-c", `sandbox_workspace_write.network_access=${record.guard_policy?.networkAccess === true}`);
  const sandboxWritableRoots = [...new Set([
    ...externalBefore.map((file) => dirname(file.path)),
    ...cacheRoots(),
    ...workspaceSetupWriteRoots(record),
    ...(record.guard_policy?.writableRoots ?? [])
  ])];
  if (sandboxWritableRoots.length) configArgs.push("-c", `sandbox_workspace_write.writable_roots=${JSON.stringify(sandboxWritableRoots)}`);
  // Insert before the prompt/session positional arguments for exec/resume.
  const guardedArgs = [...args.slice(0, -1), ...configArgs, args.at(-1)];
  prompt = `${buildGuardPreamble(guardPolicy)}\n\n${prompt}`;

  clearStage(record.id);

  const { child, spawnError, earlyOutput } = await spawnAndAwaitStart(target, guardedArgs, {
    stdio: ["pipe", "pipe", "pipe"],
    env: withWorkerToolPath({ ...process.env, NO_COLOR: "1", CODEX_SUPERVISOR_TASK_ID: record.id,
      CODEX_SUPERVISOR_BASE_COMMIT: record.base_commit ?? "",
      CODEX_SUPERVISOR_STAGE_CLI: stageCli,
      CODEX_SUPERVISOR_ACCEPTANCE_CLI: acceptanceCli,
      CODEX_SUPERVISOR_RUN: String((record.run_count ?? 0) + 1), CODEX_SUPERVISOR_GUARD_POLICY: JSON.stringify(guardPolicy) }),
    windowsHide: true,
    ...spawnOptions
  });

  if (spawnError) {
    return failedStart(record, `failed to spawn ${target.cmd}: ${spawnError.message}`);
  }

  const now = new Date().toISOString();
  // A new run starts clean. A resumed worker used to carry the error from
  // the run that was lost, so a worker that was plainly running still showed
  // "process disappeared" until it finished.
  const priorAttemptFingerprint = record.run_evidence?.attempt_fingerprint ?? null;
  const reportOnlyRecovery = record.attention_reason === "invalid_report";
  let live = {
    ...record,
    status: "running",
    phase: "starting",
    pid: child.pid ?? null,
    run_host_pid: process.pid,
    started_at: now,
    completed_at: null,
    exit_code: null,
    signal: null,
    error: null,
    cancel_requested_at: null,
    acceptance_results: null,
    attention_reason: null,
    run_evidence: null,
    guard_policy: { ...record.guard_policy, output_schema: outputSchema },
    commands: [],
    last_message: null,
    current_action: null,
    current_command: null,
    // A resumed row still carries the last event of the run that ended;
    // idle time for this run counts from now.
    last_event_at: now,
    last_event_type: null,
    run_count: (record.run_count ?? 0) + 1,
    updated_at: now
  };
  processes.set(record.id, child);
  let quotaReason = null;
  const maxRunMs = record.guard_policy?.maxRunMs;
  const maxTotalMs = record.guard_policy?.maxTotalMs;
  const quotaWatch = maxRunMs || maxTotalMs ? setInterval(() => {
    if (quotaReason) return;
    if (maxRunMs && Date.now() - Date.parse(now) >= maxRunMs) quotaReason = "run_time_limit";
    else if (maxTotalMs && Date.now() - Date.parse(record.created_at) >= maxTotalMs) quotaReason = "total_time_limit";
    if (quotaReason) terminateChild(child);
  }, 250) : null;

  let writeChain = Promise.resolve();
  const writeSnapshot = (next) => {
    live = next;
    const snapshot = live;
    const pending = writeChain.then(() => upsertTask(snapshot));
    // Keep later writes usable after one failed snapshot. Callers that need
    // failure visibility use the returned promise explicitly.
    writeChain = pending.catch(() => {});
    return pending;
  };
  const persist = async (next, label = "persist") => {
    try { await writeSnapshot(next); }
    catch (error) {
      await appendTaskEvent(next.id, { type: "supervisor.persist_failed", label, error: error.message, run: next.run_count },
        { runId: runIdFor(next.id, next.run_count), actor: "supervisor" }).catch(() => null);
      process.stderr.write(`[codex-supervisor] ${label} failed for ${next.id}: ${error.message}\n`);
    }
  };
  await persist(live);
  const runId = await ensureRunRecord(live, live.run_count);

  const logStream = createWriteStream(logPath, { flags: "a" });
  logStream.on("error", () => {});

  // A child that exits early makes this write fail with EPIPE. That must not
  // reach the process level, or one oversized prompt kills the MCP server.
  child.stdin.on("error", (error) => {
    persist({
      ...live,
      error: live.error ?? `stdin write failed: ${error.message}`,
      updated_at: new Date().toISOString()
    });
  });

  let eventChain = Promise.resolve();
  let terminalEvent = false;
  let rawReport = null;
  let rawReportEventId = null;
  const projectOutcomeFacts = async (finalRecord, { acceptanceEventId = null, acceptancePassed = false } = {}) => {
    try {
      await recordOutcomeFacts({
        task: finalRecord,
        runId,
        report: finalRecord.run_evidence?.structured_report,
        reportEventId: rawReportEventId,
        acceptanceEventId,
        acceptancePassed
      });
    } catch (error) {
      await appendTaskEvent(finalRecord.id, { type: "supervisor.fact_record_failed", error: error.message, run: live.run_count },
        { runId, actor: "supervisor" }).catch(() => null);
      process.stderr.write(`[codex-supervisor] fact projection failed for ${finalRecord.id}: ${error.message}\n`);
    }
  };
  const handleLines = async (lines) => {
    const events = [];
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        logStream.write(`${JSON.stringify(event)}\n`);
        events.push(event);
      } catch (error) {
        logStream.write(`${JSON.stringify({ type: "supervisor.parse_error", line, error: error.message })}\n`);
      }
    }
    if (events.length === 0) return;
    const storedEvents = await appendTaskEvents(record.id, events, { runId, actor: "codex" });
    let next = live;
    for (const [index, event] of events.entries()) {
      if (event.type === "item.completed" && event.item?.type === "agent_message") {
        rawReport = event.item.text;
        rawReportEventId = storedEvents[index].id;
      }
      if (["turn.completed", "turn.failed"].includes(event.type)) terminalEvent = true;
      next = codexRunner.parseEvent(next, event);
    }
    await persist(next);
  };

  let stdoutRest = "";
  let pendingLines = [];
  let eventFlushPending = false;
  const queueEventLines = (lines) => {
    pendingLines.push(...lines);
    if (eventFlushPending) return;
    eventFlushPending = true;
    eventChain = eventChain.then(async () => {
      await new Promise((resolveFlush) => setImmediate(resolveFlush));
      const batch = pendingLines;
      pendingLines = [];
      eventFlushPending = false;
      await handleLines(batch);
    }).catch((error) => {
      process.stderr.write(`[codex-supervisor] event handling failed for ${record.id}: ${error.message}\n`);
    });
  };
  const handleStdoutChunk = (chunk) => {
    const split = splitLines(stdoutRest, chunk.toString("utf8"));
    stdoutRest = split.rest;
    const lines = split.lines.filter((line) => line.trim());
    if (lines.length) queueEventLines(lines);
  };
  earlyOutput.capture = false;
  for (const chunk of earlyOutput.stdout) handleStdoutChunk(chunk);
  child.stdout.on("data", handleStdoutChunk);
  child.stdout.on("error", () => {});

  let stderr = earlyOutput.stderr.map((chunk) => chunk.toString("utf8")).join("");
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
    persist({ ...live, stderr_tail: stderr.slice(-4000), updated_at: new Date().toISOString() });
  });
  child.stderr.on("error", () => {});

  child.on("error", (error) => {
    persist({
      ...live,
      error: live.error ?? `codex process error: ${error.message}`,
      updated_at: new Date().toISOString()
    });
  });

  let settleRun;
  const settled = new Promise((resolveSettled) => { settleRun = resolveSettled; });
  let childSettled = false;
  const finalizeChild = async (code, signal) => {
    if (childSettled) return;
    childSettled = true;
    if (quotaWatch) clearInterval(quotaWatch);
    processes.delete(record.id);
    if (stdoutRest.trim()) queueEventLines([stdoutRest]);
    await eventChain.catch(() => {});
    logStream.end();
    const finishedAt = new Date().toISOString();
    const stored = await getTask(record.id).catch(() => null);
    // A cancel can be issued from another MCP process, so the marker is read
    // back from disk rather than trusted to this process's memory.
    const cancelRequested = cancelledTasks.has(record.id)
      || Boolean(live.cancel_requested_at)
      || Boolean(stored?.cancel_requested_at);
    let status;
    if (stored && TERMINAL_STATUSES.has(stored.status) && stored.status !== live.status) status = stored.status;
    else if (terminalEvent && TERMINAL_STATUSES.has(live.status)) status = live.status;
    else if (cancelRequested) status = "cancelled";
    // Killed by a signal nobody asked for: the worker did not fail, it
    // vanished. Re-running is the fix, so it is reported as lost.
    else if (signal) status = "lost";
    else if (code === 0) status = "lost";
    else status = "failed";
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
    if (quotaReason) { next.attention_reason = quotaReason; next.error = `Supervisor time quota exceeded: ${quotaReason}; inspect partial work before changing the budget`; }
    const outputAfter = snapshotTaskOutput(live);
    let externalChanges = [];
    try { externalChanges = compareExternalOutputs(externalBefore, await captureExternalOutputs(record.guard_policy?.externalOutputs ?? [])); }
    catch (error) { next.attention_reason = "external_output_unverified"; next.error = error.message; }
    let workspaceAfter = null;
    if (workspaceBefore && Array.isArray(record.workspace_metadata?.manifest_paths)) {
      try {
        workspaceAfter = await captureWorkspaceManifest(record.workspace_metadata.source_root, record.workspace_metadata.manifest_paths);
      } catch (error) {
        next.attention_reason = "workspace_manifest_unverified";
        next.error = error.message;
      }
    }
    const structuredReport = parseWorkerReportForRun(rawReport, { outputSchema });
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
    if (status === "completed" && code === 0 && live.sandbox !== "read-only"
      && !next.run_evidence.output_changed && next.run_evidence.output_changed !== null
      && live.commands.length === 0 && !reportOnlyRecovery) {
      next.attention_reason = priorAttemptFingerprint === next.run_evidence.attempt_fingerprint ? "two_stall" : "no_work";
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

    // Acceptance runs after the worker is gone, in two writes. The first
    // records the terminal status with exit_code still null and the run
    // marked as this process's, so a wait keeps waiting and reconcile
    // (which sees a dead codex pid) leaves the row alone; the second
    // records exit_code and the verdict. changed_files is read before the
    // checks run so build output they leave behind is not counted as the
    // worker's.
    const acceptance = Array.isArray(live.acceptance) && live.acceptance.length > 0 ? live.acceptance : null;
    if (acceptance && (status === "completed" || status === "failed")) {
      const control = { kill: null, cancelled: false, isCancelled: () => control.cancelled };
      acceptanceRuns.set(record.id, control);
      await persist({
        ...next,
        exit_code: null,
        signal: null,
        current_action: "Running acceptance",
        acceptance_results: { status: "running", passed: null, run: live.run_count, supervisor_pid: process.pid, started_at: finishedAt }
      });
      // A fresh MCP has no in-memory acceptance handle. Consume its durable
      // cancellation marker while a command runs, then stop subsequent checks.
      const cancellationWatch = setInterval(async () => {
        const current = await getTask(record.id).catch(() => null);
        if (current?.cancel_requested_at) {
          control.cancelled = true;
          control.kill?.();
        }
      }, 100);
      let results;
      try { results = await runAcceptance(acceptance, {
        cwd: record.cwd,
        timeoutMs: live.acceptance_timeout_ms ?? DEFAULT_ACCEPTANCE_TIMEOUT_MS,
        run: live.run_count,
        taskId: record.id,
        baseCommit: live.base_commit,
        control
      }); } finally { clearInterval(cancellationWatch); }
      acceptanceRuns.delete(record.id);
      const event = { type: "supervisor.acceptance", ...results };
      const acceptanceEvent = await appendTaskEvent(record.id, event, { runId, actor: "supervisor" }).catch(() => null);
      await appendFile(logPath, `${JSON.stringify(event)}\n`).catch(() => {});
      const failing = results.checks.find((check) => check.passed === false || check.exit_code !== 0 || check.timed_out);
      const finalRecord = {
        ...next,
        acceptance_results: results,
        current_action: results.status === "passed"
          ? "Completed, acceptance passed"
          : results.status === "failed"
            ? `Acceptance failed: ${failing ? `${failing.command.slice(0, 80)} exit ${failing.error ?? (failing.baseline?.passed === false ? "baseline/evidence mismatch" : failing.timed_out ? "timeout" : failing.exit_code ?? "?")}` : results.error ?? "see acceptance_results"}`
            : next.current_action,
        updated_at: new Date().toISOString()
      };
      // The terminal lifecycle and exit code are primary evidence. Persist
      // them before fact projection, which is secondary and may fail on a
      // stale control record without turning completed work into lost work.
      await persist(finalRecord, "final persist");
      await projectOutcomeFacts(finalRecord, {
        acceptanceEventId: acceptanceEvent?.id ?? null,
        acceptancePassed: results.passed === true
      });
      if (finalRecord.attention_reason === "two_stall") await updateWorkItemDelivery(finalRecord.id, "needs_attention");
      await completeRunRecord(finalRecord, live.run_count);
    } else {
      const finalRecord = acceptance ? { ...next, acceptance_results: null } : next;
      await persist(finalRecord, "final persist");
      await projectOutcomeFacts(finalRecord);
      if (finalRecord.attention_reason === "two_stall") await updateWorkItemDelivery(finalRecord.id, "needs_attention");
      await completeRunRecord(finalRecord, live.run_count);
    }
    cancelledTasks.delete(record.id);
  };
  child.once("close", (code, signal) => { void finalizeChild(code, signal).finally(settleRun); });
  if (child.exitCode !== null || child.signalCode !== null) {
    setImmediate(() => { void finalizeChild(child.exitCode, child.signalCode).finally(settleRun); });
  }

  try {
    child.stdin.end(prompt);
  } catch (error) {
    await persist({
      ...live,
      error: live.error ?? `stdin write failed: ${error.message}`,
      updated_at: new Date().toISOString()
    });
  }

  return { ok: true, record: live, child, settled };
}
