import { createWriteStream, existsSync } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { join, resolve, sep, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendTaskEvent,
  getTask,
  getSession,
  readActiveTasks,
  readTasks,
  readTasksBySession,
  readTaskEvents,
  taskRunPath,
  upsertSession,
  upsertTask,
  claimTaskRun,
  releaseTaskRun,
  reserveTaskOwnership
} from "./task-store.js";
import { applyCodexEvent } from "./event-parser.js";
import { ACTIVE_STATUSES, TERMINAL_STATUSES } from "./status.js";
import { worktreesDir } from "./paths.js";
import { buildGuardPreamble, frameWorkerPrompt } from "./prompt.js";
import { cacheRoots, resolveWritableRoot } from "./sandbox-roots.js";
import { readTaskChanges, snapshotTaskOutput } from "./worktree.js";
import { rebaseWorktree } from "./landing.js";
import { DEFAULT_ACCEPTANCE_TIMEOUT_MS, isArtifactOnlyAcceptance, normalizeAcceptance, runAcceptance } from "./acceptance.js";
import { appendFile } from "node:fs/promises";
import { defaultBinDirs, findBinaryPath, resolveCommand, shimMessage } from "./bin-resolver.js";
import { findOutsideOwnedChanges } from "./owned-changes.js";
import { parseWorkerReport, workerReportSchemaPath } from "./worker-report.js";
import { buildHandoff } from "./handoff.js";
import { captureExternalOutputs, compareExternalOutputs } from "./external-output.js";
import { buildRuntimeContract, createPreflightMetadata, readPreflightResult, runtimeContractHash } from "./worker-preflight.js";

const processes = new Map();
// taskId -> control object of an acceptance run in progress ({ kill, cancelled }).
const acceptanceRuns = new Map();
const cancelledTasks = new Set();
const CODEX_NPM_ENTRY = { pkg: "@openai/codex", bin: "bin/codex.js" };
const defaultGitBin = process.env.GIT_BIN?.trim() || "git";
const allowedReasoningEfforts = new Set(["minimal", "low", "medium", "high"]);

function splitLines(buffer, chunk) {
  const next = buffer + chunk;
  const lines = next.split(/\r?\n/);
  return { lines: lines.slice(0, -1), rest: lines.at(-1) ?? "" };
}

async function exists(path) {
  if (!path) return false;
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function runCommand(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "ignore", windowsHide: true, ...options });
    child.on("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
    child.on("error", reject);
  });
}

function resolveCommit(cwd, ref) {
  return execFileSync(defaultGitBin, ["-C", cwd, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
    encoding: "utf8",
    timeout: 15000,
    stdio: ["ignore", "pipe", "ignore"]
  }).trim();
}

function invalidBaseRefError(cwd, baseRef) {
  const error = new Error(`baseRef "${baseRef}" does not resolve to a commit in ${cwd}`);
  error.code = "invalid_base_ref";
  return error;
}

// The worktree is cut from baseRef when given, else from the repository's
// HEAD. The resolved commit is recorded on the task: it is what
// readWorktreeChanges diffs against, so committed work stays visible. An
// explicit baseRef that does not resolve is an error, not a silent fallback
// to HEAD - the caller asked for a specific baseline for a reason.
async function ensureWorktree(cwd, taskId, baseRef = null) {
  const taskWorktreeDir = join(worktreesDir, taskId);
  await mkdir(worktreesDir, { recursive: true });
  const gitDir = join(cwd, ".git");
  if (!(await exists(cwd)) || !(await exists(gitDir))) {
    if (baseRef) throw invalidBaseRefError(cwd, baseRef);
    return { path: null, baseCommit: null };
  }
  let baseCommit;
  try {
    baseCommit = resolveCommit(cwd, baseRef ?? "HEAD");
  } catch {
    if (baseRef) throw invalidBaseRefError(cwd, baseRef);
    return { path: null, baseCommit: null };
  }
  if (!baseCommit) {
    if (baseRef) throw invalidBaseRefError(cwd, baseRef);
    return { path: null, baseCommit: null };
  }
  try {
    await rm(taskWorktreeDir, { recursive: true, force: true });
    const branch = `codex/${taskId}`;
    await runCommand(defaultGitBin, ["-C", cwd, "worktree", "add", "--detach", taskWorktreeDir, baseCommit]);
    await runCommand(defaultGitBin, ["-C", taskWorktreeDir, "switch", "-c", branch]);
    return { path: taskWorktreeDir, baseCommit };
  } catch (error) {
    const failure = new Error(`could not create isolated worker checkout: ${error.message}`);
    failure.code = "worktree_creation_failed";
    throw failure;
  }
}

function normalizeOwnedPaths(ownedPaths, projectRoot) {
  if (!Array.isArray(ownedPaths)) return [];
  return Array.from(new Set(ownedPaths.map((entry) => resolve(projectRoot, String(entry).trim()))));
}

function pathOverlaps(left, right) {
  // Windows paths are case-insensitive and may mix separators, so compare on a
  // normalized form there. macOS and Linux keep the exact previous comparison -
  // a backslash is a legal filename character on those platforms.
  const windows = process.platform === "win32";
  const normalize = (value) => (windows ? value.replace(/[\\/]+/g, sep).toLowerCase() : value);
  const mine = normalize(left);
  const theirs = normalize(right);
  if (mine === theirs) return true;
  const minePrefix = mine.endsWith(sep) ? mine : `${mine}${sep}`;
  const theirsPrefix = theirs.endsWith(sep) ? theirs : `${theirs}${sep}`;
  return minePrefix.startsWith(theirsPrefix) || theirsPrefix.startsWith(minePrefix);
}

// Two workers claiming overlapping paths will collide when their branches are
// merged, so the second dispatch is refused before any worktree is created.
export async function findOwnershipConflicts(ownedPaths, { excludeTaskId = null } = {}) {
  if (!ownedPaths || ownedPaths.length === 0) return [];
  const activeTasks = await readActiveTasks();
  const conflicts = [];
  for (const task of activeTasks) {
    if (task.id === excludeTaskId) continue;
    const theirs = Array.isArray(task.owned_paths) ? task.owned_paths : [];
    const overlap = [];
    for (const mine of ownedPaths) {
      for (const other of theirs) {
        if (pathOverlaps(mine, other)) overlap.push({ incoming: mine, existing: other });
      }
    }
    if (overlap.length > 0) {
      conflicts.push({
        task_id: task.id,
        title: task.title,
        status: task.status,
        overlapping_paths: overlap
      });
    }
  }
  return conflicts;
}

function ownershipConflictError(conflicts) {
  const owners = conflicts.map((conflict) => conflict.task_id).join(", ");
  const error = new Error(`ownedPaths overlap with active worker(s): ${owners}`);
  error.code = "ownership_conflict";
  error.conflicts = conflicts;
  return error;
}

// The Codex CLI as a spawnable target. On Windows npm installs a `codex.cmd`
// shim that Node refuses to spawn directly, so bin-resolver.js steps over it and
// hands back `node <entry>` instead; on macOS and Linux this is the bare name,
// unchanged. Resolved per dispatch so a CLI installed later is picked up.
function codexTarget() {
  const configured = process.env.CODEX_BIN?.trim();
  const located = configured ? configured : (findBinaryPath("codex", { extraDirs: defaultBinDirs() }) ?? "codex");
  const target = resolveCommand(located, { npmEntry: CODEX_NPM_ENTRY });
  if (target.shim) return { error: shimMessage("codex", target.cmd, "CODEX_BIN") };
  return { cmd: target.cmd, prefixArgs: target.prefixArgs };
}

function failedStart(record, reason) {
  const now = new Date().toISOString();
  return {
    ok: false,
    record: {
      ...record,
      status: "failed",
      phase: null,
      pid: null,
      error: reason,
      attention_reason: "start_failed",
      completed_at: now,
      updated_at: now
    }
  };
}

// Spawn can fail either by throwing synchronously, or by emitting "error"
// instead of "spawn". Both paths are handled so a bad CODEX_BIN marks the task
// failed instead of taking the whole MCP process down.
async function spawnAndAwaitStart(target, args, options) {
  const child = spawn(target.cmd, [...target.prefixArgs, ...args], options);
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
  return { child, spawnError };
}

// Attaches stream handlers and keeps `record` in the supervisor database.
// Every write goes through one serialized chain so concurrent stdout/stderr
// callbacks cannot interleave and persist out of order.
async function trackRunInHost({ record, args, prompt, logPath, spawnOptions = {} }) {
  const target = codexTarget();
  if (target.error) return failedStart(record, target.error);
  try {
    const help = execFileSync(target.cmd, [...target.prefixArgs, "exec", "--help"], { encoding: "utf8", timeout: 15000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    if (!help.includes("--dangerously-bypass-hook-trust") || !help.includes("--output-schema")) return failedStart(record, "Codex CLI lacks required per-run hooks/output-schema; install Codex 0.162 or newer before dispatch");
  } catch (error) { return failedStart(record, error.code === "ENOENT"
    ? `failed to spawn ${target.cmd} for Codex capability preflight: ${error.message}`
    : `Codex capability preflight failed: ${error.message}`); }
  const outputBefore = snapshotTaskOutput(record);
  const externalBefore = await captureExternalOutputs(record.guard_policy?.externalOutputs ?? [], { checkBaseline: (record.run_count ?? 0) === 0 });
  const owned = [...findOutsideOwnedChanges(record, []).mapping.map((entry) => entry.worker), ...externalBefore.map((entry) => entry.path)];
  const guardPolicy = { cwd: record.cwd, worktree: record.cwd, sandbox: record.sandbox, ownedPaths: owned, ...(record.guard_policy ?? {}),
    allowedCommands: [...(record.guard_policy?.allowedCommands ?? []), ...(record.acceptance ?? []).map((check) => typeof check === "string" ? check : check.command)] };
  const guard = fileURLToPath(new URL("./tool-guard.js", import.meta.url));
  const quoteCommand = (path) => process.platform === "win32" ? `"${path.replace(/"/g, '""')}"` : `'${path.replace(/'/g, "'\\''")}'`;
  const hookCommand = `${quoteCommand(process.execPath)} ${quoteCommand(guard)}`;
  const configArgs = ["--output-schema", workerReportSchemaPath, "--dangerously-bypass-hook-trust", "-c",
    `hooks.PreToolUse=[{matcher="Bash|apply_patch",hooks=[{type="command",command=${JSON.stringify(hookCommand)}}]}]`];
  configArgs.push("-c", `sandbox_workspace_write.network_access=${record.guard_policy?.networkAccess === true}`);
  const sandboxWritableRoots = [...new Set([...externalBefore.map((file) => dirname(file.path)), ...cacheRoots(), ...(record.guard_policy?.writableRoots ?? [])])];
  if (sandboxWritableRoots.length) configArgs.push("-c", `sandbox_workspace_write.writable_roots=${JSON.stringify(sandboxWritableRoots)}`);
  // Insert before the prompt/session positional arguments for exec/resume.
  const guardedArgs = [...args.slice(0, -1), ...configArgs, args.at(-1)];
  prompt = `${buildGuardPreamble(guardPolicy)}\n\n${prompt}`;

  const { child, spawnError } = await spawnAndAwaitStart(target, guardedArgs, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1", CODEX_SUPERVISOR_TASK_ID: record.id,
      CODEX_SUPERVISOR_RUN: String((record.run_count ?? 0) + 1), CODEX_SUPERVISOR_GUARD_POLICY: JSON.stringify(guardPolicy) },
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
  const persist = (next) => {
    live = next;
    const snapshot = live;
    writeChain = writeChain
      .then(() => upsertTask(snapshot))
      .catch((error) => {
        process.stderr.write(`[codex-supervisor] persist failed for ${snapshot.id}: ${error.message}\n`);
      });
    return writeChain;
  };
  await persist(live);

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
  const handleLine = async (line) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      logStream.write(`${JSON.stringify({ type: "supervisor.parse_error", line, error: error.message })}\n`);
      return;
    }
    logStream.write(`${JSON.stringify(event)}\n`);
    if (event.type === "item.completed" && event.item?.type === "agent_message") rawReport = event.item.text;
    if (["turn.completed", "turn.failed"].includes(event.type)) terminalEvent = true;
    await appendTaskEvent(record.id, event);
    await persist(applyCodexEvent(live, event));
  };

  let stdoutRest = "";
  child.stdout.on("data", (chunk) => {
    const split = splitLines(stdoutRest, chunk.toString("utf8"));
    stdoutRest = split.rest;
    for (const line of split.lines) {
      if (!line.trim()) continue;
      eventChain = eventChain.then(() => handleLine(line)).catch((error) => {
        process.stderr.write(`[codex-supervisor] event handling failed for ${record.id}: ${error.message}\n`);
      });
    }
  });
  child.stdout.on("error", () => {});

  let stderr = "";
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

  child.on("close", async (code, signal) => {
    if (quotaWatch) clearInterval(quotaWatch);
    processes.delete(record.id);
    if (stdoutRest.trim()) eventChain = eventChain.then(() => handleLine(stdoutRest)).catch((error) => {
      process.stderr.write(`[codex-supervisor] final event failed for ${record.id}: ${error.message}\n`);
    });
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
    if (status === "failed" && !next.error) {
      next.error = `codex exited with code ${code}${signal ? ` (signal ${signal})` : ""}`;
    }
    if (status === "lost" && !next.error) {
      next.error = signal ? `codex worker was killed by signal ${signal} before writing a terminal event` : "Codex worker exited without recording a terminal event";
    }
    if (status === "cancelled") next.error = null;
    if (quotaReason) { next.attention_reason = quotaReason; next.error = `Supervisor time quota exceeded: ${quotaReason}; inspect partial work before changing the budget`; }
    const outputAfter = snapshotTaskOutput(live);
    let externalChanges = [];
    try { externalChanges = compareExternalOutputs(externalBefore, await captureExternalOutputs(record.guard_policy?.externalOutputs ?? [])); }
    catch (error) { next.attention_reason = "external_output_unverified"; next.error = error.message; }
    next.run_evidence = {
      run: live.run_count, commands_run: live.commands.length,
      structured_report: parseWorkerReport(rawReport),
      output_before: outputBefore, output_after: outputAfter,
      output_changed: outputBefore && outputAfter ? outputBefore !== outputAfter : null
    };
    next.run_evidence.external_outputs = externalChanges;
    if (externalChanges.some((entry) => entry.changed)) next.run_evidence.output_changed = true;
    next.changed_files = [...new Set([...next.changed_files, ...externalChanges.filter((entry) => entry.changed).map((entry) => entry.path)])];
    if (status === "completed" && code === 0 && live.sandbox !== "read-only"
      && !next.run_evidence.output_changed && next.run_evidence.output_changed !== null
      && live.commands.length === 0) next.attention_reason = "no_work";
    if (status === "completed" && !next.run_evidence.structured_report.valid) {
      next.status = "failed";
      next.attention_reason = "invalid_report";
      next.error = `Invalid final worker report: ${next.run_evidence.structured_report.error}`;
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
      await appendTaskEvent(record.id, event).catch(() => {});
      await appendFile(logPath, `${JSON.stringify(event)}\n`).catch(() => {});
      const failing = results.checks.find((check) => check.passed === false || check.exit_code !== 0 || check.timed_out);
      await persist({
        ...next,
        acceptance_results: results,
        current_action: results.status === "passed"
          ? "Completed, acceptance passed"
          : results.status === "failed"
            ? `Acceptance failed: ${failing ? `${failing.command.slice(0, 80)} exit ${failing.error ?? (failing.baseline?.passed === false ? "baseline/evidence mismatch" : failing.timed_out ? "timeout" : failing.exit_code ?? "?")}` : results.error ?? "see acceptance_results"}`
            : next.current_action,
        updated_at: new Date().toISOString()
      });
    } else {
      await persist(acceptance ? { ...next, acceptance_results: null } : next);
    }
    cancelledTasks.delete(record.id);
  });

  try {
    child.stdin.end(prompt);
  } catch (error) {
    await persist({
      ...live,
      error: live.error ?? `stdin write failed: ${error.message}`,
      updated_at: new Date().toISOString()
    });
  }

  return { ok: true, record: live, child };
}

// The MCP client may disappear at any point. A detached process owns the
// streams, exit write and acceptance until all three settle; IPC is only a
// startup handshake and never the channel carrying worker results.
async function startTrackedRun(job) {
  const session = job.record.session_id ? await getSession(job.record.session_id) : null;
  if (session) job.prompt = `Current session objective (revision ${session.policy_revision}): ${session.objective ?? "not specified"}. Follow this latest scope; do not revive earlier session requirements. Approval state: ${session.approval_state}.\n\n${job.prompt}`;
  const peers = job.record.session_id ? (await readTasksBySession(job.record.session_id)).filter((task) => task.id !== job.record.id) : [];
  const handoff = await buildHandoff({ goal: job.record.goal_objective, todo: job.record.title,
    peers, contracts: job.record.input_context?.contracts ?? [], context: job.record.input_context?.context ?? [] });
  job.record = { ...job.record, input_context: { ...job.record.input_context, context: handoff.source_refs, source_refs: handoff.source_refs } };
  job.prompt = `${handoff.text}\n\n${job.prompt}\n\nRequired input refs (read-only): ${JSON.stringify(handoff.source_refs)}\nRequired contracts: ${JSON.stringify(job.record.input_context.contracts ?? [])}`;
  const host = spawn(process.execPath, [fileURLToPath(import.meta.url), "--run-host"], {
    detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: process.env, windowsHide: true
  });
  const started = await new Promise((resolveStart) => {
    const finish = (result) => {
      clearTimeout(timer);
      host.removeAllListeners("message");
      host.removeAllListeners("exit");
      if (host.connected) host.disconnect();
      host.unref();
      resolveStart(result);
    };
    const timer = setTimeout(() => {
      host.kill();
      finish(failedStart(job.record, "run host startup timed out"));
    }, 30000);
    host.once("message", finish);
    host.once("error", (error) => finish(failedStart(job.record, `run host startup failed: ${error.message}`)));
    host.once("exit", (code) => finish(failedStart(job.record, `run host exited before startup: ${code}`)));
    host.send(job, (error) => {
      if (error) finish(failedStart(job.record, `run host IPC failed: ${error.message}`));
    });
  });
  if (!started.ok) await upsertTask(started.record);
  return started;
}

function buildExecArgs({ cwd, sandbox, model, reasoningEffort, skipGitRepoCheck }) {
  const args = ["exec", "--json", "--cd", cwd, "--sandbox", sandbox];
  if (skipGitRepoCheck) args.push("--skip-git-repo-check");
  if (model) args.push("--model", model);
  args.push("-c", `model_reasoning_effort="${reasoningEffort}"`);
  args.push("-");
  return args;
}

function validateGoal(goal) {
  if (!goal || typeof goal !== "object" || typeof goal.objective !== "string" || goal.objective.trim() === "") {
    throw new Error("goal.objective is required");
  }
  const tokenBudget = goal.tokenBudget ?? goal.token_budget ?? null;
  if (tokenBudget !== null && (!Number.isInteger(tokenBudget) || tokenBudget <= 0)) {
    throw new Error("goal.tokenBudget must be a positive integer when provided");
  }
  return { objective: goal.objective, tokenBudget };
}

function dependencyError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function containsCommit(cwd, ancestor, descendant) {
  try {
    execFileSync(defaultGitBin, ["-C", cwd, "merge-base", "--is-ancestor", ancestor, descendant], {
      stdio: "ignore",
      timeout: 15000
    });
    return true;
  } catch {
    return false;
  }
}

async function validateDependencies(dependsOn, projectRoot, baseCommit) {
  const dependencyIds = [...new Set(dependsOn ?? [])];
  for (const dependencyId of dependencyIds) {
    const dependency = await getTask(dependencyId);
    if (!dependency) {
      throw dependencyError("dependency_not_found", `dependency ${dependencyId} does not exist`, { dependency_id: dependencyId });
    }
    if (resolve(dependency.project_root) !== resolve(projectRoot)) {
      throw dependencyError("dependency_project_mismatch", `dependency ${dependencyId} belongs to a different project root`, {
        dependency_id: dependencyId,
        dependency_project_root: dependency.project_root,
        project_root: projectRoot
      });
    }
    if (dependency.status !== "completed" || dependency.exit_code !== 0 || dependency.attention_reason) {
      throw dependencyError("dependency_not_ready", `dependency ${dependencyId} is not successfully settled`, {
        dependency_id: dependencyId,
        status: dependency.status,
        exit_code: dependency.exit_code ?? null,
        attention_reason: dependency.attention_reason ?? null
      });
    }
    if (Array.isArray(dependency.acceptance) && dependency.acceptance.length > 0 && dependency.acceptance_results?.passed !== true) {
      throw dependencyError("dependency_not_ready", `dependency ${dependencyId} has not passed acceptance`, {
        dependency_id: dependencyId,
        acceptance: dependency.acceptance_results?.status ?? null
      });
    }
    if (!dependency.landed_at || !dependency.landed_head) {
      throw dependencyError("dependency_not_landed", `dependency ${dependencyId} must be landed before a dependent worker starts`, {
        dependency_id: dependencyId,
        landed_at: dependency.landed_at ?? null
      });
    }
    if (!baseCommit || !containsCommit(projectRoot, dependency.landed_head, baseCommit)) {
      throw dependencyError("dependency_base_mismatch", `worker base does not contain landed dependency ${dependencyId}; use the integrated branch or a newer baseRef`, {
        dependency_id: dependencyId,
        dependency_head: dependency.landed_head,
        base_commit: baseCommit ?? null
      });
    }
  }
}

export async function createCodexWorker({
  title,
  task,
  sessionId = null,
  sessionTitle = null,
  sessionNote = null,
  cwd,
  sandbox = "workspace-write",
  model = null,
  reasoningEffort = "high",
  skipGitRepoCheck = true,
  ownedPaths,
  goal,
  dependsOn = [],
  followupOf = null,
  useWorktree = true,
  baseRef = null,
  preflightId = null,
  preflight = null,
  acceptance = null,
  acceptanceTimeoutMs = null,
  forbid = [],
  allowedCommands = [],
  context = [],
  contracts = [],
  externalOutputs = [],
  networkAccess = false,
  writableRoots = [],
  maxRunMs = null,
  maxTotalMs = null
}) {
  if (!task || typeof task !== "string") throw new Error("task is required");
  const acceptanceCommands = normalizeAcceptance(acceptance);
  if (!cwd || typeof cwd !== "string") throw new Error("cwd is required");
  if (!allowedReasoningEfforts.has(reasoningEffort)) {
    throw new Error(`unsupported reasoningEffort: ${reasoningEffort}`);
  }
  if (!Array.isArray(ownedPaths)) {
    throw new Error("ownedPaths is required; pass an empty list only for a worker that must never land a change (a read-only verifier, or a research worker that reads and reports)");
  }
  if (ownedPaths.length > 0 && acceptanceCommands?.length && acceptanceCommands.every(isArtifactOnlyAcceptance)) {
    throw new Error("a write worker cannot use only file-existence acceptance; add a real test, endpoint probe or structured execution evidence");
  }
  const validatedGoal = validateGoal(goal);
  await buildHandoff({ context, contracts });
  await captureExternalOutputs(externalOutputs, { checkBaseline: true });
  if (externalOutputs.length && !acceptanceCommands?.length) throw new Error("shared outputs require explicit acceptance commands");
  if (externalOutputs.length && sandbox === "read-only") throw new Error("a read-only worker cannot declare writable shared outputs");
  if (networkAccess && sandbox === "danger-full-access") throw new Error("networkAccess is only for the sandboxed workers");
  if (networkAccess && sandbox === "read-only") throw new Error("the read-only sandbox has no network (a fetch there fails on DNS even with network_access); for a worker that must fetch, use sandbox \"workspace-write\" with networkAccess: true and ownedPaths: []");
  if (!Array.isArray(writableRoots) || writableRoots.length > 20 || writableRoots.some((root) => typeof root !== "string" || !isAbsolute(root))) {
    throw new Error("writableRoots must be a list of at most 20 absolute paths");
  }
  if (writableRoots.length && sandbox !== "workspace-write") throw new Error("writableRoots is only configurable for workspace-write workers");
  // Codex refuses a writable root with a symlink component and then fails every
  // command in the worker, so a declared root is stored resolved. Passing the
  // alias would look fine in the receipt and break the run.
  const resolvedWritableRoots = [];
  for (const root of writableRoots) {
    const resolved = resolveWritableRoot(root);
    if (resolved.error) throw new Error(`writableRoots entry is unusable: ${root} (${resolved.error}); pass an existing directory whose path has no symlink component`);
    resolvedWritableRoots.push(resolved.path);
  }
  for (const value of [maxRunMs, maxTotalMs]) if (value !== null && (!Number.isInteger(value) || value < 1000)) throw new Error("time limits must be integer milliseconds of at least 1000");
  for (const [name, values] of Object.entries({ forbid, allowedCommands })) {
    if (!Array.isArray(values) || values.length > 100 || values.some((value) => typeof value !== "string" || !value.trim())) throw new Error(`${name} must be a list of at most 100 nonempty strings`);
  }

  const projectRoot = cwd;
  const normalizedOwnedPaths = normalizeOwnedPaths([...ownedPaths, ...externalOutputs.map((entry) => entry.path)], projectRoot);
  const conflicts = await findOwnershipConflicts(normalizedOwnedPaths);
  if (conflicts.length > 0) throw ownershipConflictError(conflicts);

  if (sessionId && (sessionTitle || sessionNote)) {
    await upsertSession({ id: sessionId, title: sessionTitle, note: sessionNote });
  }

  const session = sessionId ? await getSession(sessionId) : null;
  if (session?.approval_state === "waiting_user") {
    const error = new Error("session is waiting for user approval; do not dispatch or auto-resume");
    error.code = "session_waiting_user";
    throw error;
  }
  const combinedAcceptance = normalizeAcceptance([...(session?.default_acceptance ?? []), ...(acceptanceCommands ?? [])]);

  const id = `codex-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const worktree = useWorktree
    ? await ensureWorktree(projectRoot, id, baseRef)
    : { path: null, baseCommit: null };
  const worktreePath = worktree.path;
  const effectiveCwd = worktreePath ?? projectRoot;
  if (preflight && (!Array.isArray(preflight.probeCommands) || preflight.probeCommands.length === 0
    || preflight.probeCommands.some((command) => typeof command !== "string" || !command.trim()))) {
    throw new Error("preflight.probeCommands must be a nonempty list of shell commands");
  }
  const guardPolicy = {
    forbid,
    allowedCommands,
    externalOutputs,
    networkAccess,
    writableRoots: [...new Set(resolvedWritableRoots)],
    maxRunMs,
    maxTotalMs
  };
  const runtimeContract = buildRuntimeContract({
    projectRoot,
    baseCommit: worktree.baseCommit,
    sandbox,
    ownedPaths: normalizedOwnedPaths,
    allowedCommands,
    networkAccess,
    writableRoots: guardPolicy.writableRoots,
    context,
    contracts
  });
  const preflightMetadata = preflight
    ? createPreflightMetadata(runtimeContract, preflight.probeCommands)
    : null;

  const record = {
    id,
    title: title || task.split("\n").find(Boolean)?.slice(0, 80) || "Codex worker",
    worker: "codex",
    status: "queued",
    phase: null,
    cwd: effectiveCwd,
    project_root: projectRoot,
    sandbox,
    model,
    reasoning_effort: reasoningEffort,
    skip_git_repo_check: skipGitRepoCheck,
    followup_of: followupOf,
    resumed_from: null,
    session_id: sessionId ?? null,
    thread_id: null,
    owned_paths: normalizedOwnedPaths,
    guard_policy: {
      ...guardPolicy,
      ...(preflightMetadata ? { preflight: preflightMetadata } : {}),
      ...(preflightId ? { preflight_source_id: preflightId } : {})
    },
    input_context: { context, contracts },
    depends_on: Array.isArray(dependsOn) ? dependsOn : [],
    goal_objective: validatedGoal.objective,
    goal_token_budget: validatedGoal.tokenBudget,
    goal_status: null,
    goal_tokens_used: null,
    goal_time_used_seconds: null,
    goal_updated_at: null,
    run_count: 0,
    worktree_path: worktreePath,
    base_commit: worktree.baseCommit,
    acceptance: combinedAcceptance,
    acceptance_local: acceptanceCommands,
    session_policy_revision: session?.policy_revision ?? null,
    acceptance_timeout_ms: combinedAcceptance ? (acceptanceTimeoutMs ?? DEFAULT_ACCEPTANCE_TIMEOUT_MS) : null,
    acceptance_results: null,
    prompt: task,
    changed_files: [],
    commands: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    run_log: taskRunPath(id)
  };
  try {
    await validateDependencies(dependsOn, projectRoot, worktree.baseCommit);
    if (preflightId) {
      const preflightTask = await getTask(preflightId);
      const preflightResult = readPreflightResult(preflightTask);
      if (preflightResult.status !== "passed") {
        const error = new Error(`preflight ${preflightId} is ${preflightResult.status}; wait for its probes to pass before dispatching this worker`);
        error.code = "preflight_not_passed";
        error.details = preflightResult;
        throw error;
      }
      const contractHash = runtimeContractHash(runtimeContract);
      if (preflightResult.contract_hash !== contractHash) {
        const error = new Error(`preflight ${preflightId} does not match this worker's runtime contract; create a new preflight after changing baseRef, sandbox, ownedPaths, commands, context, contracts, network or writable roots`);
        error.code = "preflight_mismatch";
        error.details = { preflight_id: preflightId, expected_contract_hash: contractHash, actual_contract_hash: preflightResult.contract_hash };
        throw error;
      }
    }
    await reserveTaskOwnership(record);
  }
  catch (error) {
    if (worktreePath) {
      // This checkout belongs to this not-yet-started dispatch and contains
      // no model edits. Remove it normally; never force-remove user work.
      await runCommand(defaultGitBin,["-C",projectRoot,"worktree","remove",worktreePath]).catch(()=>{});
      await runCommand(defaultGitBin,["-C",projectRoot,"branch","-D",`codex/${id}`]).catch(()=>{});
    }
    throw error;
  }

  const args = buildExecArgs({ cwd: effectiveCwd, sandbox, model, reasoningEffort, skipGitRepoCheck });

  const started = await startTrackedRun({
    record,
    args,
    prompt: frameWorkerPrompt(task, {
      objective: validatedGoal.objective,
      tokenBudget: validatedGoal.tokenBudget
    }, { acceptance: combinedAcceptance }),
    logPath: record.run_log
  });
  return started.record;
}

// Continue the *same* Codex session. The worktree, thread id, ownership and
// goal are all inherited from the original task, and the row is reused so one
// logical piece of work stays one row.
//
// `rebaseOnto` names a ref, resolved in the project directory (HEAD, main, a
// sha): the worktree is moved onto it first so the worker continues on
// current code, and base_commit is recorded before the worker starts so a
// spawn failure cannot leave the row describing the old base. A rebase that
// does not go through puts the worktree back and throws with the file list;
// the worker is not started. Refused while the worker is still running.
export async function resumeCodexWorker({ taskId, prompt, rebaseOnto = null, acceptance = undefined, context = undefined }) {
  if (!prompt || typeof prompt !== "string") throw new Error("prompt is required");
  let task = await getTask(taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);
  if (task.guard_policy?.maxTotalMs && Date.now() - Date.parse(task.created_at) >= task.guard_policy.maxTotalMs) {
    const error = new Error("total time quota exceeded; inspect partial work and explicitly dispatch a revised budget");error.code="time_quota_exceeded";throw error;
  }
  if (context !== undefined) {
    await buildHandoff({ context });
    task = { ...task, input_context: { ...task.input_context, context } };
  }
  const claim = await claimTaskRun(taskId, task.run_count ?? 0);
  if (!claim) {
    const error = new Error(`task ${taskId} is active or already claimed by another dispatcher; wait for it to settle`);
    error.code = "worker_active";
    throw error;
  }
  try {
  const session = task.session_id ? await getSession(task.session_id) : null;
  if (session?.approval_state === "waiting_user") {
    const error = new Error("session is waiting for user approval; do not resume");
    error.code = "session_waiting_user";
    throw error;
  }
  const localAcceptance = acceptance === undefined ? (task.session_policy_revision == null ? task.acceptance : task.acceptance_local) : normalizeAcceptance(acceptance);
  // `acceptance` replaces the stored commands when given; an empty list
  // clears them. Left out, the stored commands stay.
  if (acceptance !== undefined || session) {
    const commands = normalizeAcceptance([...(session?.default_acceptance ?? []), ...(localAcceptance ?? [])]);
    task = {
      ...task,
      acceptance: commands,
      acceptance_local: localAcceptance,
      session_policy_revision: session?.policy_revision ?? null,
      acceptance_timeout_ms: commands ? (task.acceptance_timeout_ms ?? DEFAULT_ACCEPTANCE_TIMEOUT_MS) : null,
      updated_at: new Date().toISOString()
    };
    await upsertTask(task);
  }
  if (!task.thread_id) {
    throw new Error(
      `task ${taskId} has no Codex thread_id recorded. Only workers created by this version of codex-supervisor-mcp can be resumed; use create_codex_followup_worker otherwise.`
    );
  }
  let rebase = null;
  if (rebaseOnto) {
    if (ACTIVE_STATUSES.has(task.status) || processes.has(task.id)) {
      const error = new Error(`task ${taskId} is still ${task.status}; wait for it to settle (or cancel it) before rebasing its worktree`);
      error.code = "worker_active";
      throw error;
    }
    if (!task.worktree_path) {
      const error = new Error(`task ${taskId} ran in place and has no worktree to rebase`);
      error.code = "no_worktree";
      throw error;
    }
    let ontoCommit;
    try {
      ontoCommit = resolveCommit(task.project_root, rebaseOnto);
    } catch {
      const error = new Error(`rebaseOnto "${rebaseOnto}" does not resolve to a commit in ${task.project_root}`);
      error.code = "invalid_rebase_onto";
      throw error;
    }
    rebase = rebaseWorktree(task, ontoCommit);
    if (rebase.error) {
      const error = new Error(rebase.reason);
      error.code = rebase.error;
      error.details = rebase;
      throw error;
    }
    if (!rebase.noop && rebase.base_commit !== task.base_commit) {
      task = { ...task, base_commit: rebase.base_commit, updated_at: new Date().toISOString() };
      await upsertTask(task);
    }
  }

  const cwd = (await exists(task.cwd)) ? task.cwd : task.project_root;
  const args = ["exec", "resume", "--json"];
  args.push("-c", `sandbox_mode="${task.sandbox}"`);
  if (task.model) args.push("--model", task.model);
  args.push("-c", `model_reasoning_effort="${task.reasoning_effort ?? "high"}"`);
  if (task.skip_git_repo_check) args.push("--skip-git-repo-check");
  args.push(task.thread_id);
  args.push("-");

  const started = await startTrackedRun({
    record: { ...task, resumed_from: task.resumed_from ?? task.id },
    args,
    prompt: frameWorkerPrompt(prompt, {
      objective: task.goal_objective ?? task.title ?? task.id,
      resume: true
    }, { acceptance: task.acceptance }),
    logPath: task.run_log,
    spawnOptions: { cwd }
  });
  return rebase ? { ...started.record, rebase } : started.record;
  } finally { await releaseTaskRun(taskId, claim); }
}

export async function recoverEligibleRuns() {
  const recovered = [];
  for (const task of await readTasks()) {
    if ((task.run_count ?? 0) !== 1 || !task.thread_id
      || !(task.run_evidence?.run === 1 || (task.run_host_pid && task.started_at)) || !task.guard_policy
      || !(task.status === "lost" || task.attention_reason === "no_work" || task.attention_reason === "invalid_report")
      || ["blocked", "paused", "budget_limited", "usage_limited"].includes(task.goal_status)
      || /401|403|unauthori[sz]ed|not logged|permission denied|approval|rate.?limit|429/i.test(task.error ?? "")
      || /time_limit|quota/.test(`${task.attention_reason ?? ""} ${task.error ?? ""}`)
      || await isPidAlive(task.pid) || await isPidAlive(task.run_host_pid)) continue;
    const session = task.session_id ? await getSession(task.session_id) : null;
    if (session?.approval_state === "waiting_user") continue;
    try {
      const result = await resumeCodexWorker({ taskId: task.id,
        prompt: task.attention_reason === "invalid_report"
          ? "Your run finished, but the final message was not the required bare JSON report. Do not redo the work and do not edit files: reply with ONLY the JSON object with result (string), verification (string[]) and not_done (string[]), describing what you already did. No code fences, nothing before or after it."
          : `One automatic recovery after ${task.attention_reason ?? task.status}. Original task: ${task.prompt}\nContinue from files already present; do not repeat completed edits. Make concrete progress, run declared checks, and report remaining blockers accurately. This is the only automatic retry.` });
      const event = { type: "supervisor.recovery", automatic: true, from_run: 1, to_run: result.run_count,
        reason: task.attention_reason ?? task.status, started_at: new Date().toISOString() };
      await appendTaskEvent(task.id, event);
      await appendFile(task.run_log, `${JSON.stringify(event)}\n`);
      recovered.push({ id: task.id, run: result.run_count, reason: event.reason });
    } catch (error) {
      if (!["worker_active", "session_waiting_user"].includes(error.code)) {
        await appendTaskEvent(task.id, { type: "supervisor.recovery_refused", reason: error.code ?? "resume_failed" });
      }
    }
  }
  return recovered;
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === "--run-host") {
  process.once("message", async (job) => {
    let result;
    try {
      result = await trackRunInHost(job);
      if (!result.ok) await upsertTask(result.record);
    } catch (error) {
      result = failedStart(job.record, `run host failed: ${error.message}`);
      await upsertTask(result.record);
    }
    if (process.connected) process.send({ ok: result.ok, record: result.record }, () => {
      if (process.connected) process.disconnect();
    });
  });
}

// `powershell` by name is not always on PATH for a process a GUI client
// started, so prefer the copy that ships with Windows. Only the CIM path needs
// it; the rest of this file shells out to nothing but taskkill and git.
function powershellBin() {
  const root = process.env.SystemRoot?.trim() || "C:\\Windows";
  const full = join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return existsSync(full) ? full : "powershell";
}

// A pid recorded on disk is only signalled once it is confirmed to still be a
// Codex worker, so a recycled pid belonging to an unrelated process is never
// killed. Windows has no `ps`: CIM is the only reliable source for a full command
// line, and the full line matters because the npm shim is bypassed by running
// `node <entry>`, which puts the word "codex" in the arguments, not the image
// name. `tasklist` is the fallback when PowerShell is unavailable - it only
// reports the image name, so it can confirm a native codex.exe but never a
// `node <entry>` worker.
//
// The timeout is generous on purpose: this runs once per cross-process cancel,
// and a cold Windows PowerShell on a fresh machine routinely takes several
// seconds to print anything. A tight timeout here silently degrades to the
// useless tasklist probe, and the cancel comes back "process_not_found".
function describeProcess(pid) {
  const options = { encoding: "utf8", timeout: 15000, windowsHide: true };
  try {
    if (process.platform === "win32") {
      try {
        const viaCim = execFileSync(
          powershellBin(),
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`
          ],
          options
        ).trim();
        if (viaCim) return viaCim;
      } catch {
        // fall through to the image-name probe below
      }
      return execFileSync("tasklist", ["/FI", `PID eq ${Number(pid)}`, "/FO", "CSV", "/NH"], options).trim();
    }
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], options).trim();
  } catch {
    return "";
  }
}

function isLikelyCodexProcess(pid) {
  const description = describeProcess(pid);
  return description.includes("codex");
}

// Ends a worker and, on Windows, its whole process tree: the direct child there
// is the JS wrapper around the native Codex binary, so terminating it alone
// would leave the real CLI running and the task stuck in `running`.
function terminateChild(child) {
  if (process.platform === "win32" && child.pid) {
    try {
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        timeout: 5000,
        windowsHide: true
      });
      return;
    } catch {
      // fall back to the handle-based kill below
    }
  }
  child.kill("SIGTERM");
}

function terminatePid(pid) {
  if (process.platform === "win32") {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      timeout: 5000,
      windowsHide: true
    });
    return;
  }
  process.kill(pid, "SIGTERM");
}

export async function cancelCodexWorker(taskId) {
  const acceptance = acceptanceRuns.get(taskId);
  if (acceptance) {
    acceptance.cancelled = true;
    acceptance.kill?.();
    return { cancelled: true, via: "acceptance", pid: null };
  }
  const child = processes.get(taskId);
  if (child) {
    cancelledTasks.add(taskId);
    terminateChild(child);
    return { cancelled: true, via: "process_handle", pid: child.pid ?? null };
  }
  // Another MCP process owns the handle; fall back to the pid recorded on disk.
  const task = await getTask(taskId);
  if (task?.acceptance_results?.status === "running" && await isPidAlive(task.acceptance_results.supervisor_pid)) {
    await upsertTask({ ...task, cancel_requested_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    return { cancelled: true, via: "acceptance", pid: null };
  }
  if (task?.pid && (await isPidAlive(task.pid)) && isLikelyCodexProcess(task.pid)) {
    try {
      terminatePid(task.pid);
      return { cancelled: true, via: "pid", pid: task.pid };
    } catch (error) {
      return { cancelled: false, reason: "kill_failed", message: error.message, pid: task.pid };
    }
  }
  return { cancelled: false, reason: "process_not_found" };
}

async function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function createFollowupWorker({
  taskId,
  followupPrompt,
  sessionId = null,
  sessionTitle = null,
  sessionNote = null,
  title,
  cwd,
  sandbox,
  model,
  reasoningEffort,
  ownedPaths,
  goal,
  baseRef,
  acceptance,
  acceptanceTimeoutMs,
  forbid,
  allowedCommands,
  context,
  contracts,
  externalOutputs,
  networkAccess,
  writableRoots,
  maxRunMs,
  maxTotalMs
}) {
  const parent = await getTask(taskId);
  if (!parent) throw new Error(`task not found: ${taskId}`);
  const recentEvents = await readTaskEvents(taskId, 20);
  const prompt = [
    "You are continuing a previous Codex worker run.",
    "",
    `Parent task ID: ${parent.id}`,
    `Parent status: ${parent.status}`,
    `Parent title: ${parent.title}`,
    "",
    "Parent prompt:",
    parent.prompt,
    "",
    "Parent recent summary:",
    `- current_action: ${parent.current_action ?? "-"}`,
    `- current_command: ${parent.current_command ?? "-"}`,
    `- changed_files: ${(parent.changed_files ?? []).join(", ") || "-"}`,
    `- last_message: ${parent.last_message ?? "-"}`,
    "",
    "Parent recent events:",
    ...recentEvents.map((event) => `- ${JSON.stringify(event)}`),
    "",
    "Follow-up instruction:",
    followupPrompt
  ].join("\n");

  return createCodexWorker({
    title: title ?? `Follow-up for ${parent.id}`,
    task: prompt,
    sessionId: sessionId ?? parent.session_id ?? null,
    sessionTitle,
    sessionNote,
    cwd: cwd ?? parent.project_root ?? parent.cwd,
    sandbox: sandbox ?? parent.sandbox,
    model: model ?? parent.model,
    reasoningEffort: reasoningEffort ?? parent.reasoning_effort ?? "high",
    skipGitRepoCheck: parent.skip_git_repo_check,
    ownedPaths: ownedPaths ?? parent.owned_paths,
    forbid: forbid ?? parent.guard_policy?.forbid ?? [],
    allowedCommands: allowedCommands ?? parent.guard_policy?.allowedCommands ?? [],
    context: context ?? parent.input_context?.context ?? [],
    contracts: contracts ?? parent.input_context?.contracts ?? [],
    externalOutputs: externalOutputs ?? parent.guard_policy?.externalOutputs ?? [],
    networkAccess: networkAccess ?? parent.guard_policy?.networkAccess ?? false,
    writableRoots: writableRoots ?? parent.guard_policy?.writableRoots ?? [],
    maxRunMs: maxRunMs ?? parent.guard_policy?.maxRunMs ?? null,
    maxTotalMs: maxTotalMs ?? parent.guard_policy?.maxTotalMs ?? null,
    goal: goal ?? { objective: parent.goal_objective ?? `Follow-up for ${parent.id}`, tokenBudget: parent.goal_token_budget ?? undefined },
    dependsOn: [],
    followupOf: parent.id,
    useWorktree: true,
    baseRef: baseRef ?? null,
    // Inherited unless given; the follow-up runs in a fresh worktree cut
    // from the project HEAD, so the parent's checks only pass there once
    // the parent's work has landed.
    acceptance: acceptance === undefined ? (parent.session_policy_revision == null ? parent.acceptance : parent.acceptance_local) : acceptance,
    acceptanceTimeoutMs: acceptanceTimeoutMs ?? parent.acceptance_timeout_ms ?? null
  });
}
