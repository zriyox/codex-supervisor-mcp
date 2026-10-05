#!/usr/bin/env node
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
  getTask,
  getTasks,
  listTaskEventKinds,
  readTaskEvents,
  readTasks,
  readTasksBySession,
  reconcileDetachedActiveTasks,
  searchTasks,
  upsertTask
} from "./task-store.js";
import { readNativeGoal } from "./goal-store.js";
import { mergeChangedFiles, readWorktreeChanges } from "./worktree.js";
import { ACTIVE_STATUSES, TERMINAL_STATUSES, TASK_STATUSES, isGoalNeedingAttention } from "./status.js";
import { approxTokenCount, truncateEventStrings } from "./truncate.js";

const server = new McpServer({
  name: "codex-supervisor",
  version: "0.4.0"
});

const OVERVIEW_BYTE_BUDGET = 7000;
const OVERVIEW_CAP_LEVELS = [
  { title: 40, goal: 60, action: 60, path: 60 },
  { title: 28, goal: 40, action: 40, path: 40 },
  { title: 18, goal: 24, action: 24, path: 24 },
  { title: 12, goal: 16, action: 16, path: 16 }
];

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
    current_action: task.current_action,
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

function overviewRow(task, caps) {
  return {
    id: task.id,
    title: clip(task.title, caps.title),
    status: task.status,
    phase: task.phase ?? null,
    goal: clip(task.goal_objective, caps.goal),
    goal_status: task.goal_status ?? null,
    last_action: clip(task.current_action, caps.action),
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

function buildOverview(tasks) {
  let payload;
  for (const [index, caps] of OVERVIEW_CAP_LEVELS.entries()) {
    payload = {
      generated_at: new Date().toISOString(),
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
  const changed = mergeChangedFiles(task.changed_files, readWorktreeChanges(task.worktree_path));
  const commands = task.commands ?? [];
  const lines = [
    `${task.title ?? task.id} — status=${task.status}${task.phase ? `, phase=${task.phase}` : ""}`,
    `goal: ${task.goal_objective ?? "-"}${task.goal_token_budget ? ` (budget ${task.goal_token_budget} tokens)` : ""}`,
    nativeGoal
      ? `codex goal: ${nativeGoal.status}, ${nativeGoal.tokens_used} tokens used, ${nativeGoal.time_used_seconds}s elapsed`
      : "codex goal: none recorded for this thread",
    `changed files (${changed.length}): ${changed.slice(0, 10).join(", ") || "-"}`,
    `last command: ${commands.at(-1)?.command ?? "-"}`,
    `last action: ${task.current_action ?? "-"}`,
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
    ...(error.conflicts ? { conflicts: error.conflicts } : {})
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
      sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).default("workspace-write"),
      model: z.string().optional(),
      reasoningEffort: z.enum(["minimal", "low", "medium", "high"]).default("high"),
      skipGitRepoCheck: z.boolean().default(true),
      ownedPaths: z.array(z.string().min(1)).min(1),
      goal: z.object({
        objective: z.string().min(1),
        tokenBudget: z.number().int().positive().optional()
      }),
      dependsOn: z.array(z.string().min(1)).optional()
    }
  },
  async (input) => {
    try {
      return textResult(await createCodexWorker({ ...input, sessionId: input.session_id ?? null }));
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
        .optional()
    }
  },
  async ({ task_id, followup_prompt, session_id, ...options }) => {
    try {
      return textResult(
        await createFollowupWorker({
          taskId: task_id,
          followupPrompt: followup_prompt,
          sessionId: session_id ?? null,
          ...options
        })
      );
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
      "Continue the SAME Codex session for an existing worker via `codex exec resume <thread_id>`. Works from a different MCP process or a fresh client session as long as the task recorded a thread_id.",
    inputSchema: {
      task_id: z.string().min(1),
      prompt: z.string().min(1)
    }
  },
  async ({ task_id, prompt }) => {
    try {
      return textResult(await resumeCodexWorker({ taskId: task_id, prompt }));
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
    return textResult(buildOverview(filtered));
  }
);

server.registerTool(
  "wait_codex_workers",
  {
    title: "Wait for Codex workers",
    description: "Block until selected Codex workers reach a terminal status, then return summaries.",
    inputSchema: {
      task_ids: z.array(z.string().min(1)).min(1),
      mode: z.enum(["any", "all"]).default("all"),
      timeoutMinutes: z.number().int().min(1).max(360).default(30),
      timeoutMs: z.number().int().min(1000).max(21600000).optional(),
      pollMs: z.number().int().min(250).max(10000).default(1000),
      includeEvents: z.boolean().default(true),
      eventLimit: z.number().int().min(1).max(50).default(10),
      eventMaxChars: z.number().int().min(0).max(1000000).optional(),
      eventKinds: z.array(z.string().min(1)).optional()
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
    eventKinds
  }) => {
    const startedAt = Date.now();
    const effectiveTimeoutMs = timeoutMs ?? timeoutMinutes * 60 * 1000;
    let tasks = [];

    while (Date.now() - startedAt < effectiveTimeoutMs) {
      await reconcileDetachedActiveTasks();
      tasks = (await getTasks(task_ids)).filter(Boolean);
      const terminalCount = tasks.filter((task) => TERMINAL_STATUSES.has(task.status)).length;
      const isDone = mode === "any" ? terminalCount > 0 : terminalCount === task_ids.length;
      if (isDone) break;
      await sleep(pollMs);
    }

    await reconcileDetachedActiveTasks();
    tasks = (await getTasks(task_ids)).filter(Boolean);
    const missingIds = task_ids.filter((taskId) => !tasks.some((task) => task.id === taskId));
    const terminalTasks = tasks.filter((task) => TERMINAL_STATUSES.has(task.status));
    const timedOut =
      mode === "any" ? terminalTasks.length === 0 : terminalTasks.length !== task_ids.length;

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

    return textResult({
      mode,
      timed_out: timedOut,
      waited_ms: Date.now() - startedAt,
      timeout_ms: effectiveTimeoutMs,
      timeout_minutes: Math.round(effectiveTimeoutMs / 60000),
      missing_ids: missingIds,
      completed_count: tasks.filter((task) => task.status === "completed").length,
      failed_count: tasks.filter((task) => task.status === "failed").length,
      cancelled_count: tasks.filter((task) => task.status === "cancelled").length,
      lost_count: tasks.filter((task) => task.status === "lost").length,
      active_count: tasks.filter((task) => ACTIVE_STATUSES.has(task.status)).length,
      workers: summaries
    });
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
    return textResult({
      session_id,
      count: tasks.length,
      active: tasks.filter((task) => ACTIVE_STATUSES.has(task.status)).length,
      works: tasks.map(workRow)
    });
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
    description: "Read the latest normalized status for one Codex worker.",
    inputSchema: {
      task_id: z.string().min(1)
    }
  },
  async ({ task_id }) => {
    const task = await getTask(task_id);
    if (!task) return textResult({ error: "task_not_found", task_id });
    return textResult(task);
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
    if (summary.changed_files.length !== (task.changed_files ?? []).length) {
      await upsertTask({ ...task, changed_files: summary.changed_files, updated_at: new Date().toISOString() });
    }
    return textResult(summary);
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
