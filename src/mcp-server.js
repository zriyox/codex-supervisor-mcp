#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { cancelCodexWorker, createCodexWorker, createFollowupWorker } from "./codex-runner.js";
import { getTask, getTasks, readTaskEvents, readTasks, reconcileDetachedActiveTasks, upsertTask } from "./task-store.js";

const server = new McpServer({
  name: "codex-supervisor",
  version: "0.1.0"
});
const ACTIVE_STATUSES = new Set(["queued", "running", "editing", "command", "command_completed", "reporting"]);
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

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

function summarizeTask(task) {
  const lastMessage = task.last_message ? `${task.last_message.slice(0, 240)}${task.last_message.length > 240 ? "..." : ""}` : null;
  return {
    id: task.id,
    title: task.title,
    worker: task.worker,
    status: task.status,
    phase: task.phase,
    cwd: task.cwd,
    project_root: task.project_root,
    sandbox: task.sandbox,
    model: task.model,
    reasoning_effort: task.reasoning_effort ?? "high",
    followup_of: task.followup_of,
    worktree_path: task.worktree_path,
    changed_file_count: (task.changed_files ?? []).length,
    command_count: (task.commands ?? []).length,
    current_action: task.current_action,
    current_command: task.current_command,
    last_event_type: task.last_event_type,
    last_message: lastMessage,
    error: task.error,
    created_at: task.created_at,
    updated_at: task.updated_at,
    started_at: task.started_at,
    completed_at: task.completed_at,
    exit_code: task.exit_code
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

server.registerTool(
  "create_codex_worker",
  {
    title: "Create Codex worker",
    description: "Launch a Codex CLI worker with codex exec --json and track its item events.",
    inputSchema: {
      title: z.string().optional(),
      task: z.string().min(1),
      cwd: z.string().min(1),
      sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).default("workspace-write"),
      model: z.string().optional(),
      reasoningEffort: z.enum(["minimal", "low", "medium", "high"]).default("high"),
      skipGitRepoCheck: z.boolean().default(true)
    }
  },
  async (input) => textResult(await createCodexWorker(input))
);

server.registerTool(
  "create_codex_followup_worker",
  {
    title: "Create Codex follow-up worker",
    description: "Create a new Codex worker seeded with the previous worker's prompt, status, and recent events.",
    inputSchema: {
      task_id: z.string().min(1),
      followup_prompt: z.string().min(1),
      title: z.string().optional(),
      cwd: z.string().optional(),
      sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional(),
      model: z.string().optional(),
      reasoningEffort: z.enum(["minimal", "low", "medium", "high"]).default("high")
    }
  },
  async ({ task_id, followup_prompt, ...options }) =>
    textResult(await createFollowupWorker({ taskId: task_id, followupPrompt: followup_prompt, ...options }))
);

server.registerTool(
  "list_codex_workers",
  {
    title: "List Codex workers",
    description: "List all tracked Codex workers and their latest status.",
    inputSchema: {
      status: z.string().optional(),
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
  "wait_codex_workers",
  {
    title: "Wait for Codex workers",
    description: "Block until selected Codex workers complete, fail, or are cancelled, then return summaries to Claude.",
    inputSchema: {
      task_ids: z.array(z.string().min(1)).min(1),
      mode: z.enum(["any", "all"]).default("all"),
      timeoutMinutes: z.number().int().min(1).max(360).default(30),
      timeoutMs: z.number().int().min(1000).max(21600000).optional(),
      pollMs: z.number().int().min(250).max(10000).default(1000),
      includeEvents: z.boolean().default(true),
      eventLimit: z.number().int().min(1).max(50).default(10)
    }
  },
  async ({ task_ids, mode, timeoutMinutes, timeoutMs, pollMs, includeEvents, eventLimit }) => {
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
    const timedOut = mode === "any"
      ? terminalTasks.length === 0
      : terminalTasks.length !== task_ids.length;

    const summaries = await Promise.all(tasks.map(async (task) => ({
      ...summarizeTask(task),
      recent_events: includeEvents ? await readTaskEvents(task.id, eventLimit) : undefined
    })));

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
      active_count: tasks.filter((task) => ACTIVE_STATUSES.has(task.status)).length,
      workers: summaries
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
    description: "Read recent raw Codex JSONL events for one worker.",
    inputSchema: {
      task_id: z.string().min(1),
      limit: z.number().int().min(1).max(1000).default(100)
    }
  },
  async ({ task_id, limit }) => textResult(await readTaskEvents(task_id, limit))
);

server.registerTool(
  "cancel_codex_worker",
  {
    title: "Cancel Codex worker",
    description: "Terminate a running Codex worker process if it is still attached to this MCP server process.",
    inputSchema: {
      task_id: z.string().min(1)
    }
  },
  async ({ task_id }) => {
    const result = await cancelCodexWorker(task_id);
    if (result.cancelled) {
      const task = await getTask(task_id);
      if (task) {
        await upsertTask({
          ...task,
          status: "cancelled",
          phase: "cancelled",
          updated_at: new Date().toISOString(),
          completed_at: new Date().toISOString()
        });
      }
    }
    return textResult(result);
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
