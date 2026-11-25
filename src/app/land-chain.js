import "./compose.js";
import { runGit } from "../infra/git.js";
import { appendTaskEvent } from "../infra/store/events.js";
import { getSession } from "../infra/store/sessions.js";
import { getTask, upsertTask } from "../infra/store/tasks.js";
import { getWorkItemForTask, recordFact } from "../infra/store/facts.js";
import { runIdFor } from "../infra/store/db.js";
import { updateWorkItemDelivery } from "../infra/store/records.js";
import { isSettled } from "./settled.js";
import { landWorker } from "./landing.js";
import { existsSync } from "node:fs";

export const git = (cwd, args) => runGit(cwd, args, { timeout: 60000 });

async function recordWorkerLanded(task, { head, branch, target, source = "git_land", alreadyLanded = [] }) {
  const now = new Date().toISOString();
  const landed = { ...task, landed_at: now, landed_head: head ?? null, landed_branch: branch ?? null, updated_at: now };
  await upsertTask(landed);
  await updateWorkItemDelivery(task.id, "landed");
  const event = await appendTaskEvent(task.id, {
    type: "supervisor.landed",
    head: head ?? null,
    branch: branch ?? null,
    target: target ?? null,
    source,
    already_landed: alreadyLanded,
    landed_at: now
  }, { runId: runIdFor(task.id, task.run_count ?? 1), actor: "supervisor" });
  const workItem = await getWorkItemForTask(task.id);
  if (workItem && head) {
    await recordFact({
      workItemId: workItem.id,
      scopeType: "work_item",
      scopeId: workItem.id,
      key: "landed",
      value: { head, branch: branch ?? null, source },
      state: "verified",
      sourceEventId: event.id,
      validForSha: head,
      watchedPaths: task.owned_paths ?? [],
      verifiedBy: `supervisor.${source}`
    });
    await recordFact({
      workItemId: workItem.id,
      scopeType: "dependency",
      scopeId: workItem.id,
      key: "landed_delivery_summary",
      value: { task_id: task.id, landed_head: head, branch: branch ?? null, acceptance: task.acceptance_results?.passed === true ? "passed" : "not_configured_or_not_passed", source },
      state: "verified",
      sourceEventId: event.id,
      validForSha: head,
      watchedPaths: task.owned_paths ?? [],
      verifiedBy: `supervisor.${source}`
    });
  }
  return { landed, event };
}

export async function landOneWorkerTask(taskId, options = {}) {
  const { onto = null, commitMessage = null, ignoreAcceptance = false, allowOutsideOwned = false, skipAlreadyLanded = false } = options;
  const task = await getTask(taskId);
  if (!task) return { error: "task_not_found", task_id: taskId };
  if (task.workspace_kind && task.workspace_kind !== "legacy" && task.workspace_kind !== "git_worktree") {
    return { error: "workspace_kind_not_landable", task_id: taskId, workspace_kind: task.workspace_kind, reason: `${task.workspace_kind} does not create a Git worktree and cannot be landed` };
  }
  const session = task.session_id ? await getSession(task.session_id) : null;
  if (!isSettled(task)) return { error: "worker_active", task_id: taskId, reason: "wait for this run and acceptance to settle before landing" };
  if (session?.approval_state === "waiting_user") return { error: "session_waiting_user", task_id: taskId, reason: "session requires user approval before landing" };
  if (session && task.session_policy_revision !== session.policy_revision) return { error: "session_policy_stale", task_id: taskId, current_revision: session.policy_revision, checked_revision: task.session_policy_revision, reason: "requirements changed; resume with the current objective and rerun acceptance before landing" };
  if (skipAlreadyLanded && task.landed_at && (!task.worktree_path || !existsSync(task.worktree_path))) {
    try {
      const targetBranch = git(task.project_root, ["symbolic-ref", "--short", "HEAD"]);
      if (onto && onto !== targetBranch) return { error: "wrong_branch", task_id: taskId, current_branch: targetBranch };
      if (!ignoreAcceptance && task.acceptance?.length && task.acceptance_results?.passed !== true) {
        return { error: "acceptance_not_run", task_id: taskId };
      }
      git(task.project_root, ["merge-base", "--is-ancestor", task.landed_head, "HEAD"]);
      return { task_id: taskId, title: task.title, status: task.status, branch: `codex/${task.id}`, skipped: "already_landed", landed_at: task.landed_at, landed_head: task.landed_head };
    } catch {
      return { error: "landed_commit_unreachable", task_id: taskId, reason: "the removed ancestor worktree cannot be skipped without proving its landed commit is on the current target" };
    }
  }
  const outcome = landWorker(task, { onto, commitMessage, ignoreAcceptance, allowOutsideOwned });
  if (outcome.error === "nothing_to_land" && outcome.already_landed?.length > 0
    && (outcome.uncommitted ?? []).length === 0) {
    const alreadyRecorded = task.landed_at && task.landed_head === outcome.matched_head;
    if (!alreadyRecorded && outcome.matched_head) {
      await recordWorkerLanded(task, {
        head: outcome.matched_head,
        branch: outcome.onto,
        target: outcome.target,
        source: "patch_equivalent",
        alreadyLanded: outcome.already_landed
      });
    }
    return {
      task_id: taskId,
      title: task.title,
      status: task.status,
      branch: `codex/${task.id}`,
      ...outcome,
      skipped: "already_in_target",
      lifecycle_recorded: !alreadyRecorded && Boolean(outcome.matched_head)
    };
  }
  if (outcome.error) return { task_id: taskId, title: task.title, status: task.status, branch: `codex/${task.id}`, ...outcome };
  await recordWorkerLanded(task, { head: outcome.head, branch: outcome.onto, target: outcome.target, alreadyLanded: outcome.already_landed ?? [] });
  return { task_id: taskId, title: task.title, status: task.status, branch: `codex/${task.id}`, ...outcome };
}

export async function followupChainIds(taskId) {
  const ids = [];
  const seen = new Set();
  let current = taskId;
  for (;;) {
    if (seen.has(current)) throw new Error(`followup cycle detected at ${current}`);
    seen.add(current);
    const task = await getTask(current);
    if (!task) throw new Error(`task not found: ${current}`);
    ids.unshift(current);
    if (!task.followup_of) return ids;
    current = task.followup_of;
  }
}
