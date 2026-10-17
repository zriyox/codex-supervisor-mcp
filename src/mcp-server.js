#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  cancelCodexWorker,
  recoverEligibleRuns,
  createCodexWorker,
  createFollowupWorker,
  resumeCodexWorker
} from "./codex-runner.js";
import {
  getSession,
  getArtifact,
  getFact,
  getWorkItemForTask,
  getTask,
  getTasks,
  isPidAlive,
  listTaskEventKinds,
  listArtifactsForTask,
  listContextFacts,
  countVerifiedFacts,
  readArtifact,
  readTaskEventRecords,
  readAgentMessages,
  readTaskEvents,
  readTasks,
  readObserverCursor,
  writeObserverCursor,
  readTasksBySession,
  latestContextSnapshotForTask,
  reconcileDetachedActiveTasks,
  recordTerminalChangedFiles,
  searchTasks,
  upsertSession,
  upsertTask,
  appendTaskEvent,
  recordFact,
  recordJsonArtifact,
  runIdFor,
  updateWorkItemDelivery,
  saveCleanupPlan,
  getCleanupPlan,
  readCleanupHistory
} from "./task-store.js";
import { readNativeGoal, readNativeGoalState } from "./goal-store.js";
import { collectWorkerChanges } from "./worker-changes.js";
import { buildHostGoalSync } from "./prompt.js";
import { baseBehind, readTaskChanges, readWorktreeDiff, worktreeRef } from "./worktree.js";
import { summarizeVerification } from "./event-parser.js";
import { readPreflightResult } from "./worker-preflight.js";
import { acceptanceVerdict, runAcceptance } from "./acceptance.js";
import { ACTIVE_STATUSES, TERMINAL_STATUSES, TASK_STATUSES, isGoalNeedingAttention } from "./status.js";
import { approxTokenCount, truncateEventStrings, truncateMiddleChars, truncateReport } from "./truncate.js";
import { checkForUpdate, updateNotice } from "./update-check.js";
import { syncSkills } from "./skill-sync.js";
import { maybeAutoUpdate } from "./auto-update.js";
import { askWorker, endSideSession, latestSideTurn } from "./side-chat.js";
import { landWorker } from "./landing.js";
import { cleanupHint } from "./cleanup-hint.js";
import { applyCleanupPlan, createCleanupPlan } from "./cleanup-plan.js";
import { buildOverviewDelta } from "./overview-delta.js";

// Report the real package version. This string had drifted to 0.4.0 while the
// package shipped 0.5.x, so the handshake named a version nobody was running.
const packageVersion = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
).version;

const server = new McpServer({
  name: "codex-supervisor",
  version: packageVersion
});

// Nobody should keep running an old build without hearing about it. The
// registry is asked once at start and every six hours after; the answer
// rides along in the overview, the dispatch receipt and the wait response,
// which are the calls every orchestrating session makes.
const UPDATE_RECHECK_MS = 6 * 60 * 60 * 1000;
let updateState = null;
// The last word from auto-update.js: null until a check found a newer
// version, then started | running | done | failed | skipped.
let autoUpdateState = null;
async function refreshUpdateState({ force = false } = {}) {
  try {
    updateState = await checkForUpdate({ force });
    autoUpdateState = await maybeAutoUpdate(updateState);
    const notice = updateNotice(updateState, autoUpdateState)?.notice;
    if (notice) process.stderr.write(`[codex-supervisor] ${notice}\n`);
  } catch (error) {
    process.stderr.write(`[codex-supervisor] update check failed: ${error.message}\n`);
  }
  return updateState;
}
refreshUpdateState();
setInterval(() => refreshUpdateState({ force: true }), UPDATE_RECHECK_MS).unref();

// The skill describes this tool surface, so it moves with the server: a
// server fetched by `npx -y codex-supervisor-mcp@latest` never ran postinstall,
// and a global install only synced the skill on the day it was installed.
// Runs in the background; a client that cannot write its skill directory
// only costs a line on stderr.
if (!process.env.CODEX_SUPERVISOR_SKIP_SKILL_SYNC) {
  syncSkills()
    .then((result) => {
      const changed = [...result.installed, ...result.updated];
      if (changed.length > 0) {
        process.stderr.write(
          `[codex-supervisor] skill synced for ${changed.join(", ")}; a session that already loaded the skill keeps the old text until it loads it again\n`
        );
      }
      for (const failure of result.failed) {
        process.stderr.write(`[codex-supervisor] skill sync failed: ${failure}\n`);
      }
    })
    .catch((error) => {
      process.stderr.write(`[codex-supervisor] skill sync failed: ${error.message}\n`);
    });
}

// The short form for tool results: null when the install is current.
function updateField() {
  return updateNotice(updateState, autoUpdateState);
}

// Spread into a result: adds `update` only when there is something to say.
function withUpdate(payload) {
  const update = updateField();
  return update ? { ...payload, update } : payload;
}

const OVERVIEW_BYTE_BUDGET = 7000;
const OVERVIEW_CAP_LEVELS = [
  { title: 40, goal: 60, action: 60, path: 60 },
  { title: 28, goal: 40, action: 40, path: 40 },
  { title: 18, goal: 24, action: 24, path: 24 },
  { title: 12, goal: 16, action: 16, path: 16 },
  { title: 8, goal: 8, action: 8, path: 8 },
  { title: 0, goal: 0, action: 0, path: 0 }
];

function git(cwd, args) {
  return execFileSync(process.env.GIT_BIN?.trim() || "git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 60000,
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

// `current_action` is "Running <command>", and a command can be a heredoc that
// writes a whole file. Returning it whole put tens of thousands of characters
// into every wait response, which then blew past the client's MCP output cap
// and came back a second time as a notification. The full command stays in
// current_command / commands and is readable through get_codex_worker_events.
const ACTION_PREVIEW_CHARS = 300;
const COMMAND_PREVIEW_CHARS = 300;
const COMMAND_TAIL = 20;
const PROMPT_PREVIEW_CHARS = 300;
// The single-worker status read is the drill-in for one worker, so its copy of
// the last message stays much larger than the overview's 400. The full report
// is still get_worker_result's job.
const STATUS_MESSAGE_CHARS = 4000;

function textResult(value) {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2)
      }
    ]
  };
}

function clip(value, maxChars) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A terminal status is written in two steps. Codex's turn.completed event
// flips status to completed while the process is still alive and exit_code is
// still null; the process exit then writes exit_code. A wait that returned on
// the first step handed the caller a snapshot with exit_code: null, and the
// next read said 0 - two answers for one worker. A row counts as settled once
// the exit is recorded, or once nobody is left to record it.
function isSettled(task) {
  if (!TERMINAL_STATUSES.has(task.status)) return false;
  if (task.attention_reason === "start_failed") return true;
  if (task.status !== "completed" && task.status !== "failed") return true;
  // Acceptance is running in the supervisor process that owned the worker;
  // the codex pid is already dead, so that process is what to wait on.
  if (task.acceptance_results?.status === "running") return !isPidAlive(task.acceptance_results.supervisor_pid);
  if (["interrupted", "cancelled"].includes(task.acceptance_results?.status)) return true;
  if (task.exit_code !== null && task.exit_code !== undefined) return true;
  // A dead Codex pid does not prove that its owner's close handler finished
  // draining the stream and writing the exit status. Leave the half-written
  // row for reconciliation after a short grace period, never return it.
  return false;
}

// Codex emits nothing while a command runs and nothing while the model
// thinks, so a snapshot that has not moved for ten minutes looks the same
// either way. These three fields tell them apart: current_command is set
// from the command's item.started until its item.completed, so a long idle
// with a command is a long command, and a long idle without one is the model
// (or a stuck process, which reconcile turns into lost on its own).
const LIVE_COMMAND_PREVIEW_CHARS = 120;
function liveness(task) {
  if (!ACTIVE_STATUSES.has(task.status)) {
    return { idle_seconds: null, command_running: false, current_command: null };
  }
  const since = Date.parse(task.last_event_at ?? task.started_at ?? "");
  const idle = Number.isFinite(since) ? Math.max(0, Math.floor((Date.now() - since) / 1000)) : null;
  const command = task.current_command ? clip(task.current_command, LIVE_COMMAND_PREVIEW_CHARS) : null;
  return { idle_seconds: idle, command_running: Boolean(task.current_command), current_command: command };
}

// The acceptance verdict as get_worker_result reports it, with the one
// contradiction a tool can see spelled out: checks passed, worker says
// otherwise (the "it was never built" case, where it was).
function acceptanceView(task, behind) {
  const configured = Array.isArray(task.acceptance) && task.acceptance.length > 0;
  const results = task.acceptance_results ?? null;
  const view = {
    configured,
    commands: configured ? task.acceptance : [],
    status: results?.status ?? null,
    passed: results?.passed ?? null,
    run: results?.run ?? null,
    checks: results?.checks ?? [],
    error: results?.error ?? null,
    // Drift matters only before the work is landed: once it is on the
    // branch, the branch having moved is expected.
    stale: Boolean(results && behind && behind.behind > 0 && !(task.landed_at && task.landed_at >= (results.finished_at ?? ""))),
    next_step: null
  };
  if (!configured) return view;
  if (view.status === "failed") {
    const failing = view.checks.find((check) => check.passed === false || check.exit_code !== 0 || check.timed_out) ?? null;
    view.next_step = failing
      ? `acceptance failed: ${clip(failing.command, 120)} failed ${failing.error ?? (failing.baseline?.passed === false ? "baseline/evidence mismatch" : failing.timed_out ? "by timeout" : `exit ${failing.exit_code}`)}; resume the worker with checks[].output_tail in the prompt, or fix it yourself. Do not land until it passes.`
      : `acceptance could not run (${view.error ?? "unknown"}); fix that first`;
  } else if (view.status === "passed") {
    const verification = summarizeVerification(task);
    const workerSaysNo = task.status === "failed" || isGoalNeedingAttention(task.goal_status) || verification.last_command_failed;
    if (workerSaysNo) view.next_step = "the checks passed but the worker reports otherwise; trust the checks and read the diff";
    else if (view.stale) view.next_step = "the checks passed on the old base and the project has moved since; resume with rebaseOnto to re-run them on current code before landing";
  } else if (view.status === "running") {
    view.next_step = "acceptance is still running in the supervisor; wait_codex_workers returns when it is done";
  } else if (view.status === "interrupted") {
    view.next_step = "the supervisor exited while running acceptance; resume the worker (or cancel and redispatch) to run it again";
  } else if (view.status === "cancelled") {
    view.next_step = "acceptance was cancelled; resume the worker to run it again";
  } else if (view.status === null) {
    view.next_step = "acceptance has not run yet for this worker";
  }
  return view;
}

function summarizeTask(task) {
  return {
    id: task.id,
    title: task.title,
    worker: task.worker,
    status: task.status,
    phase: task.phase ?? null,
    cwd: task.cwd,
    project_root: task.project_root,
    workspace_kind: task.workspace_kind ?? "legacy",
    sandbox: task.sandbox,
    model: task.model,
    reasoning_effort: task.reasoning_effort ?? "high",
    thread_id: task.thread_id,
    followup_of: task.followup_of,
    resumed_from: task.resumed_from,
    depends_on: task.depends_on ?? [],
    owned_paths: task.owned_paths ?? [],
    worktree_path: task.worktree_path,
    goal_objective: task.goal_objective,
    goal_token_budget: task.goal_token_budget,
    goal_status: task.goal_status,
    attention_reason: task.attention_reason ?? null,
    changed_file_count: (task.changed_files ?? []).length,
    command_count: (task.commands ?? []).length,
    run_count: task.run_count ?? 0,
    acceptance: acceptanceVerdict(task),
    landed_at: task.landed_at ?? null,
    current_action: clip(task.current_action, ACTION_PREVIEW_CHARS),
    ...liveness(task),
    last_event_at: task.last_event_at ?? null,
    last_event_type: task.last_event_type,
    last_message: clip(task.last_message, 400),
    notices: clip(task.notices, 400),
    error: task.error,
    created_at: task.created_at,
    updated_at: task.updated_at,
    started_at: task.started_at,
    completed_at: task.completed_at,
    exit_code: task.exit_code
  };
}

// The status read used to hand back the stored row verbatim. For a follow-up
// worker that row carries the parent prompt plus the whole command history and
// the events folded into it; one real call returned 180k characters, past the
// client's MCP output cap, so the reply landed on disk and had to be grepped.
// This is the same status surface the other reads use, plus explicitly bounded
// extras. includePrompt is the escape hatch for the full task text.
function statusView(task, { includePrompt, promptMaxChars }) {
  const promptText = task.prompt ?? null;
  const promptBudget = includePrompt ? promptMaxChars : PROMPT_PREVIEW_CHARS;
  const commands = (task.commands ?? []).slice(-COMMAND_TAIL);
  return {
    ...summarizeTask(task),
    last_message: clip(task.last_message, STATUS_MESSAGE_CHARS),
    session_id: task.session_id ?? null,
    pid: task.pid ?? null,
    run_log: task.run_log ?? null,
    base_commit: task.base_commit ?? null,
    changed_files: readTaskChanges(task),
    current_command: clip(task.current_command, COMMAND_PREVIEW_CHARS),
    commands: commands.map((entry) => ({ ...entry, command: clip(entry.command, COMMAND_PREVIEW_CHARS) })),
    prompt: clip(promptText, promptBudget),
    prompt_truncated: Boolean(promptText) && String(promptText).length > promptBudget
  };
}

// The dispatch receipt. Dispatch used to return the whole task record, which
// echoes the task text - and for a follow-up, the parent prompt plus 20 raw
// events - back to the caller on every call. Dispatching eleven workers made
// the main thread pay for its own instructions eleven times, and pushed the
// result into the client's MCP output cap. Read the rest per worker with
// get_worker_summary / get_worker_result when you actually need it.
function receipt(task) {
  return {
    id: task.id,
    title: task.title,
    worker: task.worker,
    status: task.status,
    phase: task.phase ?? null,
    cwd: task.cwd,
    project_root: task.project_root,
    workspace_kind: task.workspace_kind ?? "legacy",
    worktree_path: task.worktree_path,
    branch: task.worktree_path ? `codex/${task.id}` : null,
    base_commit: task.base_commit ?? null,
    sandbox: task.sandbox,
    model: task.model,
    reasoning_effort: task.reasoning_effort,
    thread_id: task.thread_id,
    session_id: task.session_id ?? null,
    followup_of: task.followup_of,
    resumed_from: task.resumed_from,
    depends_on: task.depends_on ?? [],
    owned_paths: task.owned_paths ?? [],
    goal_objective: task.goal_objective,
    goal_token_budget: task.goal_token_budget,
    error: task.error ?? null,
    run_count: task.run_count ?? 0,
    run_log: task.run_log,
    created_at: task.created_at,
    updated_at: task.updated_at
  };
}

function overviewRow(task, caps) {
  return {
    id: task.id,
    title: clip(task.title, caps.title),
    status: task.status,
    phase: task.phase ?? null,
    goal: clip(task.goal_objective, caps.goal),
    goal_status: task.goal_status ?? null,
    last_action: clip(task.current_action, caps.action),
    idle_seconds: liveness(task).idle_seconds,
    command_running: Boolean(task.current_command) && ACTIVE_STATUSES.has(task.status),
    acceptance: acceptanceVerdict(task),
    changed_files: (task.changed_files ?? []).length,
    depends_on: task.depends_on ?? [],
    owned_paths: (task.owned_paths ?? []).map((entry) => clip(entry, caps.path))
  };
}

// One line per work for the listing tools. Kept deliberately small: the caller
// is usually a main thread that will drill into at most one of these.
function workRow(task) {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    phase: task.phase ?? null,
    goal: task.goal_objective ?? null,
    session_id: task.session_id ?? null,
    thread_id: task.thread_id ?? null,
    created_at: task.created_at,
    updated_at: task.updated_at
  };
}

// The overview is the tool the orchestrator calls by default, so it has to fit
// a fixed budget no matter how long titles and goals are. Field caps are
// lowered until the payload fits, and the payload reports what it cost.
function settleTokenCount(payload) {
  // The reported cost has to include the field that reports it, so iterate to
  // a fixed point instead of measuring a payload that lacks the number.
  let tokens = 0;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    payload.approx_tokens = tokens;
    const next = approxTokenCount(JSON.stringify(payload));
    if (next === tokens) break;
    tokens = next;
  }
  payload.approx_tokens = tokens;
  return Buffer.byteLength(JSON.stringify(payload), "utf8");
}

function buildOverview(tasks, extras = {}) {
  let payload;
  for (const [index, caps] of OVERVIEW_CAP_LEVELS.entries()) {
    payload = {
      generated_at: new Date().toISOString(),
      ...extras,
      total: tasks.length,
      active: tasks.filter((task) => ACTIVE_STATUSES.has(task.status)).length,
      needs_attention: tasks
        .filter((task) => isGoalNeedingAttention(task.goal_status) || task.attention_reason)
        .map((task) => task.id),
      // Terminal rows whose acceptance run failed. Kept apart from
      // needs_attention, which means "running and stuck"; this means
      // "finished and wrong", and the next step is a resume with the output.
      acceptance_failed: tasks.filter((task) => task.acceptance_results?.passed === false).map((task) => task.id),
      workers: tasks.map((task) => overviewRow(task, caps))
    };
    const bytes = settleTokenCount(payload);
    if (bytes <= OVERVIEW_BYTE_BUDGET) return payload;
    if (index === OVERVIEW_CAP_LEVELS.length - 1) {
      payload.budget_exceeded = true;
      payload.truncated_fields = true;
      settleTokenCount(payload);
      return payload;
    }
    delete payload.approx_tokens;
  }
  return payload;
}

function acceptanceLine(task) {
  if (!Array.isArray(task.acceptance) || task.acceptance.length === 0) return "acceptance: none configured";
  const results = task.acceptance_results;
  if (!results) return `acceptance: ${task.acceptance.length} configured, not run yet`;
  const ran = results.checks?.length ?? 0;
  const ok = (results.checks ?? []).filter((check) => check.passed !== false && check.exit_code === 0 && !check.timed_out).length;
  const failing = (results.checks ?? []).find((check) => check.passed === false || check.exit_code !== 0 || check.timed_out);
  return `acceptance: ${results.status}, ${ok}/${task.acceptance.length} passed (${ran} ran)${failing ? `, first failure: ${clip(failing.command, 80)} exit ${failing.timed_out ? "timeout" : failing.exit_code}` : ""}`;
}

function buildWorkerSummary(task, nativeGoal) {
  // Read the worktree too: a worker that edits via shell commands emits no
  // file_change events, so the checkout is the authoritative diff.
  const changed = readTaskChanges(task);
  const commands = task.commands ?? [];
  const lines = [
    `${task.title ?? task.id} — status=${task.status}${task.phase ? `, phase=${task.phase}` : ""}`,
    `goal: ${task.goal_objective ?? "-"}${task.goal_token_budget ? ` (budget ${task.goal_token_budget} tokens)` : ""}`,
    nativeGoal
      ? `codex goal: ${nativeGoal.status}, ${nativeGoal.tokens_used} tokens used, ${nativeGoal.time_used_seconds}s elapsed`
      : "codex goal: none recorded for this thread",
    `changed files (${changed.length}): ${changed.slice(0, 10).join(", ") || "-"}`,
    `last command: ${commands.at(-1)?.command ?? "-"}`,
    acceptanceLine(task),
    `last action: ${clip(task.current_action, ACTION_PREVIEW_CHARS) ?? "-"}`,
    `runs: ${task.run_count ?? 0}${task.resumed_from ? `, resumed from ${task.resumed_from}` : ""}`,
    task.error ? `error: ${task.error}` : null
  ].filter(Boolean);

  return {
    id: task.id,
    title: task.title,
    status: task.status,
    phase: task.phase ?? null,
    thread_id: task.thread_id,
    goal_objective: task.goal_objective,
    goal_token_budget: task.goal_token_budget,
    goal_status: task.goal_status,
    native_goal: nativeGoal,
    owned_paths: task.owned_paths ?? [],
    depends_on: task.depends_on ?? [],
    run_count: task.run_count ?? 0,
    changed_files: changed,
    command_count: commands.length,
    last_command: commands.at(-1)?.command ?? null,
    last_message: task.last_message ?? null,
    notices: task.notices ?? null,
    error: task.error ?? null,
    created_at: task.created_at,
    updated_at: task.updated_at,
    completed_at: task.completed_at,
    summary: lines.join("\n")
  };
}

function errorResult(error) {
  return textResult({
    error: error.code ?? "error",
    message: error.message,
    ...(error.conflicts ? { conflicts: error.conflicts } : {}),
    ...(error.details ? { files: error.details.files ?? [], git: error.details.git ?? null, base_commit: error.details.base_commit ?? null, head: error.details.head ?? null } : {})
  });
}

function externalOutputView(task, maxChars = 6000) {
  const outputs = task.run_evidence?.external_outputs ?? [];
  const perContent = Math.floor(maxChars / Math.max(1, outputs.length * 2));
  return outputs.map((entry) => ({ ...entry, before: { ...entry.before, content: clip(entry.before.content, perContent) },
    after: { ...entry.after, content: clip(entry.after.content, perContent) } }));
}

function reportView(task, maxChars) {
  const value = task.run_evidence?.structured_report;
  if (!value) return { format: "legacy_text", valid: null };
  if (!value.valid || !maxChars) return value;
  const report = value.report;
  const perEntry = Math.floor(maxChars / Math.max(1, 2 + report.verification.length + report.not_done.length));
  return { ...value, report: { result: clip(report.result, perEntry * 2),
    verification: report.verification.map((entry) => clip(entry, perEntry)),
    not_done: report.not_done.map((entry) => clip(entry, perEntry)) } };
}

function runEvidenceView(task) {
  if (!task.run_evidence) return null;
  const { structured_report, external_outputs, ...evidence } = task.run_evidence;
  return { ...evidence, external_changed_count: (external_outputs ?? []).filter((entry) => entry.changed).length };
}

const acceptanceFailureRecord = z.object({
  test_id: z.string().min(1), kind: z.enum(["failure", "error"]), signature: z.string().min(1)
}).strict();
const acceptanceCheck = z.union([
  z.string().min(1),
  z.object({
    command: z.string().min(1), reportPath: z.string().min(1),
    baseline: z.object({
      identity: z.object({ base_commit: z.string().min(1) }).catchall(z.string().min(1)),
      failures: z.array(acceptanceFailureRecord), required: z.array(z.string().min(1))
    }).strict()
  }).strict()
]);
const acceptanceInput = z.union([z.string().min(1), z.array(acceptanceCheck).max(10)]);

const observerId = process.env.CODEX_SUPERVISOR_OBSERVER_ID?.trim() || `mcp-${randomUUID()}`;
const deltaObserverId = process.env.CODEX_SUPERVISOR_DELTA_OBSERVER_ID?.trim() || `${observerId}:delta`;
let observerRead = Promise.resolve();
let deltaRead = Promise.resolve();
server.registerTool(
  "overview_delta",
  {
    title: "Get orchestration delta",
    description: "Return a small cursor-based orchestration view: active, needs_attention, ready_to_land, ready_to_clean and changed task summaries. It never returns full history, prompts, diffs, events or worker capsules.",
    inputSchema: { cursor: z.record(z.string(), z.string()).optional() }
  },
  async ({ cursor }) => {
    const read = deltaRead.then(async () => {
      await reconcileDetachedActiveTasks();
      const tasks = await readTasks();
      const previous = cursor ?? await readObserverCursor(deltaObserverId);
      const candidateIds = tasks.filter((task) => task.delivery_state === "cleanup_eligible").map((task) => task.id);
      const cleanupReadiness = candidateIds.length > 0
        ? await createCleanupPlan({ taskIds: candidateIds, revalidateRemote: false })
        : null;
      const readyToCleanTaskIds = cleanupReadiness
        ? new Set(cleanupReadiness.items.filter((item) => item.verdict === "safe").map((item) => item.task_id))
        : new Set();
      const result = buildOverviewDelta(tasks, previous, { readyToCleanTaskIds });
      await writeObserverCursor(deltaObserverId, result.cursor);
      const { cursor: nextCursor, ...reply } = result;
      return textResult({ ...reply, next_cursor: nextCursor });
    });
    deltaRead = read.catch(() => {});
    return read;
  }
);
server.registerTool("check_workers", {
  title: "Check changed workers",
  description: "Check newly settled runs and actionable failures; automatically resume a dead lost/no_work first run once, except approval, authentication, permission and quota waits. Returns recovery receipts; unchanged state is quiet. Call from a host-scheduled loop; it cannot wake a closed host. Set a distinct CODEX_SUPERVISOR_OBSERVER_ID per main thread to retain its cursor across restarts.",
  inputSchema: {}
}, async () => {
  const read = observerRead.then(async () => {
    await reconcileDetachedActiveTasks();
    const recoveries = await recoverEligibleRuns();
    const result = collectWorkerChanges(await readTasks(), await readObserverCursor(observerId));
    await writeObserverCursor(observerId, result.cursor);
    const { cursor, ...reply } = result;
    // The cleanup hint rides along without touching quiet: it is a standing fact
    // about the store, not a new worker event.
    const cleanup = await cleanupHint();
    return textResult({ ...reply, quiet: reply.quiet && recoveries.length === 0, recoveries, ...(cleanup ? { cleanup } : {}) });
  });
  observerRead = read.catch(() => {});
  return read;
});

server.registerTool(
  "check_acceptance",
  {
    title: "Check acceptance commands",
    description: "Run explicitly supplied acceptance commands in the requested project before dispatch. This executes the commands with supervisor privileges and can have their side effects; it creates no worker and does not prove worker completion. Structured checks require fresh execution evidence, while failure-count greps are flagged as insufficient baseline evidence.",
    inputSchema: {
      cwd: z.string().min(1), acceptance: acceptanceInput,
      baseRef: z.string().min(1).optional(), timeoutMs: z.number().int().min(1000).max(1800000).default(600000)
    }
  },
  async ({ cwd, acceptance, baseRef = "HEAD", timeoutMs }) => {
    let base;
    try {
      base = execFileSync("git", ["-C", cwd, "rev-parse", "--verify", `${baseRef}^{commit}`], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] }).trim();
    } catch {
      return textResult({ error: "invalid_base_ref", phase: "preflight", reason: `baseRef does not resolve in ${cwd}`, proves_worker_completion: false });
    }
    try {
      const commands = Array.isArray(acceptance) ? acceptance : [acceptance];
      const warnings = commands.filter((check) => typeof check === "string" && /(?:failures|errors)\s*=\s*\d/.test(check)).map(() => "failure-count checks do not prove baseline test identities or required execution; use structured evidence");
      const result = await runAcceptance(commands, { cwd, timeoutMs, baseCommit: base, taskId: `preflight-${randomUUID()}` });
      return textResult({ ...result, phase: "preflight", base_commit: base, proves_worker_completion: false, warnings });
    } catch (error) {
      return errorResult(error);
    }
  }
);

server.registerTool(
  "preflight_codex_worker",
  {
    title: "Preflight Codex worker environment",
    description:
      "Launch a short-lived Codex probe worker in the same base commit, sandbox, guard, network and writable-root configuration intended for a later write worker. The probe must run every requested command in the actual worker environment. Read get_worker_preflight after it settles, then pass its task_id as create_codex_worker.preflight_id; a changed runtime contract is refused.",
    inputSchema: {
      title: z.string().optional(),
      cwd: z.string().min(1),
      sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).default("workspace-write"),
      model: z.string().optional(),
      reasoningEffort: z.enum(["minimal", "low", "medium", "high"]).default("high"),
      skipGitRepoCheck: z.boolean().default(true),
      ownedPaths: z.array(z.string().min(1)),
      forbid: z.array(z.string().min(1)).max(100).optional(),
      allowedCommands: z.array(z.string().min(1)).max(100).optional(),
      context: z.array(z.object({ path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() })).max(20).optional(),
      contracts: z.array(z.string().min(1).max(2000)).max(20).optional(),
      networkAccess: z.boolean().default(false),
      writableRoots: z.array(z.string().min(1)).max(20).optional(),
      maxRunMs: z.number().int().min(1000).max(86400000).optional(),
      maxTotalMs: z.number().int().min(1000).max(604800000).optional(),
      baseRef: z.string().min(1).optional(),
      workspaceKind: z.enum(["git_worktree", "read_only_in_place", "scratch", "in_place_write"]).optional(),
      inPlaceAuthorization: z.string().min(1).max(2000).optional(),
      probeCommands: z.array(z.string().min(1)).min(1).max(20)
    }
  },
  async (input) => {
    try {
      const task = [
        "Runtime environment preflight. Do not edit files, create files, install packages, dispatch workers or call MCP tools.",
        "Run every command below exactly once, in the listed order, without wrapping it in another shell command.",
        "If any command is denied, missing, times out or exits nonzero, stop and quote the raw error under Not done / risks.",
        "Commands:",
        ...input.probeCommands.map((command) => `- ${command}`)
      ].join("\n");
      const record = await createCodexWorker({
        ...input,
        title: input.title ? `Preflight: ${input.title}` : "Runtime environment preflight",
        task,
        goal: { objective: `Prove the requested Codex worker runtime environment before dispatching ${input.title ?? "the dependent worker"}` },
        acceptance: null,
        preflight: { probeCommands: input.probeCommands }
      });
      return textResult(withUpdate({ ...receipt(record), preflight: { status: "running", probe_commands: input.probeCommands } }));
    } catch (error) {
      return errorResult(error);
    }
  }
);

server.registerTool(
  "get_worker_preflight",
  {
    title: "Get worker preflight result",
    description: "Read whether a preflight probe ran every required command successfully in the tracked worker environment, plus the immutable runtime contract hash required by create_codex_worker.preflight_id.",
    inputSchema: { task_id: z.string().min(1) }
  },
  async ({ task_id }) => {
    const task = await getTask(task_id);
    if (!task) return textResult({ error: "task_not_found", task_id });
    return textResult(readPreflightResult(task));
  }
);

server.registerTool(
  "create_codex_worker",
  {
    title: "Create Codex worker",
    description:
      "Launch a Codex CLI worker with codex exec --json and track its events. workspaceKind controls where it runs: Git work writes only in an isolated git_worktree; read_only_in_place cannot write or use network; scratch writes only under SUPERVISOR_HOME and never lands; in_place_write is only for an explicitly authorized non-Git directory with ownedPaths and acceptance. A non-Git worker may never write the user directory by default. ownedPaths reserves files a landable worker may write; reading is never exclusive. acceptance is the list of shell commands that decide whether the work is done: the supervisor runs them after Codex exits. The worker's sandbox may write its execution directory, the temp directory and the OS cache directory; a toolchain whose cache lives elsewhere needs writableRoots, a list of existing absolute directories.",
    inputSchema: {
      title: z.string().optional(),
      task: z.string().min(1),
      cwd: z.string().min(1),
      session_id: z.string().min(1).optional(),
      // What this batch is about, in one line, so a reader of the store sees
      // "给 12 个接口补单测" instead of a bare session id. Set it on
      // the first dispatch of a session; later dispatches may omit it.
      session_title: z.string().min(1).max(120).optional(),
      session_note: z.string().min(1).max(2000).optional(),
      sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).default("workspace-write"),
      model: z.string().optional(),
      reasoningEffort: z.enum(["minimal", "low", "medium", "high"]).default("high"),
      skipGitRepoCheck: z.boolean().default(true),
      // Empty is the promise that nothing lands: a read-only verifier, or a
      // research worker that reads, fetches and reports but merges nothing.
      ownedPaths: z.array(z.string().min(1)),
      forbid: z.array(z.string().min(1)).max(100).optional(),
      allowedCommands: z.array(z.string().min(1)).max(100).optional(),
      context: z.array(z.object({ path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() })).max(20).optional(),
      contracts: z.array(z.string().min(1).max(2000)).max(20).optional(),
      externalOutputs: z.array(z.object({ path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() })).max(20).optional(),
      networkAccess: z.boolean().default(false),
      // Extra absolute directories the sandbox may write. The OS cache
      // directory is already writable; this is for toolchains that keep a
      // cache somewhere else (~/.m2, ~/.gradle, a vendored mirror).
      writableRoots: z.array(z.string().min(1)).max(20).optional(),
      maxRunMs: z.number().int().min(1000).max(86400000).optional(),
      maxTotalMs: z.number().int().min(1000).max(604800000).optional(),
      goal: z.object({
        objective: z.string().min(1),
        tokenBudget: z.number().int().positive().optional()
      }),
      dependsOn: z.array(z.string().min(1)).optional(),
      // Which commit the worktree is cut from. Defaults to the repository's
      // HEAD; pass a branch, tag or sha to build on work that is not on the
      // main line yet (for example another worker's codex/<id> branch).
      baseRef: z.string().min(1).optional(),
      workspaceKind: z.enum(["git_worktree", "read_only_in_place", "scratch", "in_place_write"]).optional(),
      inPlaceAuthorization: z.string().min(1).max(2000).optional(),
      // A successful preflight_codex_worker task id. When present, this worker
      // is refused unless base commit and the complete runtime contract match.
      preflight_id: z.string().min(1).optional(),
      // Shell commands that decide whether the work is done. The supervisor
      // runs them in the worktree after codex exits; each must exit 0.
      acceptance: acceptanceInput.optional(),
      acceptanceTimeoutMs: z.number().int().min(1000).max(1800000).optional()
    }
  },
  async (input) => {
    try {
      const record = await createCodexWorker({
        ...input,
        preflightId: input.preflight_id ?? null,
        sessionId: input.session_id ?? null,
        sessionTitle: input.session_title ?? null,
        sessionNote: input.session_note ?? null
      });
      return textResult(withUpdate(receipt(record)));
    } catch (error) {
      return errorResult(error);
    }
  }
);

server.registerTool(
  "create_codex_followup_worker",
  {
    title: "Create Codex follow-up worker",
    description:
      "Start a NEW Codex session seeded with the previous worker's prompt, status, and recent events. To continue the same session instead, use resume_codex_worker.",
    inputSchema: {
      task_id: z.string().min(1),
      followup_prompt: z.string().min(1),
      session_id: z.string().min(1).optional(),
      session_title: z.string().min(1).max(120).optional(),
      session_note: z.string().min(1).max(2000).optional(),
      title: z.string().optional(),
      cwd: z.string().optional(),
      sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional(),
      model: z.string().optional(),
      reasoningEffort: z.enum(["minimal", "low", "medium", "high"]).default("high"),
      ownedPaths: z.array(z.string().min(1)).optional(),
      forbid: z.array(z.string().min(1)).max(100).optional(),
      allowedCommands: z.array(z.string().min(1)).max(100).optional(),
      context: z.array(z.object({ path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() })).max(20).optional(),
      contracts: z.array(z.string().min(1).max(2000)).max(20).optional(),
      externalOutputs: z.array(z.object({ path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() })).max(20).optional(),
      networkAccess: z.boolean().optional(),
      writableRoots: z.array(z.string().min(1)).max(20).optional(),
      maxRunMs: z.number().int().min(1000).max(86400000).optional(),
      maxTotalMs: z.number().int().min(1000).max(604800000).optional(),
      workspaceKind: z.enum(["git_worktree", "read_only_in_place", "scratch", "in_place_write"]).optional(),
      inPlaceAuthorization: z.string().min(1).max(2000).optional(),
      goal: z
        .object({
          objective: z.string().min(1),
          tokenBudget: z.number().int().positive().optional()
        })
        .optional(),
      baseRef: z.string().min(1).optional(),
      // Left out, the parent's acceptance commands are inherited; given, they
      // replace them, and an empty list clears them.
      acceptance: acceptanceInput.optional(),
      acceptanceTimeoutMs: z.number().int().min(1000).max(1800000).optional()
    }
  },
  async ({ task_id, followup_prompt, session_id, session_title, session_note, ...options }) => {
    try {
      const record = await createFollowupWorker({
          taskId: task_id,
          followupPrompt: followup_prompt,
          sessionId: session_id ?? null,
          sessionTitle: session_title ?? null,
          sessionNote: session_note ?? null,
          ...options
        });
      return textResult(receipt(record));
    } catch (error) {
      return errorResult(error);
    }
  }
);

server.registerTool(
  "resume_codex_worker",
  {
    title: "Resume Codex worker",
    description:
      "Continue the SAME Codex session for an existing worker via `codex exec resume <thread_id>`. Works from a different MCP process or a fresh client session as long as the task recorded a thread_id. The worktree stays on the commit it was cut from unless rebaseOnto names a ref (resolved in the project directory, e.g. HEAD or main): uncommitted edits are stashed, the worker's own commits are replayed onto it, the stash comes back and base_commit moves, so the worker continues on current code. A conflict in either step puts the worktree back as it was, lists the files and does not start the worker. The receipt carries base_behind: how many commits the project's HEAD is past the worktree's base. acceptance replaces the worker's acceptance commands when the ones given at dispatch were wrong; the supervisor runs them again after this run.",
    inputSchema: {
      task_id: z.string().min(1),
      prompt: z.string().min(1),
      rebaseOnto: z.string().min(1).optional(),
      context: z.array(z.object({ path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() })).max(20).optional(),
      // Replaces the stored acceptance commands for this and later runs; an
      // empty list clears them. Left out, the stored commands stay.
      acceptance: acceptanceInput.optional()
    }
  },
  async ({ task_id, prompt, rebaseOnto, acceptance, context }) => {
    try {
      const record = await resumeCodexWorker({ taskId: task_id, prompt, rebaseOnto: rebaseOnto ?? null, acceptance, context });
      return textResult({ ...receipt(record), rebase: record.rebase ?? null, base_behind: baseBehind(record.project_root, record.base_commit) });
    } catch (error) {
      return errorResult(error);
    }
  }
);

server.registerTool(
  "list_codex_workers",
  {
    title: "List Codex workers",
    description: "List tracked Codex workers. Defaults to active workers only.",
    inputSchema: {
      status: z.enum(TASK_STATUSES).optional(),
      includeHistory: z.boolean().default(false),
      includeDetails: z.boolean().default(false)
    }
  },
  async ({ status, includeHistory, includeDetails } = {}) => {
    await reconcileDetachedActiveTasks();
    const tasks = await readTasks();
    const filtered = status
      ? tasks.filter((task) => task.status === status)
      : includeHistory
        ? tasks
        : tasks.filter((task) => ACTIVE_STATUSES.has(task.status));
    return textResult(includeDetails ? filtered : filtered.map(summarizeTask));
  }
);

server.registerTool(
  "get_orchestration_overview",
  {
    title: "Get orchestration overview",
    description:
      "Compact status table for every worker, budgeted to stay under ~2k tokens. This is the default read for an orchestrating main thread; fetch details per worker only when needed.",
    inputSchema: {
      status: z.enum(TASK_STATUSES).optional(),
      limit: z.number().int().min(1).max(200).default(50)
    }
  },
  async ({ status, limit } = {}) => {
    await reconcileDetachedActiveTasks();
    const tasks = await readTasks();
    const filtered = (status ? tasks.filter((task) => task.status === status) : tasks).slice(-limit);
    // version and update ride inside the budgeted payload so approx_tokens
    // still reports the real cost of the whole reply.
    return textResult(
      buildOverview(filtered, {
        version: packageVersion,
        update: updateField() ?? { update_available: false, installed_version: packageVersion, checked: updateState?.source ?? "pending" }
      })
    );
  }
);

server.registerTool(
  "wait_codex_workers",
  {
    title: "Wait for Codex workers",
    description:
      "Block until selected Codex workers reach a terminal status, then return summaries. The wait budget bounds this call, not the workers: when it runs out you get a progress snapshot and the workers keep running, so call this again with the same task_ids to keep waiting. Keep the budget under your client's MCP tool timeout, or the client kills the call instead of the wait returning. compact: true returns one line per worker: status, phase, exit_code, changed_file_count, acceptance (passed / failed / null when none was configured or it did not run), plus idle_seconds since the last Codex event of this run, command_running and current_command. Codex emits nothing while a command runs or while the model thinks, so a long idle with command_running: true is a long command and a long idle without it is thinking (or a process that reconcile will report as lost).",
    inputSchema: {
      task_ids: z.array(z.string().min(1)).min(1),
      mode: z.enum(["any", "all"]).default("all"),
      timeoutMinutes: z.number().int().min(1).max(360).default(1),
      timeoutMs: z.number().int().min(1000).max(21600000).optional(),
      pollMs: z.number().int().min(250).max(10000).default(1000),
      // Off by default. A wait is the call clients background and then replay
      // as a notification, so its payload has to stay small; ten events per
      // worker was the bulk of it. Ask for events explicitly, or read
      // get_codex_worker_events for one worker.
      includeEvents: z.boolean().default(false),
      eventLimit: z.number().int().min(1).max(50).default(10),
      // Events used to come back whole: one command event can carry a heredoc
      // that is tens of KB, and ten of those made a single wait response
      // unreadable. The default bounds each string; pass a bigger number when
      // you actually want the raw text.
      eventMaxChars: z.number().int().min(0).max(1000000).default(800),
      eventKinds: z.array(z.string().min(1)).optional(),
      // The smallest useful answer: one line per worker, for a caller that
      // only wants to know who is done. Everything else comes from
      // get_worker_result / get_worker_diff afterwards.
      compact: z.boolean().optional()
    }
  },
  async ({
    task_ids,
    mode,
    timeoutMinutes,
    timeoutMs,
    pollMs,
    includeEvents,
    eventLimit,
    eventMaxChars,
    eventKinds,
    compact: requestedCompact
  }, extra) => {
    const compact = requestedCompact ?? !includeEvents;
    const startedAt = Date.now();
    const effectiveTimeoutMs = timeoutMs ?? timeoutMinutes * 60 * 1000;
    let tasks = [];
    const progressToken = extra?._meta?.progressToken;
    let lastProgressAt = -Infinity;

    while (Date.now() - startedAt < effectiveTimeoutMs) {
      if (extra?.signal.aborted) break;
      await reconcileDetachedActiveTasks();
      tasks = (await getTasks(task_ids)).filter(Boolean);
      const settledCount = tasks.filter(isSettled).length;
      const isDone = mode === "any" ? settledCount > 0 : settledCount === task_ids.length;
      if (isDone) break;
      const elapsed = Date.now() - startedAt;
      if (progressToken != null && elapsed - lastProgressAt >= 30000) {
        await extra.sendNotification({ method: "notifications/progress", params: {
          progressToken, progress: elapsed, total: effectiveTimeoutMs,
          message: `${settledCount}/${task_ids.length} workers settled; wait budget only`
        } }).catch(() => {});
        lastProgressAt = elapsed;
      }
      await sleep(pollMs);
    }

    await reconcileDetachedActiveTasks();
    tasks = (await getTasks(task_ids)).filter(Boolean);
    const missingIds = task_ids.filter((taskId) => !tasks.some((task) => task.id === taskId));
    const settledTasks = tasks.filter(isSettled);
    const timedOut =
      mode === "any" ? settledTasks.length === 0 : settledTasks.length !== task_ids.length;

    const summaries = await Promise.all(
      tasks.map(async (task) => ({
        ...summarizeTask(task),
        recent_events: includeEvents
          ? await readTaskEvents(task.id, eventLimit, eventKinds ?? null).then((events) =>
              eventMaxChars === undefined ? events : events.map((event) => truncateEventStrings(event, eventMaxChars))
            )
          : undefined
      }))
    );

    const budgetLabel =
      effectiveTimeoutMs >= 60000
        ? `${Math.round(effectiveTimeoutMs / 60000)}-minute`
        : `${Math.round(effectiveTimeoutMs / 1000)}-second`;

    return textResult(withUpdate({
      mode,
      timed_out: timedOut,
      still_running: timedOut,
      next_step: timedOut
        ? `Workers are still running; the ${budgetLabel} wait budget ran out, not the workers. Call wait_codex_workers again with the same task_ids, or use get_orchestration_overview for a cheap progress read. Raise timeoutMinutes only if your client's MCP tool timeout allows it.`
        : null,
      waited_ms: Date.now() - startedAt,
      timeout_ms: effectiveTimeoutMs,
      timeout_minutes: Math.round(effectiveTimeoutMs / 60000),
      missing_ids: missingIds,
      completed_count: tasks.filter((task) => task.status === "completed").length,
      failed_count: tasks.filter((task) => task.status === "failed").length,
      cancelled_count: tasks.filter((task) => task.status === "cancelled").length,
      lost_count: tasks.filter((task) => task.status === "lost").length,
      active_count: tasks.filter((task) => ACTIVE_STATUSES.has(task.status)).length,
      acceptance_failed_count: tasks.filter((task) => task.acceptance_results?.passed === false).length,
      workers: compact
        ? tasks.map((task) => ({
            id: task.id,
            title: clip(task.title, 60),
            status: task.status,
            phase: task.phase ?? null,
            exit_code: task.exit_code ?? null,
            changed_file_count: readTaskChanges(task).length,
            acceptance: acceptanceVerdict(task),
            ...liveness(task),
            updated_at: task.updated_at ?? null
          }))
        : summaries
    }));
  }
);

server.registerTool(
  "get_session_works",
  {
    title: "Get session works",
    description:
      "Every worker dispatched under one session_id, oldest first. This is the reconnect path: a main-thread session that died can list the whole batch it started without holding any of it in context.",
    inputSchema: {
      session_id: z.string().min(1)
    }
  },
  async ({ session_id }) => {
    const tasks = await readTasksBySession(session_id);
    const meta = await getSession(session_id);
    return textResult({
      session_id,
      title: meta?.title ?? null,
      note: meta?.note ?? null,
      objective: meta?.objective ?? null,
      default_acceptance: meta?.default_acceptance ?? [],
      approval_state: meta?.approval_state ?? "approved",
      policy_revision: meta?.policy_revision ?? 0,
      count: tasks.length,
      active: tasks.filter((task) => ACTIVE_STATUSES.has(task.status)).length,
      works: tasks.map(workRow)
    });
  }
);

server.registerTool(
  "check_for_update",
  {
    title: "Check for update",
    description:
      "Ask the npm registry whether a newer codex-supervisor-mcp is published, and whether the installed files match the published tarball. Returns installed and latest version, integrity check, and the install command. The same check runs on startup; call this to force a fresh one.",
    inputSchema: {
      force: z.boolean().default(true)
    }
  },
  async ({ force }) => {
    const result = await refreshUpdateState({ force });
    if (!result) return textResult({ error: "update_check_failed" });
    return textResult({ ...result, auto_update: autoUpdateState });
  }
);

server.registerTool(
  "describe_session",
  {
    title: "Describe session",
    description:
      "Record what a session is about: a one-line title and an optional note. Readers of the store (the web view, get_session_works) show these instead of the bare session id. Fields you omit are kept.",
    inputSchema: {
      session_id: z.string().min(1),
      title: z.string().min(1).max(120).optional(),
      note: z.string().min(1).max(2000).optional(),
      objective: z.string().min(1).max(5000).optional(),
      default_acceptance: z.array(acceptanceCheck).max(10).optional(),
      approval_state: z.enum(["approved", "waiting_user"]).optional(),
      expected_revision: z.number().int().nonnegative().optional()
    }
  },
  async ({ session_id, title, note, objective, default_acceptance, approval_state, expected_revision }) => {
    try {
      const row = await upsertSession({ id: session_id, title: title ?? null, note: note ?? null, objective, defaultAcceptance: default_acceptance, approvalState: approval_state, expectedRevision: expected_revision });
      return textResult({ ...row, session_id, host_goal_sync: buildHostGoalSync(row) });
    } catch (error) { return errorResult(error); }
  }
);

server.registerTool(
  "search_works",
  {
    title: "Search works",
    description:
      "Substring search over title, goal, prompt and last message of every tracked worker, newest first. Use it to find an earlier work by keyword instead of paging through history.",
    inputSchema: {
      query: z.string().min(1),
      limit: z.number().int().positive().max(100).default(20)
    }
  },
  async ({ query, limit }) => {
    const tasks = await searchTasks(query, limit);
    return textResult({
      query,
      count: tasks.length,
      works: tasks.map(workRow)
    });
  }
);

server.registerTool(
  "get_codex_worker_status",
  {
    title: "Get Codex worker status",
    description:
      "Read the latest normalized status for one Codex worker: lifecycle, phase, current action, changed files, goal, recent commands, and the task prompt (clipped by default). Set includePrompt to read the prompt in full, or use get_codex_worker_events for the raw stream.",
    inputSchema: {
      task_id: z.string().min(1),
      includePrompt: z.boolean().default(false),
      promptMaxChars: z.number().int().min(0).max(1000000).default(5000)
    }
  },
  async ({ task_id, includePrompt, promptMaxChars }) => {
    const task = await getTask(task_id);
    if (!task) return textResult({ error: "task_not_found", task_id });
    return textResult(statusView(task, { includePrompt, promptMaxChars }));
  }
);

server.registerTool(
  "get_codex_worker_events",
  {
    title: "Get Codex worker events",
    description:
      "Read recent raw Codex JSONL events for one worker. limit, maxChars and kinds keep the read inside a context budget; maxChars truncates the middle of oversized strings the same way Codex truncates its own output.",
    inputSchema: {
      task_id: z.string().min(1),
      limit: z.number().int().min(1).max(1000).default(100),
      maxChars: z.number().int().min(0).max(1000000).optional(),
      kinds: z.array(z.string().min(1)).optional()
    }
  },
  async ({ task_id, limit, maxChars, kinds }) => {
    const task = await getTask(task_id);
    if (!task) return textResult({ error: "task_not_found", task_id });
    const events = await readTaskEvents(task_id, limit, kinds ?? null);
    const trimmed = maxChars === undefined ? events : events.map((event) => truncateEventStrings(event, maxChars));
    return textResult({
      task_id,
      count: trimmed.length,
      available_kinds: await listTaskEventKinds(task_id),
      events: trimmed
    });
  }
);

server.registerTool(
  "get_context_snapshot_meta",
  {
    title: "Get worker context snapshot metadata",
    description: "Read the latest worker-only context snapshot metadata for one task. Returns fact IDs, token estimate and excluded categories, never the capsule text or raw history.",
    inputSchema: { task_id: z.string().min(1) }
  },
  async ({ task_id }) => {
    const task = await getTask(task_id);
    if (!task) return textResult({ error: "task_not_found", task_id });
    const snapshot = await latestContextSnapshotForTask(task_id);
    if (!snapshot) return textResult({ task_id, snapshot: null });
    return textResult({
      task_id,
      snapshot: {
        id: snapshot.id,
        run_id: snapshot.run_id,
        recipient: snapshot.recipient,
        fact_ids: JSON.parse(snapshot.fact_versions),
        base_sha: snapshot.base_sha,
        prompt_sha256: snapshot.prompt_sha256,
        estimated_tokens: snapshot.estimated_tokens,
        excluded: JSON.parse(snapshot.excluded_json),
        created_at: snapshot.created_at
      }
    });
  }
);

server.registerTool(
  "get_fact",
  {
    title: "Get one verified or candidate fact",
    description: "Read one fact by ID for audit. Facts are never automatically expanded into the main thread's context.",
    inputSchema: { fact_id: z.string().uuid() }
  },
  async ({ fact_id }) => {
    const fact = await getFact(fact_id);
    return textResult(fact ? { fact } : { error: "fact_not_found", fact_id });
  }
);

server.registerTool(
  "get_artifact",
  {
    title: "Get one retained evidence artifact",
    description: "Read one supervisor-managed artifact by ID for audit. This is explicit evidence retrieval and never expands a worker context capsule into the main thread.",
    inputSchema: { artifact_id: z.string().uuid(), maxChars: z.number().int().min(0).max(100000).default(12000) }
  },
  async ({ artifact_id, maxChars }) => {
    const artifact = await getArtifact(artifact_id);
    if (!artifact) return textResult({ error: "artifact_not_found", artifact_id });
    return textResult({ artifact: await readArtifact(artifact_id, maxChars) });
  }
);

server.registerTool(
  "get_worker_evidence",
  {
    title: "Get a worker evidence index",
    description: "Return bounded event metadata and retained artifact IDs for one worker. It does not return raw history, prompts or a worker context capsule; use get_artifact or get_codex_worker_events for a selected item.",
    inputSchema: { task_id: z.string().min(1), limit: z.number().int().min(1).max(100).default(30) }
  },
  async ({ task_id, limit }) => {
    const task = await getTask(task_id);
    if (!task) return textResult({ error: "task_not_found", task_id });
    const events = await readTaskEventRecords(task_id, limit);
    const artifacts = await listArtifactsForTask(task_id, limit);
    return textResult({
      task_id,
      events: events.map((event) => ({ id: event.id, run_id: event.run_id, type: event.event_type, actor: event.actor, payload_sha256: event.payload_sha256, created_at: event.created_at })),
      artifacts: artifacts.map((artifact) => ({ id: artifact.id, run_id: artifact.run_id, type: artifact.type, sha256: artifact.sha256, security_class: artifact.security_class, retention: artifact.retention, created_at: artifact.created_at }))
    });
  }
);

function decodeFactCursor(cursor, taskId, query) {
  if (!cursor) return 0;
  try {
    const payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (payload.task_id !== taskId || payload.query !== query || !Number.isInteger(payload.offset) || payload.offset < 0) throw new Error("mismatch");
    return payload.offset;
  } catch {
    const error = new Error("fact cursor does not match this task and query");
    error.code = "invalid_fact_cursor";
    throw error;
  }
}

function encodeFactCursor(taskId, query, offset) {
  return Buffer.from(JSON.stringify({ task_id: taskId, query, offset })).toString("base64url");
}

function factFreshForTask(task, fact) {
  if (!fact.valid_for_sha || !task.base_commit) return true;
  try {
    git(task.project_root, ["merge-base", "--is-ancestor", fact.valid_for_sha, task.base_commit]);
    return true;
  } catch {
    return false;
  }
}

server.registerTool(
  "search_worker_facts",
  {
    title: "Search verified worker facts in scope",
    description: "Search only verified facts relevant to one task: its own work, explicit dependencies and path-matched repository facts. Returns compact summaries, coverage and a cursor; never raw events, reports, prompts or worker capsules.",
    inputSchema: {
      task_id: z.string().min(1),
      query: z.string().max(500).default(""),
      limit: z.number().int().min(1).max(50).default(20),
      cursor: z.string().min(1).optional()
    }
  },
  async ({ task_id, query, limit, cursor }) => {
    const task = await getTask(task_id);
    if (!task) return textResult({ error: "task_not_found", task_id });
    try {
      const normalizedQuery = query.trim().toLocaleLowerCase();
      const offset = decodeFactCursor(cursor, task_id, normalizedQuery);
      const scoped = (await listContextFacts({
        taskId: task_id,
        baseSha: task.base_commit ?? null,
        ownedPaths: task.owned_paths ?? [],
        dependencyTaskIds: task.depends_on ?? []
      })).filter((fact) => factFreshForTask(task, fact));
      const matching = scoped.filter((fact) => !normalizedQuery || `${fact.key}\n${JSON.stringify(fact.value)}`.toLocaleLowerCase().includes(normalizedQuery));
      const page = matching.slice(offset, offset + limit);
      const nextOffset = offset + page.length;
      const totalVerified = await countVerifiedFacts();
      return textResult({
        task_id,
        facts: page.map((fact) => ({
          id: fact.id,
          key: fact.key,
          summary: clip(typeof fact.value === "string" ? fact.value : JSON.stringify(fact.value), 360),
          state: fact.state,
          scope: fact.scope_type,
          valid_for_sha: fact.valid_for_sha ?? null,
          freshness: "current",
          source_refs: [
            ...(fact.source_event_id ? [`event:${fact.source_event_id}`] : []),
            ...(fact.source_artifact_id ? [`artifact:${fact.source_artifact_id}`] : [])
          ]
        })),
        coverage: {
          scope: "current_work+explicit_dependencies+path_matched_repo_facts",
          included_count: scoped.length,
          matched_count: matching.length,
          omitted: [
            { reason: "other_verified_scopes_excluded", count: Math.max(0, totalVerified - scoped.length) },
            { reason: "candidate_and_nonverified_facts_excluded", count: null }
          ]
        },
        next_cursor: nextOffset < matching.length ? encodeFactCursor(task_id, normalizedQuery, nextOffset) : null
      });
    } catch (error) {
      return errorResult(error);
    }
  }
);

server.registerTool(
  "get_worker_goal",
  {
    title: "Get worker goal",
    description:
      "Read the goal recorded for a worker, plus the native Codex thread goal when the thread has one (status, tokens used, time used).",
    inputSchema: {
      task_id: z.string().min(1)
    }
  },
  async ({ task_id }) => {
    const task = await getTask(task_id);
    if (!task) return textResult({ error: "task_not_found", task_id });
    return textResult({
      task_id,
      thread_id: task.thread_id,
      status: task.status,
      objective: task.goal_objective,
      token_budget: task.goal_token_budget,
      goal_status: task.goal_status,
      needs_attention: isGoalNeedingAttention(task.goal_status),
      native_goal: readNativeGoal(task.thread_id),
      native_goal_read: readNativeGoalState(task.thread_id)
    });
  }
);

server.registerTool(
  "get_worker_summary",
  {
    title: "Get worker summary",
    description:
      "One compact summary per worker: goal, status, changed files, last command, last message. Cheap enough for a main thread to read every worker at the end of a run.",
    inputSchema: {
      task_id: z.string().min(1)
    }
  },
  async ({ task_id }) => {
    const task = await getTask(task_id);
    if (!task) return textResult({ error: "task_not_found", task_id });
    const summary = buildWorkerSummary(task, readNativeGoal(task.thread_id));
    // Cache the worktree diff on the row once the worker is done, so the
    // overview's count stops lagging. A running row is the runner's to write.
    if (TERMINAL_STATUSES.has(task.status) && summary.changed_files.length !== (task.changed_files ?? []).length) {
      await recordTerminalChangedFiles(task.id, summary.changed_files);
    }
    return textResult(summary);
  }
);

server.registerTool(
  "get_worker_result",
  {
    title: "Get worker result",
    description:
      "Read a worker's own final report. The overview and the wait response clip the last message; this is the door for the actual conclusion. Returns the last N agent messages (each clipped past maxChars, default 6000 bytes, with truncated: true and the full size so you can re-read it whole), the status fields that tell a real finish from a crash, verification (the commands the worker ran, their exit codes and the tail of any failing output, to hold its report against), acceptance (the supervisor's own run of the dispatch-time acceptance commands, independent of the report: configured, passed, and each check's exit code and output tail; passed: false means resume the worker with that output instead of reading its report, passed: true against a report that says blocked or not done means trust the checks and read the diff), changed_file_count, and base_behind (how many commits the project's HEAD is past the worktree's base; resume with rebaseOnto when it is not 0). includeFiles: true adds the changed_files list; get_worker_diff is the ground truth for what changed.",
    inputSchema: {
      task_id: z.string().min(1),
      limit: z.number().int().min(1).max(20).default(1),
      // Per report, UTF-8 bytes. 0 means no clipping.
      maxChars: z.number().int().min(0).max(1000000).default(6000),
      includeFiles: z.boolean().default(false)
    }
  },
  async ({ task_id, limit, maxChars, includeFiles }) => {
    const task = await getTask(task_id);
    if (!task) return textResult({ error: "task_not_found", task_id });
    let reports = await readAgentMessages(task_id, limit);
    let source = "event_stream";
    if (reports.length === 0 && task.last_message) {
      // Older rows can predate this tool, but the task row keeps the newest
      // report even when the stream query finds nothing.
      reports = [task.last_message];
      source = "task_row";
    }
    const reportBytes = reports.map((text) => Buffer.byteLength(text, "utf8"));
    const clipped = maxChars === 0 ? reports : reports.map((text) => truncateReport(text, maxChars));
    const truncated = clipped.some((text, index) => text !== reports[index]);
    const changed = readTaskChanges(task);
    const behind = task.worktree_path ? baseBehind(task.project_root, task.base_commit) : null;
    // A worker that ran in place has no worktree to diff, so this list is
    // the only record of what it touched; it is never hidden for those.
    const listFiles = includeFiles || !task.worktree_path;
    return textResult({
      task_id,
      title: task.title,
      status: task.status,
      phase: task.phase ?? null,
      exit_code: task.exit_code ?? null,
      thread_id: task.thread_id,
      session_id: task.session_id ?? null,
      workspace_kind: task.workspace_kind ?? "legacy",
      worktree_path: task.worktree_path,
      goal_status: task.goal_status,
      attention_reason: task.attention_reason ?? null,
      run_evidence: runEvidenceView(task),
      structured_report: reportView(task, maxChars),
      input_context: task.input_context ?? null,
      external_outputs: externalOutputView(task, maxChars || 6000),
      changed_file_count: changed.length,
      changed_files: listFiles ? changed : undefined,
      base_commit: task.base_commit ?? null,
      base_behind: behind,
      landed: task.landed_at ? { at: task.landed_at, head: task.landed_head ?? null } : null,
      acceptance: acceptanceView(task, behind),
      verification: summarizeVerification(task),
      report_count: clipped.length,
      report_bytes: reportBytes,
      truncated,
      next_step: truncated
        ? `a report was clipped to ${maxChars} bytes; call again with maxChars: ${Math.max(...reportBytes)} (or 0) to read it whole`
        : null,
      reports: clipped,
      source,
      error: task.error ?? null,
      completed_at: task.completed_at ?? null
    });
  }
);

server.registerTool(
  "get_worker_diff",
  {
    title: "Get worker diff",
    description:
      "The worker's actual changes as patches: everything between the commit its worktree started from and its working tree, committed or not, plus untracked files. This is the ground truth to check a worker's report against. maxChars bounds the whole answer: files past the budget come back listed but without a patch, so the file list is always complete. paths narrows the diff to those files or directories.",
    inputSchema: {
      task_id: z.string().min(1),
      maxChars: z.number().int().min(0).max(1000000).default(60000),
      paths: z.array(z.string().min(1)).optional()
    }
  },
  async ({ task_id, maxChars, paths }) => {
    const task = await getTask(task_id);
    if (!task) return textResult({ error: "task_not_found", task_id });
    if (!task.worktree_path) {
      return textResult({ error: "no_worktree", task_id, external_outputs: externalOutputView(task, maxChars), reason: "this worker ran in place (its cwd is not a git repository or the worktree could not be created), so there is no isolated diff to read; call get_worker_result with includeFiles: true for the files it touched" });
    }
    const diff = readWorktreeDiff(task.worktree_path, worktreeRef(task), { maxChars, paths: paths ?? [] });
    return textResult({
      task_id,
      title: task.title,
      status: task.status,
      worktree_path: task.worktree_path,
      branch: `codex/${task.id}`,
      ...diff,
      external_outputs: externalOutputView(task, maxChars)
    });
  }
);

server.registerTool(
  "ask_codex_worker",
  {
    title: "Ask a worker on the side",
    description:
      "Ask a finished or running worker a question without touching its thread: the worker's Codex thread is forked once into a read-only side session (like Codex's own /btw), the question is asked there, and later questions resume that fork. The fork carries everything the worker saw and did, so 'why did you change X' or 'where is Y handled' costs one short answer instead of a read of the event stream. The fork has no network and no MCP tools and is told so; it answers from its context and the worktree. Once the worker has been resumed, the next question automatically takes a new fork from the updated thread (refreshed: \"worker_resumed\"); fresh: true forces a new fork. Changes still go through resume_codex_worker. Without a question it returns the latest side turn (for an answer that outran timeoutMs). end: true deletes the fork.",
    inputSchema: {
      task_id: z.string().min(1),
      question: z.string().min(1).optional(),
      timeoutMs: z.number().int().min(1000).max(600000).default(110000),
      maxChars: z.number().int().min(0).max(1000000).default(8000),
      fresh: z.boolean().default(false),
      end: z.boolean().default(false)
    }
  },
  async ({ task_id, question, timeoutMs, maxChars, fresh, end }) => {
    const task = await getTask(task_id);
    if (!task) return textResult({ error: "task_not_found", task_id });
    const clipAnswer = (state) => {
      if (state?.turn?.answer && maxChars !== undefined) state.turn.answer = truncateMiddleChars(state.turn.answer, maxChars);
      return state;
    };
    if (end) {
      const ended = await endSideSession(task_id);
      return textResult({ task_id, ...ended });
    }
    if (!question) {
      return textResult({ task_id, ...clipAnswer(await latestSideTurn(task_id)) });
    }
    try {
      const state = clipAnswer(await askWorker({ task, question, timeoutMs, fresh }));
      const next = state.timed_out
        ? `The side turn is still running; call ask_codex_worker again with only task_id to read the answer when it lands.`
        : null;
      return textResult({ task_id, ...state, next_step: next });
    } catch (error) {
      if (error.code === "busy") {
        return textResult({ task_id, error: "busy", reason: error.message, ...clipAnswer(await latestSideTurn(task_id)) });
      }
      return textResult({ task_id, error: error.code ?? "side_turn_failed", reason: error.message });
    }
  }
);

server.registerTool(
  "land_codex_worker",
  {
    title: "Land a worker's commits",
    description:
      "Cherry-pick the commits a worker made on its codex/<taskId> branch onto the current branch of the directory it was dispatched from. The target must be clean and is never switched to another branch; `onto` is a guard that names the branch you expect to be on. A conflict aborts the cherry-pick, lists the files, and leaves the target as it was. A worker in the workspace-write sandbox cannot commit (Codex keeps .git read-only there): pass commitMessage and its uncommitted edits are committed as one commit on its branch first, then landed. Without commitMessage uncommitted edits are reported, not landed. Check the work first with get_worker_result and get_worker_diff; land once it passes. Refuses with acceptance_failed while the worker's last acceptance run failed (and acceptance_not_run while one is running or was interrupted): resume it with the failing output, land once it passes. ignoreAcceptance: true lands anyway; use it only when the user said to land regardless.",
    inputSchema: {
      task_id: z.string().min(1),
      onto: z.string().min(1).optional(),
      commitMessage: z.string().min(1).optional(),
      ignoreAcceptance: z.boolean().default(false),
      allowOutsideOwned: z.boolean().default(false)
    }
  },
  async ({ task_id, onto, commitMessage, ignoreAcceptance, allowOutsideOwned }) => {
    const task = await getTask(task_id);
    if (!task) return textResult({ error: "task_not_found", task_id });
    if (task.workspace_kind && task.workspace_kind !== "legacy" && task.workspace_kind !== "git_worktree") {
      return textResult({ error: "workspace_kind_not_landable", task_id, workspace_kind: task.workspace_kind, reason: `${task.workspace_kind} does not create a Git worktree and cannot be landed` });
    }
    const session = task.session_id ? await getSession(task.session_id) : null;
    if (task.attention_reason === "invalid_report") return textResult({ error: "invalid_report", task_id, reason: task.error });
    if (!isSettled(task)) return textResult({ error: "worker_active", task_id, reason: "wait for this run and acceptance to settle before landing" });
    if (session?.approval_state === "waiting_user") return textResult({ error: "session_waiting_user", task_id, reason: "session requires user approval before landing" });
    if (session && task.session_policy_revision !== session.policy_revision) return textResult({ error: "session_policy_stale", task_id, current_revision: session.policy_revision, checked_revision: task.session_policy_revision, reason: "requirements changed; resume with the current objective and rerun acceptance before landing" });
    const outcome = landWorker(task, { onto, commitMessage: commitMessage ?? null, ignoreAcceptance, allowOutsideOwned });
    if (!outcome.error) {
      // Recorded so a later read knows the work is on the branch: the
      // board shows it, and base_behind after this is not drift.
      const now = new Date().toISOString();
      const landed = { ...task, landed_at: now, landed_head: outcome.head ?? null, landed_branch: outcome.onto ?? null, updated_at: now };
      await upsertTask(landed);
      await updateWorkItemDelivery(task_id, "landed");
      const event = await appendTaskEvent(task_id, {
        type: "supervisor.landed",
        head: outcome.head ?? null,
        branch: outcome.onto ?? null,
        target: outcome.target ?? null,
        landed_at: now
      }, { runId: runIdFor(task_id, task.run_count ?? 1), actor: "supervisor" });
      const workItem = await getWorkItemForTask(task_id);
      if (workItem && outcome.head) {
        await recordFact({
          workItemId: workItem.id,
          scopeType: "work_item",
          scopeId: workItem.id,
          key: "landed",
          value: { head: outcome.head, branch: outcome.onto ?? null },
          state: "verified",
          sourceEventId: event.id,
          validForSha: outcome.head,
          watchedPaths: task.owned_paths ?? []
        });
      }
    }
    return textResult({ task_id, title: task.title, status: task.status, branch: `codex/${task.id}`, ...outcome });
  }
);

server.registerTool(
  "verify_delivery_push",
  {
    title: "Verify landed work reached a remote branch",
    description: "Fetch a remote branch and prove the worker's landed_head is reachable from it. This never pushes or deploys. A passing check records push_verified; cleanup eligibility may depend on this evidence.",
    inputSchema: {
      task_id: z.string().min(1),
      remote: z.string().min(1).default("origin"),
      branch: z.string().min(1).optional()
    }
  },
  async ({ task_id, remote, branch }) => {
    const task = await getTask(task_id);
    if (!task) return textResult({ error: "task_not_found", task_id });
    const targetBranch = branch ?? task.landed_branch;
    if (!task.landed_at || !task.landed_head || !targetBranch) {
      return textResult({ error: "not_landed", task_id, reason: "land the worker first; this task has no landed head and branch to verify" });
    }
    try {
      git(task.project_root, ["remote", "get-url", remote]);
      git(task.project_root, ["fetch", "--no-tags", remote, `refs/heads/${targetBranch}`]);
      const remoteHead = git(task.project_root, ["rev-parse", "FETCH_HEAD"]);
      try {
        git(task.project_root, ["merge-base", "--is-ancestor", task.landed_head, remoteHead]);
      } catch {
        return textResult({
          error: "not_pushed",
          task_id,
          remote,
          branch: targetBranch,
          landed_head: task.landed_head,
          remote_head: remoteHead,
          reason: "landed_head is not reachable from the fetched remote branch"
        });
      }
      const now = new Date().toISOString();
      const verified = { ...task, push_verified_at: now, push_remote: remote, push_branch: targetBranch, push_remote_head: remoteHead, updated_at: now };
      await upsertTask(verified);
      await updateWorkItemDelivery(task_id, "push_verified");
      const event = await appendTaskEvent(task_id, {
        type: "supervisor.push_verified",
        remote,
        branch: targetBranch,
        landed_head: task.landed_head,
        remote_head: remoteHead,
        verified_at: now
      }, { runId: runIdFor(task_id, task.run_count ?? 1), actor: "supervisor" });
      const artifact = await recordJsonArtifact({
        runId: runIdFor(task_id, task.run_count ?? 1),
        type: "push_proof",
        value: { remote, branch: targetBranch, landed_head: task.landed_head, remote_head: remoteHead, verified_at: now, event_id: event.id },
        securityClass: "internal"
      });
      const workItem = await getWorkItemForTask(task_id);
      if (workItem) {
        await recordFact({
          workItemId: workItem.id,
          scopeType: "work_item",
          scopeId: workItem.id,
          key: "push_verified",
          value: { remote, branch: targetBranch, landed_head: task.landed_head, remote_head: remoteHead },
          state: "verified",
          sourceEventId: event.id,
          sourceArtifactId: artifact.id,
          validForSha: task.landed_head,
          watchedPaths: task.owned_paths ?? [],
          verifiedBy: "supervisor.remote_readback"
        });
      }
      const cleanupPlan = await createCleanupPlan({ taskIds: [task_id] });
      await saveCleanupPlan(cleanupPlan);
      return textResult({
        task_id,
        remote,
        branch: targetBranch,
        landed_head: task.landed_head,
        remote_head: remoteHead,
        artifact_id: artifact.id,
        push_verified_at: now,
        cleanup_plan: { id: cleanupPlan.id, summary: cleanupPlan.summary, expires_at: cleanupPlan.expires_at, next_step: "Review SAFE items, then call apply_cleanup with their item IDs; cleanup is never automatic." }
      });
    } catch (error) {
      return textResult({ error: "push_verification_failed", task_id, remote, branch: targetBranch, reason: error.message.split("\n")[0] });
    }
  }
);

server.registerTool(
  "cleanup_plan",
  {
    title: "Plan safe worktree cleanup",
    description: "Classify managed worktrees as safe, review or blocked. The plan is read-only, expires after 15 minutes, estimates reclaimable bytes and never deletes branches, task rows, events, JSONL logs or artifacts.",
    inputSchema: {
      task_ids: z.array(z.string().min(1)).max(200).optional(),
      project_root: z.string().min(1).optional()
    }
  },
  async ({ task_ids, project_root }) => {
    try {
      const plan = await createCleanupPlan({ taskIds: task_ids ?? null, projectRoot: project_root ?? null });
      await saveCleanupPlan(plan);
      return textResult({
        plan_id: plan.id,
        generated_at: plan.generated_at,
        expires_at: plan.expires_at,
        policy: plan.policy,
        summary: plan.summary,
        items: plan.items
      });
    } catch (error) {
      return errorResult(error);
    }
  }
);

server.registerTool(
  "apply_cleanup",
  {
    title: "Apply a safe cleanup plan",
    description: "Remove only selected SAFE worktrees from an unexpired cleanup plan after a second proof check. Uses git worktree remove and prune only; retains the branch, task row, event stream, JSONL log and artifacts.",
    inputSchema: {
      plan_id: z.string().uuid(),
      item_ids: z.array(z.string().uuid()).min(1).max(200)
    }
  },
  async ({ plan_id, item_ids }) => {
    const plan = await getCleanupPlan(plan_id);
    if (!plan) return textResult({ error: "cleanup_plan_not_found", plan_id });
    if (Date.parse(plan.expires_at) <= Date.now()) return textResult({ error: "cleanup_plan_expired", plan_id, expires_at: plan.expires_at });
    return textResult(await applyCleanupPlan({ plan, itemIds: item_ids, actor: "main_thread" }));
  }
);

server.registerTool(
  "cleanup_history",
  {
    title: "Read cleanup history",
    description: "Read cleanup plan decisions and applied worktree removals, including safe/review/blocked reasons. This is audit history, not a delete command.",
    inputSchema: { task_id: z.string().min(1).optional(), limit: z.number().int().min(1).max(500).default(100) }
  },
  async ({ task_id, limit }) => textResult({ items: await readCleanupHistory(task_id ?? null, limit) })
);

server.registerTool(
  "cancel_codex_worker",
  {
    title: "Cancel Codex worker",
    description:
      "Terminate a running Codex worker. Uses the in-process handle when available, otherwise the pid recorded on disk so a different MCP session can still cancel it.",
    inputSchema: {
      task_id: z.string().min(1)
    }
  },
  async ({ task_id }) => {
    const now = new Date().toISOString();
    const task = await getTask(task_id);
    // The marker is persisted before the signal is sent so the process that
    // owns the worker reports "cancelled" instead of "lost" when it exits.
    if (task && ACTIVE_STATUSES.has(task.status)) {
      await upsertTask({ ...task, cancel_requested_at: now, updated_at: now });
    }
    const result = await cancelCodexWorker(task_id);
    // A cancel that stopped an acceptance run leaves the worker's own
    // terminal status in place; the exit handler records the verdict.
    if (result.cancelled && task && result.via !== "acceptance") {
      await upsertTask({
        ...task,
        status: "cancelled",
        phase: null,
        cancel_requested_at: now,
        updated_at: now,
        completed_at: task.completed_at ?? now
      });
    }
    return textResult(result);
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
