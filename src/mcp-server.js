#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  cancelCodexWorker,
  createCodexWorker,
  createFollowupWorker,
  resumeCodexWorker
} from "./codex-runner.js";
import {
  getSession,
  getTask,
  getTasks,
  isPidAlive,
  listTaskEventKinds,
  readAgentMessages,
  readTaskEvents,
  readTasks,
  readTasksBySession,
  reconcileDetachedActiveTasks,
  recordTerminalChangedFiles,
  searchTasks,
  upsertSession,
  upsertTask
} from "./task-store.js";
import { readNativeGoal } from "./goal-store.js";
import { baseBehind, readTaskChanges, readWorktreeDiff, worktreeRef } from "./worktree.js";
import { summarizeVerification } from "./event-parser.js";
import { ACTIVE_STATUSES, TERMINAL_STATUSES, TASK_STATUSES, isGoalNeedingAttention } from "./status.js";
import { approxTokenCount, truncateEventStrings, truncateMiddleChars, truncateReport } from "./truncate.js";
import { checkForUpdate, updateNotice } from "./update-check.js";
import { syncSkills } from "./skill-sync.js";
import { maybeAutoUpdate } from "./auto-update.js";
import { askWorker, endSideSession, latestSideTurn } from "./side-chat.js";
import { landWorker } from "./landing.js";

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
  { title: 12, goal: 16, action: 16, path: 16 }
];

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
  if (task.status !== "completed" && task.status !== "failed") return true;
  if (task.exit_code !== null && task.exit_code !== undefined) return true;
  return !isPidAlive(task.pid);
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

function summarizeTask(task) {
  return {
    id: task.id,
    title: task.title,
    worker: task.worker,
    status: task.status,
    phase: task.phase ?? null,
    cwd: task.cwd,
    project_root: task.project_root,
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
    changed_file_count: (task.changed_files ?? []).length,
    command_count: (task.commands ?? []).length,
    run_count: task.run_count ?? 0,
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
        .filter((task) => task.status === "running" && isGoalNeedingAttention(task.goal_status))
        .map((task) => task.id),
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

server.registerTool(
  "create_codex_worker",
  {
    title: "Create Codex worker",
    description:
      "Launch a Codex CLI worker with codex exec --json and track its events. ownedPaths and goal are required: ownedPaths reserves the files this worker may write, goal records what the worker is for.",
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
      ownedPaths: z.array(z.string().min(1)).min(1),
      goal: z.object({
        objective: z.string().min(1),
        tokenBudget: z.number().int().positive().optional()
      }),
      dependsOn: z.array(z.string().min(1)).optional(),
      // Which commit the worktree is cut from. Defaults to the repository's
      // HEAD; pass a branch, tag or sha to build on work that is not on the
      // main line yet (for example another worker's codex/<id> branch).
      baseRef: z.string().min(1).optional()
    }
  },
  async (input) => {
    try {
      const record = await createCodexWorker({
        ...input,
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
      goal: z
        .object({
          objective: z.string().min(1),
          tokenBudget: z.number().int().positive().optional()
        })
        .optional(),
      baseRef: z.string().min(1).optional()
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
      "Continue the SAME Codex session for an existing worker via `codex exec resume <thread_id>`. Works from a different MCP process or a fresh client session as long as the task recorded a thread_id. The worktree stays on the commit it was cut from unless rebaseOnto names a ref (resolved in the project directory, e.g. HEAD or main): uncommitted edits are stashed, the worker's own commits are replayed onto it, the stash comes back and base_commit moves, so the worker continues on current code. A conflict in either step puts the worktree back as it was, lists the files and does not start the worker. The receipt carries base_behind: how many commits the project's HEAD is past the worktree's base.",
    inputSchema: {
      task_id: z.string().min(1),
      prompt: z.string().min(1),
      rebaseOnto: z.string().min(1).optional()
    }
  },
  async ({ task_id, prompt, rebaseOnto }) => {
    try {
      const record = await resumeCodexWorker({ taskId: task_id, prompt, rebaseOnto: rebaseOnto ?? null });
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
      "Block until selected Codex workers reach a terminal status, then return summaries. The wait budget bounds this call, not the workers: when it runs out you get a progress snapshot and the workers keep running, so call this again with the same task_ids to keep waiting. Keep the budget under your client's MCP tool timeout, or the client kills the call instead of the wait returning. compact: true returns one line per worker: status, phase, exit_code, changed_file_count, plus idle_seconds since the last Codex event of this run, command_running and current_command. Codex emits nothing while a command runs or while the model thinks, so a long idle with command_running: true is a long command and a long idle without it is thinking (or a process that reconcile will report as lost).",
    inputSchema: {
      task_ids: z.array(z.string().min(1)).min(1),
      mode: z.enum(["any", "all"]).default("all"),
      timeoutMinutes: z.number().int().min(1).max(360).default(2),
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
      compact: z.boolean().default(false)
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
    compact
  }) => {
    const startedAt = Date.now();
    const effectiveTimeoutMs = timeoutMs ?? timeoutMinutes * 60 * 1000;
    let tasks = [];

    while (Date.now() - startedAt < effectiveTimeoutMs) {
      await reconcileDetachedActiveTasks();
      tasks = (await getTasks(task_ids)).filter(Boolean);
      const settledCount = tasks.filter(isSettled).length;
      const isDone = mode === "any" ? settledCount > 0 : settledCount === task_ids.length;
      if (isDone) break;
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
      workers: compact
        ? tasks.map((task) => ({
            id: task.id,
            title: clip(task.title, 60),
            status: task.status,
            phase: task.phase ?? null,
            exit_code: task.exit_code ?? null,
            changed_file_count: readTaskChanges(task).length,
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
      note: z.string().min(1).max(2000).optional()
    }
  },
  async ({ session_id, title, note }) => {
    const row = await upsertSession({ id: session_id, title: title ?? null, note: note ?? null });
    return textResult({ session_id, title: row?.title ?? null, note: row?.note ?? null, updated_at: row?.updated_at ?? null });
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
      native_goal: readNativeGoal(task.thread_id)
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
      "Read a worker's own final report. The overview and the wait response clip the last message; this is the door for the actual conclusion. Returns the last N agent messages (each clipped past maxChars, default 6000 bytes, with truncated: true and the full size so you can re-read it whole), the status fields that tell a real finish from a crash, verification (the commands the worker ran, their exit codes and the tail of any failing output, to hold its report against), changed_file_count, and base_behind (how many commits the project's HEAD is past the worktree's base; resume with rebaseOnto when it is not 0). includeFiles: true adds the changed_files list; get_worker_diff is the ground truth for what changed.",
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
      worktree_path: task.worktree_path,
      goal_status: task.goal_status,
      changed_file_count: changed.length,
      changed_files: listFiles ? changed : undefined,
      base_commit: task.base_commit ?? null,
      base_behind: task.worktree_path ? baseBehind(task.project_root, task.base_commit) : null,
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
      return textResult({ error: "no_worktree", task_id, reason: "this worker ran in place (its cwd is not a git repository or the worktree could not be created), so there is no isolated diff to read; call get_worker_result with includeFiles: true for the files it touched" });
    }
    const diff = readWorktreeDiff(task.worktree_path, worktreeRef(task), { maxChars, paths: paths ?? [] });
    return textResult({
      task_id,
      title: task.title,
      status: task.status,
      worktree_path: task.worktree_path,
      branch: `codex/${task.id}`,
      ...diff
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
      "Cherry-pick the commits a worker made on its codex/<taskId> branch onto the current branch of the directory it was dispatched from. The target must be clean and is never switched to another branch; `onto` is a guard that names the branch you expect to be on. A conflict aborts the cherry-pick, lists the files, and leaves the target as it was. A worker in the workspace-write sandbox cannot commit (Codex keeps .git read-only there): pass commitMessage and its uncommitted edits are committed as one commit on its branch first, then landed. Without commitMessage uncommitted edits are reported, not landed. Check the work first with get_worker_result and get_worker_diff; land once it passes.",
    inputSchema: {
      task_id: z.string().min(1),
      onto: z.string().min(1).optional(),
      commitMessage: z.string().min(1).optional()
    }
  },
  async ({ task_id, onto, commitMessage }) => {
    const task = await getTask(task_id);
    if (!task) return textResult({ error: "task_not_found", task_id });
    return textResult({ task_id, title: task.title, status: task.status, branch: `codex/${task.id}`, ...landWorker(task, { onto, commitMessage: commitMessage ?? null }) });
  }
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
    if (result.cancelled && task) {
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
