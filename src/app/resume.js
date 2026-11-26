import { mkdir } from "node:fs/promises";
import { ensureTaskWorktree } from "./restore-worktree.js";
import "./compose.js";
import { frameWorkerPrompt } from "../domain/prompt.js";
import { ACTIVE_STATUSES, runIsOver } from "../domain/status.js";
import { buildHandoff } from "../infra/handoff.js";
import { appendTaskEvent } from "../infra/store/events.js";
import { getSession } from "../infra/store/sessions.js";
import { claimTaskRun, getTask, isGroupAlive, readTasks, releaseTaskRun, upsertTask } from "../infra/store/tasks.js";
import { unsupported } from "../runners/contract.js";
import { getRunner, loadRunner } from "../runners/registry.js";
import { DEFAULT_ACCEPTANCE_TIMEOUT_MS, normalizeAcceptance } from "./acceptance.js";
import { isPidAlive } from "./cancel.js";
import { rebaseWorktree } from "./rebase.js";
import { processes } from "./run-state.js";
import { startTrackedRun } from "./start-run.js";
import { exists, resolveCommit } from "./worktree-setup.js";
import { appendFile } from "node:fs/promises";

// Continue the *same* Codex session. The worktree, thread id, ownership and
// goal are all inherited from the original task, and the row is reused so one
// logical piece of work stays one row.
//
// `rebase_onto` names a ref, resolved in the project directory (HEAD, main, a
// sha): the worktree is moved onto it first so the worker continues on
// current code, and base_commit is recorded before the worker starts so a
// spawn failure cannot leave the row describing the old base. A rebase that
// does not go through puts the worktree back and throws with the file list;
// the worker is not started. Refused while the worker is still running.
function coded(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

// `acceptance` replaces the stored commands when given; an empty list
// clears them. Left out, the stored commands stay.
async function refreshAcceptance(task, session, acceptance) {
  const inheritedAcceptance = task.session_policy_revision == null ? task.acceptance : task.acceptance_local;
  const localAcceptance = acceptance === undefined ? inheritedAcceptance : normalizeAcceptance(acceptance);
  if (acceptance === undefined && !session) return task;
  const commands = normalizeAcceptance([...(session?.default_acceptance ?? []), ...(localAcceptance ?? [])]);
  const updated = {
    ...task,
    acceptance: commands,
    acceptance_local: localAcceptance,
    session_policy_revision: session?.policy_revision ?? null,
    acceptance_timeout_ms: commands ? (task.acceptance_timeout_ms ?? DEFAULT_ACCEPTANCE_TIMEOUT_MS) : null,
    updated_at: new Date().toISOString()
  };
  await upsertTask(updated);
  return updated;
}

// Moves the worktree onto a newer base before the worker continues. A conflict
// is thrown back with the details and no worker is started.
async function rebaseBeforeResume(task, rebaseOnto) {
  if (ACTIVE_STATUSES.has(task.status) || processes.has(task.id)) {
    throw coded("worker_active", `task ${task.id} is still ${task.status}; wait for it to settle (or cancel it) before rebasing its worktree`);
  }
  if (!task.worktree_path) throw coded("no_worktree", `task ${task.id} ran in place and has no worktree to rebase`);
  let ontoCommit;
  try {
    ontoCommit = resolveCommit(task.project_root, rebaseOnto);
  } catch {
    throw coded("invalid_rebase_onto", `rebase_onto "${rebaseOnto}" does not resolve to a commit in ${task.project_root}`);
  }
  const rebase = rebaseWorktree(task, ontoCommit);
  if (rebase.error) throw coded(rebase.error, rebase.reason, rebase);
  if (rebase.noop || rebase.base_commit === task.base_commit) return { task, rebase };
  const moved = { ...task, base_commit: rebase.base_commit, updated_at: new Date().toISOString() };
  await upsertTask(moved);
  return { task: moved, rebase };
}

// Where a resumed worker runs. It is the directory it ran in before, and never
// a stand-in: falling back to the project root would let a worker that was
// confined to a scratch directory or a worktree write into the source tree.
async function resumeCwd(task) {
  if (await exists(task.cwd)) return task.cwd;
  if (task.workspace_kind === "scratch") {
    // Cleanup removes an idle scratch directory. Its drafts are gone, its
    // report is in the store; the worker continues in an empty one.
    await mkdir(task.cwd, { recursive: true });
    return task.cwd;
  }
  throw coded("workspace_missing", `the directory task ${task.id} ran in (${task.cwd}) no longer exists; dispatch a new worker instead of resuming`);
}

async function resumeClaimed(claimed, { prompt, rebaseOnto, acceptance }) {
  const session = claimed.session_id ? await getSession(claimed.session_id) : null;
  if (session?.approval_state === "waiting_user") throw coded("session_waiting_user", "session is waiting for user approval; do not resume");
  let task = await refreshAcceptance(claimed, session, acceptance);
  if (!task.thread_id) {
    throw new Error(
      `task ${task.id} has no thread_id recorded. Only workers created by this version of codex-supervisor-mcp can be resumed; use create_worker with followup_of otherwise.`
    );
  }
  await ensureTaskWorktree(task);
  let rebase = null;
  if (rebaseOnto) ({ task, rebase } = await rebaseBeforeResume(task, rebaseOnto));

  const cwd = await resumeCwd(task);
  const runner = getRunner(task.worker);
  const args = runner.resumeArgs(task);
  const outputSchema = runner.capabilities.structured_report && (runner.resumeAllowsOutputSchema?.(task.thread_id) ?? true);
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
}

export async function resumeCodexWorker({ taskId, prompt, rebaseOnto = null, acceptance = undefined, context = undefined }) {
  if (!prompt || typeof prompt !== "string") throw new Error("prompt is required");
  let task = await getTask(taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);
  const runner = await loadRunner(task.worker);
  if (!runner.capabilities.resume) throw unsupported(runner, "resume", "resuming a worker");
  if (task.guard_policy?.maxTotalMs && Date.now() - Date.parse(task.created_at) >= task.guard_policy.maxTotalMs) {
    throw coded("time_quota_exceeded", "total time quota exceeded; inspect partial work and explicitly dispatch a revised budget");
  }
  if (context !== undefined) {
    await buildHandoff({ context });
    task = { ...task, input_context: { ...task.input_context, context } };
  }
  const claim = await claimTaskRun(taskId, task.run_count ?? 0);
  if (!claim) throw coded("worker_active", `task ${taskId} is active or already claimed by another dispatcher; wait for it to settle`);
  try {
    return await resumeClaimed(task, { prompt, rebaseOnto, acceptance });
  } finally {
    await releaseTaskRun(taskId, claim);
  }
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
      // Once the run is over its pids may belong to anyone.
      || (!runIsOver(task) && (await isPidAlive(task.pid) || await isPidAlive(task.run_host_pid)))
      // Something of the dead run is still alive and holds the session;
      // resuming now fails with "already has an active writer". A later poll retries.
      // A recorded exit is the one thing that rules a survivor out.
      || (task.exit_code == null && isGroupAlive(task.run_host_pid))) continue;
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
