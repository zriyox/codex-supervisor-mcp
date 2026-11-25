import { ensureTaskWorktree } from "../../../app/restore-worktree.js";
import { askWorker, endSideSession, latestSideTurn } from "../../../app/side-chat.js";
import { isGoalNeedingAttention, TERMINAL_STATUSES } from "../../../domain/status.js";
import { truncateMiddleChars, truncateReport } from "../../../domain/truncate.js";
import { getTask, recordTerminalChangedFiles } from "../../../infra/store/tasks.js";
import { readAgentMessages } from "../../../infra/store/events.js";
import { baseBehind, readTaskChanges, readWorktreeDiff, splitPatchHunks, workspaceSetupIgnorePaths, worktreeRef } from "../../../infra/worktree.js";
import { summarizeVerification } from "../../../runners/codex/event-parser.js";
import { readNativeGoal, readNativeGoalState } from "../../../runners/codex/goal-store.js";
import { textResult } from "../result.js";
import { buildWorkerSummary, externalOutputView, reportView, runEvidenceView } from "../views/overview.js";
import { acceptanceView } from "../views/task.js";
import { z } from "zod";

export const getWorkerGoalTool = [
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
];

export const getWorkerSummaryTool = [
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
];

export const getWorkerResultTool = [
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
];

// Cleanup keeps the branch; the diff is read from a worktree cut from it
// again. Null when the worktree is there, a refusal when it cannot come back.
async function restoreRefusal(task) {
  try {
    await ensureTaskWorktree(task);
    return null;
  } catch (error) {
    return textResult({ error: error.code ?? "worktree_restore_failed", task_id: task.id, reason: error.message.split("\n")[0] });
  }
}

export const getWorkerDiffTool = [
  "get_worker_diff",
  {
    title: "Get worker diff",
    description:
      "The worker's actual changes. By default this is a complete file/hunk index; request one file to page through hunks with pageSize or cursor. Supplying maxChars without file preserves the legacy bounded full-diff response. This is the ground truth to check a worker's report against.",
    inputSchema: {
      task_id: z.string().min(1),
      maxChars: z.number().int().min(0).max(1000000).optional(),
      file: z.string().min(1).optional(),
      hunk: z.number().int().min(0).optional(),
      pageSize: z.number().int().min(1).max(20).default(4),
      cursor: z.string().min(1).optional(),
      paths: z.array(z.string().min(1)).optional()
    }
  },
  async ({ task_id, maxChars, file, hunk, pageSize, cursor, paths }) => {
    const task = await getTask(task_id);
    if (!task) return textResult({ error: "task_not_found", task_id });
    if (!task.worktree_path) {
      return textResult({ error: "no_worktree", task_id, external_outputs: externalOutputView(task, maxChars), reason: "this worker ran in place (its cwd is not a git repository or the worktree could not be created), so there is no isolated diff to read; call get_worker_result with includeFiles: true for the files it touched" });
    }
    const refusal = await restoreRefusal(task);
    if (refusal) return refusal;
    if (!file && maxChars !== undefined) {
      const diff = readWorktreeDiff(task.worktree_path, worktreeRef(task), { maxChars, paths: paths ?? [], ignorePaths: workspaceSetupIgnorePaths(task) });
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
    const diffOptions = { maxChars: 10_000_000, paths: paths ?? [], ignorePaths: workspaceSetupIgnorePaths(task) };
    const diff = readWorktreeDiff(task.worktree_path, worktreeRef(task), diffOptions);
    if (diff.error) return textResult({ ...diff, task_id });
    const files = diff.files.map((entry) => {
      const parsed = splitPatchHunks(entry);
      const { path, status, from, additions, deletions } = entry;
      return { path, status, from, additions, deletions, hunk_count: parsed.hunks.length };
    });
    const base = {
      task_id,
      title: task.title,
      status: task.status,
      worktree_path: task.worktree_path,
      branch: `codex/${task.id}`,
      ...diff,
      files,
      external_outputs: externalOutputView(task, maxChars || 6000)
    };
    if (!file) return textResult({ ...base, summary_only: true, next_step: "choose files[].path, then request file plus hunk or cursor" });
    const selected = diff.files.find((entry) => entry.path === file);
    if (!selected) return textResult({ error: "diff_file_not_found", task_id, file, files });
    const parsed = splitPatchHunks(selected);
    let offset = 0;
    if (cursor) {
      try {
        const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        if (value.task_id !== task_id || value.file !== file || !Number.isInteger(value.offset) || value.offset < 0) throw new Error("mismatch");
        offset = value.offset;
      } catch {
        return textResult({ error: "invalid_diff_cursor", task_id, file });
      }
    }
    if (hunk !== undefined) offset = hunk;
    if (offset >= parsed.hunks.length) return textResult({ error: "diff_hunk_not_found", task_id, file, hunk: offset, hunk_count: parsed.hunks.length });
    let remaining = maxChars ?? 24000;
    const hunks = [];
    for (let index = offset; index < parsed.hunks.length && hunks.length < pageSize; index += 1) {
      if (remaining <= 0) break;
      const item = parsed.hunks[index];
      const patchText = item.patch.length > remaining ? truncateMiddleChars(item.patch, remaining) : item.patch;
      hunks.push({ ...item, patch: patchText, truncated: patchText.length < item.patch.length });
      remaining -= patchText.length;
    }
    const nextOffset = offset + hunks.length;
    const nextCursor = nextOffset < parsed.hunks.length
      ? Buffer.from(JSON.stringify({ task_id, file, offset: nextOffset })).toString("base64url")
      : null;
    return textResult({
      ...base,
      file: {
        path: selected.path, status: selected.status, from: selected.from,
        additions: selected.additions, deletions: selected.deletions, hunk_count: parsed.hunks.length
      },
      hunks,
      next_cursor: nextCursor,
      summary_only: false
    });
  }
];

export const askCodexWorkerTool = [
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
];
