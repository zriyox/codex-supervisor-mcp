import { buildHostGoalSync } from "../../../domain/prompt.js";
import { ACTIVE_STATUSES, TASK_STATUSES } from "../../../domain/status.js";
import { truncateEventStrings } from "../../../domain/truncate.js";
import { getSession, upsertSession } from "../../../infra/store/sessions.js";
import { getTask, readTasks, readTasksBySession, searchTasks } from "../../../infra/store/tasks.js";
import { listTaskEventKinds, readTaskEvents } from "../../../infra/store/events.js";
import { reconcileDetachedActiveTasks } from "../../../infra/store/reconcile.js";
import { packageVersion } from "../meta.js";
import { errorResult, textResult } from "../result.js";
import { acceptanceCheck } from "../schemas.js";
import { autoUpdateState, refreshUpdateState, updateField, updateState } from "../update-state.js";
import { buildOverview, workRow } from "../views/overview.js";
import { statusView, summarizeTask } from "../views/task.js";
import { z } from "zod";

export const listCodexWorkersTool = [
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
];

export const getOrchestrationOverviewTool = [
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
];

export const getSessionWorksTool = [
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
];

export const checkForUpdateTool = [
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
];

export const describeSessionTool = [
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
];

export const searchWorksTool = [
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
];

export const getCodexWorkerStatusTool = [
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
];

export const getCodexWorkerEventsTool = [
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
];
