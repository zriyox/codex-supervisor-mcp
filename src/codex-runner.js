import { createWriteStream, existsSync } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { join, resolve, sep } from "node:path";
import {
  appendTaskEvent,
  getTask,
  readActiveTasks,
  readTaskEvents,
  taskRunPath,
  upsertSession,
  upsertTask
} from "./task-store.js";
import { applyCodexEvent } from "./event-parser.js";
import { TERMINAL_STATUSES } from "./status.js";
import { worktreesDir } from "./paths.js";
import { withGoalPreamble } from "./prompt.js";
import { readTaskChanges } from "./worktree.js";
import { defaultBinDirs, findBinaryPath, resolveCommand, shimMessage } from "./bin-resolver.js";

const processes = new Map();
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
    if (baseRef) throw error;
    return { path: null, baseCommit: null };
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
async function startTrackedRun({ record, args, prompt, logPath, spawnOptions = {} }) {
  const target = codexTarget();
  if (target.error) return failedStart(record, target.error);

  const { child, spawnError } = await spawnAndAwaitStart(target, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1" },
    windowsHide: true,
    ...spawnOptions
  });

  if (spawnError) {
    return failedStart(record, `failed to spawn ${target.cmd}: ${spawnError.message}`);
  }

  const now = new Date().toISOString();
  let live = {
    ...record,
    status: "running",
    phase: "starting",
    pid: child.pid ?? null,
    started_at: now,
    completed_at: null,
    exit_code: null,
    signal: null,
    run_count: (record.run_count ?? 0) + 1,
    updated_at: now
  };
  processes.set(record.id, child);

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
  const handleLine = async (line) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      logStream.write(`${JSON.stringify({ type: "supervisor.parse_error", line, error: error.message })}\n`);
      return;
    }
    logStream.write(`${JSON.stringify(event)}\n`);
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

  child.on("exit", async (code, signal) => {
    processes.delete(record.id);
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
    else if (TERMINAL_STATUSES.has(live.status) && live.status !== "failed") status = live.status;
    else if (cancelRequested) status = "cancelled";
    // Killed by a signal nobody asked for: the worker did not fail, it
    // vanished. Re-running is the fix, so it is reported as lost.
    else if (signal) status = "lost";
    else if (code === 0) status = "completed";
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
      next.error = `codex worker was killed by signal ${signal} before writing a terminal event`;
    }
    if (status === "cancelled") next.error = null;
    await persist(next);
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
  baseRef = null
}) {
  if (!task || typeof task !== "string") throw new Error("task is required");
  if (!cwd || typeof cwd !== "string") throw new Error("cwd is required");
  if (!allowedReasoningEfforts.has(reasoningEffort)) {
    throw new Error(`unsupported reasoningEffort: ${reasoningEffort}`);
  }
  if (!Array.isArray(ownedPaths) || ownedPaths.length === 0) {
    throw new Error("ownedPaths is required and must list at least one path this worker is allowed to write");
  }
  const validatedGoal = validateGoal(goal);

  const projectRoot = cwd;
  const normalizedOwnedPaths = normalizeOwnedPaths(ownedPaths, projectRoot);
  const conflicts = await findOwnershipConflicts(normalizedOwnedPaths);
  if (conflicts.length > 0) throw ownershipConflictError(conflicts);

  if (sessionId && (sessionTitle || sessionNote)) {
    await upsertSession({ id: sessionId, title: sessionTitle, note: sessionNote });
  }

  const id = `codex-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const worktree = useWorktree
    ? await ensureWorktree(projectRoot, id, baseRef)
    : { path: null, baseCommit: null };
  const worktreePath = worktree.path;
  const effectiveCwd = worktreePath ?? projectRoot;

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
    prompt: task,
    changed_files: [],
    commands: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    run_log: taskRunPath(id)
  };
  await upsertTask(record);

  const args = buildExecArgs({ cwd: effectiveCwd, sandbox, model, reasoningEffort, skipGitRepoCheck });

  const started = await startTrackedRun({
    record,
    args,
    prompt: withGoalPreamble(task, {
      objective: validatedGoal.objective,
      tokenBudget: validatedGoal.tokenBudget
    }),
    logPath: record.run_log
  });
  await upsertTask(started.record);
  return started.record;
}

// Continue the *same* Codex session. The worktree, thread id, ownership and
// goal are all inherited from the original task, and the row is reused so one
// logical piece of work stays one row.
export async function resumeCodexWorker({ taskId, prompt }) {
  if (!prompt || typeof prompt !== "string") throw new Error("prompt is required");
  const task = await getTask(taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);
  if (!task.thread_id) {
    throw new Error(
      `task ${taskId} has no Codex thread_id recorded. Only workers created by this version of codex-supervisor-mcp can be resumed; use create_codex_followup_worker otherwise.`
    );
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
    prompt: withGoalPreamble(prompt, {
      objective: task.goal_objective ?? task.title ?? task.id,
      resume: true
    }),
    logPath: task.run_log,
    spawnOptions: { cwd }
  });
  await upsertTask(started.record);
  return started.record;
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
  const child = processes.get(taskId);
  if (child) {
    cancelledTasks.add(taskId);
    terminateChild(child);
    return { cancelled: true, via: "process_handle", pid: child.pid ?? null };
  }
  // Another MCP process owns the handle; fall back to the pid recorded on disk.
  const task = await getTask(taskId);
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
  baseRef
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
    goal: goal ?? { objective: parent.goal_objective ?? `Follow-up for ${parent.id}`, tokenBudget: parent.goal_token_budget ?? undefined },
    dependsOn: [parent.id],
    followupOf: parent.id,
    useWorktree: true,
    baseRef: baseRef ?? null
  });
}
