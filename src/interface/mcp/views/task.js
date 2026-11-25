import { acceptanceVerdict } from "../../../app/acceptance.js";
import { classifyFailure } from "../../../domain/failure-class.js";
import { ACTIVE_STATUSES, isGoalNeedingAttention } from "../../../domain/status.js";
import { threadHealth } from "../../../domain/thread-health.js";
import { readStage } from "../../../infra/stage-store.js";
import { readTaskChanges } from "../../../infra/worktree.js";
import { summarizeVerification } from "../../../runners/codex/event-parser.js";
import { clip } from "../result.js";

// `current_action` is "Running <command>", and a command can be a heredoc that
// writes a whole file. Returning it whole put tens of thousands of characters
// into every wait response, which then blew past the client's MCP output cap
// and came back a second time as a notification. The full command stays in
// current_command / commands and is readable through get_codex_worker_events.
export const ACTION_PREVIEW_CHARS = 300;
const COMMAND_PREVIEW_CHARS = 300;
const COMMAND_TAIL = 20;
const PROMPT_PREVIEW_CHARS = 300;
// The single-worker status read is the drill-in for one worker, so its copy of
// the last message stays much larger than the overview's 400. The full report
// is still get_worker_result's job.
const STATUS_MESSAGE_CHARS = 4000;

// Codex emits nothing while a command runs and nothing while the model
// thinks, so a snapshot that has not moved for ten minutes looks the same
// either way. These three fields tell them apart: current_command is set
// from the command's item.started until its item.completed, so a long idle
// with a command is a long command, and a long idle without one is the model
// (or a stuck process, which reconcile turns into lost on its own).
const LIVE_COMMAND_PREVIEW_CHARS = 120;
export function liveness(task) {
  if (!ACTIVE_STATUSES.has(task.status)) {
    const stage = readStage(task.id);
    return {
      idle_seconds: null,
      command_running: false,
      current_command: null,
      current_stage: null,
      current_stage_detail: null,
      last_stage: stage?.stage ?? null,
      stage_updated_at: stage?.updated_at ?? null
    };
  }
  const since = Date.parse(task.last_event_at ?? task.started_at ?? "");
  const idle = Number.isFinite(since) ? Math.max(0, Math.floor((Date.now() - since) / 1000)) : null;
  const command = task.current_command ? clip(task.current_command, LIVE_COMMAND_PREVIEW_CHARS) : null;
  const stage = readStage(task.id);
  const active = ACTIVE_STATUSES.has(task.status);
  return {
    idle_seconds: idle,
    command_running: Boolean(task.current_command),
    current_command: command,
    current_stage: active ? stage?.stage ?? null : null,
    current_stage_detail: active ? stage?.detail ?? null : null,
    last_stage: active ? null : stage?.stage ?? null,
    stage_updated_at: stage?.updated_at ?? null
  };
}

export function compactLiveness(task) {
  const live = liveness(task);
  return {
    idle_seconds: live.idle_seconds,
    command_running: live.command_running,
    current_command: live.current_command,
    ...(live.current_stage ? { current_stage: live.current_stage } : {}),
    ...(live.current_stage_detail ? { current_stage_detail: live.current_stage_detail } : {}),
    ...(live.last_stage ? { last_stage: live.last_stage } : {}),
    ...(live.stage_updated_at ? { stage_updated_at: live.stage_updated_at } : {})
  };
}

// The acceptance verdict as get_worker_result reports it, with the one
// contradiction a tool can see spelled out: checks passed, worker says
// otherwise (the "it was never built" case, where it was).
export function acceptanceView(task, behind) {
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

export function summarizeTask(task) {
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
    goal_tokens_used: task.goal_tokens_used ?? null,
    thread_health: threadHealth(task),
    attention_reason: task.attention_reason ?? null,
    failure: classifyFailure(task),
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
export function statusView(task, { includePrompt, promptMaxChars }) {
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
export function receipt(task) {
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
    failure: classifyFailure(task),
    run_count: task.run_count ?? 0,
    run_log: task.run_log,
    created_at: task.created_at,
    updated_at: task.updated_at
  };
}
