import { buildHostGoalSync } from "../../../domain/prompt.js";
import { ACTIVE_STATUSES } from "../../../domain/status.js";
import { truncateEventStrings } from "../../../domain/truncate.js";
import { getSession, upsertSession } from "../../../infra/store/sessions.js";
import { getTask, readTasksBySession, searchTasks } from "../../../infra/store/tasks.js";
import { listTaskEventKinds, readTaskEvents } from "../../../infra/store/events.js";
import { errorResult, textResult } from "../result.js";
import { acceptanceCheck } from "../schemas.js";
import { workRow } from "../views/overview.js";
import { statusView } from "../views/task.js";
import { z } from "zod";

export const getSessionWorksOp = {
  input: z.object({
      session_id: z.string().min(1)
    }),
  handler: async ({ session_id }) => {
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
};

export const describeSessionOp = {
  input: z.object({
      session_id: z.string().min(1),
      title: z.string().min(1).max(120).optional(),
      note: z.string().min(1).max(2000).optional(),
      objective: z.string().min(1).max(5000).optional(),
      default_acceptance: z.array(acceptanceCheck).max(10).optional(),
      approval_state: z.enum(["approved", "waiting_user"]).optional(),
      expected_revision: z.number().int().nonnegative().optional()
    }),
  handler: async ({ session_id, title, note, objective, default_acceptance, approval_state, expected_revision }) => {
    try {
      const row = await upsertSession({
        id: session_id, title: title ?? null, note: note ?? null, objective,
        defaultAcceptance: default_acceptance, approvalState: approval_state, expectedRevision: expected_revision
      });
      return textResult({ ...row, session_id, host_goal_sync: buildHostGoalSync(row) });
    } catch (error) { return errorResult(error); }
  }
};

export const searchWorksOp = {
  input: z.object({
      query: z.string().min(1),
      limit: z.number().int().positive().max(100).default(20)
    }),
  handler: async ({ query, limit }) => {
    const tasks = await searchTasks(query, limit);
    return textResult({
      query,
      count: tasks.length,
      works: tasks.map(workRow)
    });
  }
};

export const getCodexWorkerStatusOp = {
  input: z.object({
      task_id: z.string().min(1),
      includePrompt: z.boolean().default(false),
      promptMaxChars: z.number().int().min(0).max(1000000).default(5000)
    }),
  handler: async ({ task_id, includePrompt, promptMaxChars }) => {
    const task = await getTask(task_id);
    if (!task) return textResult({ error: "task_not_found", task_id });
    return textResult(statusView(task, { includePrompt, promptMaxChars }));
  }
};

export const getCodexWorkerEventsOp = {
  input: z.object({
      task_id: z.string().min(1),
      limit: z.number().int().min(1).max(1000).default(100),
      maxChars: z.number().int().min(0).max(1000000).optional(),
      kinds: z.array(z.string().min(1)).optional()
    }),
  handler: async ({ task_id, limit, maxChars, kinds }) => {
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
};
