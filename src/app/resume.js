import "./compose.js";
import { frameWorkerPrompt } from "../domain/prompt.js";
import { ACTIVE_STATUSES } from "../domain/status.js";
import { buildHandoff } from "../infra/handoff.js";
import { appendTaskEvent } from "../infra/store/events.js";
import { getSession } from "../infra/store/sessions.js";
import { claimTaskRun, getTask, readTasks, releaseTaskRun, upsertTask } from "../infra/store/tasks.js";
import { codexRunner } from "../runners/codex/adapter.js";
import { readNativeGoalState } from "../runners/codex/goal-store.js";
import { DEFAULT_ACCEPTANCE_TIMEOUT_MS, normalizeAcceptance } from "./acceptance.js";
import { isPidAlive } from "./cancel.js";
import { rebaseWorktree } from "./landing.js";
import { processes } from "./run-state.js";
import { startTrackedRun } from "./start-run.js";
import { exists, resolveCommit } from "./worktree-setup.js";
import { appendFile } from "node:fs/promises";

// Continue the *same* Codex session. The worktree, thread id, ownership and
// goal are all inherited from the original task, and the row is reused so one
// logical piece of work stays one row.
//
// `rebaseOnto` names a ref, resolved in the project directory (HEAD, main, a
// sha): the worktree is moved onto it first so the worker continues on
// current code, and base_commit is recorded before the worker starts so a
// spawn failure cannot leave the row describing the old base. A rebase that
// does not go through puts the worktree back and throws with the file list;
// the worker is not started. Refused while the worker is still running.
export async function resumeCodexWorker({ taskId, prompt, rebaseOnto = null, acceptance = undefined, context = undefined }) {
  if (!prompt || typeof prompt !== "string") throw new Error("prompt is required");
  let task = await getTask(taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);
  if (task.guard_policy?.maxTotalMs && Date.now() - Date.parse(task.created_at) >= task.guard_policy.maxTotalMs) {
    const error = new Error("total time quota exceeded; inspect partial work and explicitly dispatch a revised budget");error.code="time_quota_exceeded";throw error;
  }
  if (context !== undefined) {
    await buildHandoff({ context });
    task = { ...task, input_context: { ...task.input_context, context } };
  }
  const claim = await claimTaskRun(taskId, task.run_count ?? 0);
  if (!claim) {
    const error = new Error(`task ${taskId} is active or already claimed by another dispatcher; wait for it to settle`);
    error.code = "worker_active";
    throw error;
  }
  try {
  const session = task.session_id ? await getSession(task.session_id) : null;
  if (session?.approval_state === "waiting_user") {
    const error = new Error("session is waiting for user approval; do not resume");
    error.code = "session_waiting_user";
    throw error;
  }
  const inheritedAcceptance = task.session_policy_revision == null ? task.acceptance : task.acceptance_local;
  const localAcceptance = acceptance === undefined ? inheritedAcceptance : normalizeAcceptance(acceptance);
  // `acceptance` replaces the stored commands when given; an empty list
  // clears them. Left out, the stored commands stay.
  if (acceptance !== undefined || session) {
    const commands = normalizeAcceptance([...(session?.default_acceptance ?? []), ...(localAcceptance ?? [])]);
    task = {
      ...task,
      acceptance: commands,
      acceptance_local: localAcceptance,
      session_policy_revision: session?.policy_revision ?? null,
      acceptance_timeout_ms: commands ? (task.acceptance_timeout_ms ?? DEFAULT_ACCEPTANCE_TIMEOUT_MS) : null,
      updated_at: new Date().toISOString()
    };
    await upsertTask(task);
  }
  if (!task.thread_id) {
    throw new Error(
      `task ${taskId} has no Codex thread_id recorded. Only workers created by this version of codex-supervisor-mcp can be resumed; use create_codex_followup_worker otherwise.`
    );
  }
  let rebase = null;
  if (rebaseOnto) {
    if (ACTIVE_STATUSES.has(task.status) || processes.has(task.id)) {
      const error = new Error(`task ${taskId} is still ${task.status}; wait for it to settle (or cancel it) before rebasing its worktree`);
      error.code = "worker_active";
      throw error;
    }
    if (!task.worktree_path) {
      const error = new Error(`task ${taskId} ran in place and has no worktree to rebase`);
      error.code = "no_worktree";
      throw error;
    }
    let ontoCommit;
    try {
      ontoCommit = resolveCommit(task.project_root, rebaseOnto);
    } catch {
      const error = new Error(`rebaseOnto "${rebaseOnto}" does not resolve to a commit in ${task.project_root}`);
      error.code = "invalid_rebase_onto";
      throw error;
    }
    rebase = rebaseWorktree(task, ontoCommit);
    if (rebase.error) {
      const error = new Error(rebase.reason);
      error.code = rebase.error;
      error.details = rebase;
      throw error;
    }
    if (!rebase.noop && rebase.base_commit !== task.base_commit) {
      task = { ...task, base_commit: rebase.base_commit, updated_at: new Date().toISOString() };
      await upsertTask(task);
    }
  }

  const cwd = (await exists(task.cwd)) ? task.cwd : task.project_root;
  const args = codexRunner.resumeArgs(task);
  const goalRead = readNativeGoalState(task.thread_id);
  // Only a thread with no native goal, or one explicitly stored as complete,
  // can safely resume with a structured output schema. Paused, blocked,
  // usage-limited and budget-limited goals are not complete; Codex can still
  // activate their goal turn and reject the incompatible schema.
  const outputSchema = ["missing_goal", "missing_database"].includes(goalRead.state)
    || (goalRead.state === "available" && goalRead.goal?.storage_status === "complete");

  const started = await startTrackedRun({
    record: { ...task, resumed_from: task.resumed_from ?? task.id },
    args,
    prompt: frameWorkerPrompt(prompt, {
      objective: task.goal_objective ?? task.title ?? task.id,
      resume: true
    }, { acceptance: task.acceptance, outputSchema }),
    logPath: task.run_log,
    outputSchema,
    spawnOptions: { cwd }
  });
  return rebase ? { ...started.record, rebase } : started.record;
  } finally { await releaseTaskRun(taskId, claim); }
}

export async function recoverEligibleRuns() {
  const recovered = [];
  for (const task of await readTasks()) {
    if (task.guard_policy?.preflight) continue;
    if ((task.run_count ?? 0) !== 1 || !task.thread_id
      || !(task.run_evidence?.run === 1 || (task.run_host_pid && task.started_at)) || !task.guard_policy
      || !(task.status === "lost" || task.attention_reason === "no_work" || task.attention_reason === "invalid_report")
      || ["blocked", "paused", "budget_limited", "usage_limited"].includes(task.goal_status)
      || /401|403|unauthori[sz]ed|not logged|permission denied|approval|rate.?limit|429/i.test(task.error ?? "")
      || /time_limit|quota/.test(`${task.attention_reason ?? ""} ${task.error ?? ""}`)
      || await isPidAlive(task.pid) || await isPidAlive(task.run_host_pid)) continue;
    const session = task.session_id ? await getSession(task.session_id) : null;
    if (session?.approval_state === "waiting_user") continue;
    try {
      const result = await resumeCodexWorker({ taskId: task.id,
        prompt: task.attention_reason === "invalid_report"
          ? "Your run finished, but the final message was not the required bare JSON report. Do not redo the work and do not edit files: reply with ONLY the JSON object with result (string), verification (string[]) and not_done (string[]), describing what you already did. No code fences, nothing before or after it."
          : `One automatic recovery after ${task.attention_reason ?? task.status}. Original task: ${task.prompt}\nContinue from files already present; do not repeat completed edits. Make concrete progress, run declared checks, and report remaining blockers accurately. This is the only automatic retry.` });
      const event = { type: "supervisor.recovery", automatic: true, from_run: 1, to_run: result.run_count,
        reason: task.attention_reason ?? task.status, started_at: new Date().toISOString() };
      await appendTaskEvent(task.id, event);
      await appendFile(task.run_log, `${JSON.stringify(event)}\n`);
      recovered.push({ id: task.id, run: result.run_count, reason: event.reason });
    } catch (error) {
      if (!["worker_active", "session_waiting_user"].includes(error.code)) {
        await appendTaskEvent(task.id, { type: "supervisor.recovery_refused", reason: error.code ?? "resume_failed" });
      }
    }
  }
  return recovered;
}
