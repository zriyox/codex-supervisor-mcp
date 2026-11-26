import { branchOf } from "../../../domain/worker-branch.js";
import { ensureTaskWorktree } from "../../../app/restore-worktree.js";
import { askWorker, endSideSession, latestSideTurn } from "../../../app/side-chat.js";
import { isGoalNeedingAttention, TERMINAL_STATUSES } from "../../../domain/status.js";
import { truncateMiddleChars, truncateReport } from "../../../domain/truncate.js";
import { getTask, recordTerminalChangedFiles } from "../../../infra/store/tasks.js";
import { readAgentMessages } from "../../../infra/store/events.js";
import { baseBehind, readTaskChanges, readWorktreeDiff, splitPatchHunks, workspaceSetupIgnorePaths, worktreeRef } from "../../../infra/worktree.js";
import { summarizeVerification } from "../../../runners/codex/event-parser.js";
import { readNativeGoal } from "../../../infra/store/runner-readers.js";
import { runnerOf } from "../../../runners/registry.js";
import { textResult } from "../result.js";
import { buildWorkerSummary, externalOutputView, reportView, runEvidenceView } from "../views/overview.js";
import { acceptanceView } from "../views/task.js";
import { z } from "zod";

export const getWorkerGoalOp = {
  input: z.object({
      task_id: z.string().min(1)
    }),
  handler: async ({ task_id }) => {
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
      native_goal: readNativeGoal(task.thread_id, task.worker),
      native_goal_read: runnerOf(task).capabilities.native_goal ? runnerOf(task).nativeGoalState(task.thread_id) : { state: "unsupported", goal: null }
    });
  }
};

export const getWorkerSummaryOp = {
  input: z.object({
      task_id: z.string().min(1)
    }),
  handler: async ({ task_id }) => {
    const task = await getTask(task_id);
    if (!task) return textResult({ error: "task_not_found", task_id });
    const summary = buildWorkerSummary(task, readNativeGoal(task.thread_id, task.worker));
    // Cache the worktree diff on the row once the worker is done, so the
    // overview's count stops lagging. A running row is the runner's to write.
    if (TERMINAL_STATUSES.has(task.status) && summary.changed_files.length !== (task.changed_files ?? []).length) {
      await recordTerminalChangedFiles(task.id, summary.changed_files);
    }
    return textResult(summary);
  }
};

export const getWorkerResultOp = {
  input: z.object({
      task_id: z.string().min(1),
      limit: z.number().int().min(1).max(20).default(1),
      // Per report, UTF-8 bytes. 0 means no clipping.
      maxChars: z.number().int().min(0).max(1000000).default(6000),
      includeFiles: z.boolean().default(false)
    }),
  handler: async ({ task_id, limit, maxChars, includeFiles }) => {
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
        ? `a report was clipped to ${maxChars} bytes; call again with max_chars: ${Math.max(...reportBytes)} (or 0) to read it whole`
        : null,
      reports: clipped,
      source,
      error: task.error ?? null,
      completed_at: task.completed_at ?? null
    });
  }
};

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

export const getWorkerDiffOp = {
  input: z.object({
      task_id: z.string().min(1),
      maxChars: z.number().int().min(0).max(1000000).optional(),
      file: z.string().min(1).optional(),
      hunk: z.number().int().min(0).optional(),
      pageSize: z.number().int().min(1).max(20).default(4),
      cursor: z.string().min(1).optional(),
      paths: z.array(z.string().min(1)).optional()
    }),
  handler: async ({ task_id, maxChars, file, hunk, pageSize, cursor, paths }) => {
    const task = await getTask(task_id);
    if (!task) return textResult({ error: "task_not_found", task_id });
    if (!task.worktree_path) {
      return textResult({ error: "no_worktree", task_id, external_outputs: externalOutputView(task, maxChars), reason: "this worker ran in place (its cwd is not a git repository or the worktree could not be created), so there is no isolated diff to read; call get_worker with include result and include_files: true for the files it touched" });
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
        branch: branchOf(task),
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
      branch: branchOf(task),
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
};

export const askCodexWorkerOp = {
  input: z.object({
      task_id: z.string().min(1),
      question: z.string().min(1).optional(),
      timeoutMs: z.number().int().min(1000).max(600000).default(110000),
      maxChars: z.number().int().min(0).max(1000000).default(8000),
      fresh: z.boolean().default(false),
      end: z.boolean().default(false)
    }),
  handler: async ({ task_id, question, timeoutMs, maxChars, fresh, end }) => {
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
        ? `The side turn is still running; call ask_worker again with only task_id to read the answer when it lands.`
        : null;
      return textResult({ task_id, ...state, next_step: next });
    } catch (error) {
      if (error.code === "busy") {
        return textResult({ task_id, error: "busy", reason: error.message, ...clipAnswer(await latestSideTurn(task_id)) });
      }
      return textResult({ task_id, error: error.code ?? "side_turn_failed", reason: error.message });
    }
  }
};
