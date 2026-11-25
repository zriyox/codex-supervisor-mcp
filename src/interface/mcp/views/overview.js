import { acceptanceVerdict } from "../../../app/acceptance.js";
import { classifyFailure } from "../../../domain/failure-class.js";
import { ACTIVE_STATUSES, isGoalNeedingAttention } from "../../../domain/status.js";
import { threadHealth } from "../../../domain/thread-health.js";
import { approxTokenCount } from "../../../domain/truncate.js";
import { readTaskChanges } from "../../../infra/worktree.js";
import { clip } from "../result.js";
import { ACTION_PREVIEW_CHARS, liveness } from "./task.js";

const OVERVIEW_BYTE_BUDGET = 7000;
const OVERVIEW_CAP_LEVELS = [
  { title: 40, goal: 60, action: 60, path: 60 },
  { title: 28, goal: 40, action: 40, path: 40 },
  { title: 18, goal: 24, action: 24, path: 24 },
  { title: 12, goal: 16, action: 16, path: 16 },
  { title: 8, goal: 8, action: 8, path: 8 },
  { title: 0, goal: 0, action: 0, path: 0 }
];

function overviewRow(task, caps) {
  const live = liveness(task);
  return {
    id: task.id,
    title: clip(task.title, caps.title),
    status: task.status,
    phase: task.phase ?? null,
    goal: clip(task.goal_objective, caps.goal),
    goal_status: task.goal_status ?? null,
    last_action: clip(task.current_action, caps.action),
    idle_seconds: live.idle_seconds,
    command_running: Boolean(task.current_command) && ACTIVE_STATUSES.has(task.status),
    ...(live.current_stage ? { current_stage: live.current_stage } : {}),
    ...(live.last_stage ? { last_stage: live.last_stage } : {}),
    acceptance: acceptanceVerdict(task),
    ...(classifyFailure(task)?.code ? { failure_code: classifyFailure(task).code } : {}),
    ...(threadHealth(task).state === "handoff_recommended" ? { handoff_recommended: true } : {}),
    changed_files: (task.changed_files ?? []).length,
    depends_on: task.depends_on ?? [],
    owned_paths: (task.owned_paths ?? []).map((entry) => clip(entry, caps.path))
  };
}

// One line per work for the listing tools. Kept deliberately small: the caller
// is usually a main thread that will drill into at most one of these.
export function workRow(task) {
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

export function buildOverview(tasks, extras = {}) {
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

export function buildWorkerSummary(task, nativeGoal) {
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

export function externalOutputView(task, maxChars = 6000) {
  const outputs = task.run_evidence?.external_outputs ?? [];
  const perContent = Math.floor(maxChars / Math.max(1, outputs.length * 2));
  return outputs.map((entry) => ({ ...entry, before: { ...entry.before, content: clip(entry.before.content, perContent) },
    after: { ...entry.after, content: clip(entry.after.content, perContent) } }));
}

export function reportView(task, maxChars) {
  const value = task.run_evidence?.structured_report;
  if (!value) return { format: "legacy_text", valid: null };
  if (!value.valid || !maxChars) return value;
  const report = value.report;
  const perEntry = Math.floor(maxChars / Math.max(1, 2 + report.verification.length + report.not_done.length));
  return { ...value, report: { result: clip(report.result, perEntry * 2),
    verification: report.verification.map((entry) => clip(entry, perEntry)),
    not_done: report.not_done.map((entry) => clip(entry, perEntry)) } };
}

export function runEvidenceView(task) {
  if (!task.run_evidence) return null;
  const { structured_report, external_outputs, ...evidence } = task.run_evidence;
  return { ...evidence, external_changed_count: (external_outputs ?? []).filter((entry) => entry.changed).length };
}
