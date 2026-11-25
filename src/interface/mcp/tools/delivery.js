import { applyCleanupPlan, createCleanupPlan } from "../../../app/cleanup-plan.js";
import { followupChainIds, git, landOneWorkerTask } from "../../../app/land-chain.js";
import { cancelCodexWorker } from "../../../app/cancel.js";
import { ACTIVE_STATUSES } from "../../../domain/status.js";
import { appendTaskEvent } from "../../../infra/store/events.js";
import { getCleanupPlan, readCleanupHistory, recordJsonArtifact, saveCleanupPlan, updateWorkItemDelivery } from "../../../infra/store/records.js";
import { getTask, upsertTask } from "../../../infra/store/tasks.js";
import { getWorkItemForTask, recordFact } from "../../../infra/store/facts.js";
import { runIdFor } from "../../../infra/store/db.js";
import { errorResult, textResult } from "../result.js";
import { z } from "zod";

export const landCodexWorkerTool = [
  "land_codex_worker",
  {
    title: "Land a worker's commits",
    description:
      "Cherry-pick the commits a worker made on its codex/<taskId> branch onto the current branch of the directory it was dispatched from. The target must be clean and is never switched to another branch; `onto` is a guard that names the branch you expect to be on. A conflict aborts the cherry-pick, lists the files, and leaves the target as it was. A worker in the workspace-write sandbox cannot commit (Codex keeps .git read-only there): pass commitMessage and its uncommitted edits are committed as one commit on its branch first, then landed. Without commitMessage uncommitted edits are reported, not landed. includeFollowupParents lands an unlanded followup chain root-first; commitMessages supplies a per-task checkpoint message when an ancestor has uncommitted edits. Check the work first with get_worker_result and get_worker_diff; land once it passes. A malformed report summary is attention, not a separate landing veto when the same run's acceptance passed and the reviewed diff is sound. Refuses with acceptance_failed while the worker's last acceptance run failed (and acceptance_not_run while one is running or was interrupted): resume it with the failing output, land once it passes. ignoreAcceptance: true lands anyway; use it only when the user said to land regardless.",
    inputSchema: {
      task_id: z.string().min(1),
      onto: z.string().min(1).optional(),
      commitMessage: z.string().min(1).optional(),
      includeFollowupParents: z.boolean().default(false),
      commitMessages: z.record(z.string(), z.string().min(1)).optional(),
      ignoreAcceptance: z.boolean().default(false),
      allowOutsideOwned: z.boolean().default(false)
    }
  },
  async ({ task_id, onto, commitMessage, includeFollowupParents, commitMessages, ignoreAcceptance, allowOutsideOwned }) => {
    if (!includeFollowupParents) {
      const task = await getTask(task_id);
      if (task?.followup_of) {
        let ids;
        try { ids = await followupChainIds(task_id); }
        catch (error) { return textResult({ error: "invalid_followup_chain", task_id, reason: error.message }); }
        const unlanded = [];
        for (const id of ids.slice(0, -1)) {
          const ancestor = await getTask(id);
          if (ancestor) {
            try {
              if (!ancestor.landed_at || !ancestor.landed_head) throw new Error("parent not landed");
              git(task.project_root, ["merge-base", "--is-ancestor", ancestor.landed_head, "HEAD"]);
            } catch { unlanded.push(id); }
          }
        }
        if (unlanded.length) {
          return textResult({
            error: "followup_parents_not_landed",
            task_id,
            unlanded,
            reason: "this follow-up starts from its parent branch; landing only the leaf would integrate a partial chain. Use includeFollowupParents: true after reviewing every task's acceptance and diff."
          });
        }
      }
      return textResult(await landOneWorkerTask(task_id, { onto, commitMessage, ignoreAcceptance, allowOutsideOwned }));
    }
    let ids;
    try { ids = await followupChainIds(task_id); }
    catch (error) { return textResult({ error: "invalid_followup_chain", task_id, reason: error.message }); }
    const chain = [];
    for (const id of ids) {
      let result;
      try { result = await landOneWorkerTask(id, {
        onto,
        commitMessage: commitMessages?.[id] ?? (id === task_id ? commitMessage : null),
        ignoreAcceptance: id === task_id && ignoreAcceptance,
        allowOutsideOwned: id === task_id && allowOutsideOwned,
        skipAlreadyLanded: true
      }); } catch (error) {
        result = { task_id: id, error: "landing_failed", reason: error.message };
      }
      if (id !== task_id && result.error === "nothing_to_land"
        && (result.uncommitted ?? []).length === 0 && !(result.already_landed?.length)) {
        chain.push({ ...result, error: null, skipped: "no_changes" });
        continue;
      }
      if (result.skipped === "already_in_target" && (result.uncommitted ?? []).length === 0) {
        chain.push({ ...result, error: null, skipped: "already_in_target" });
        continue;
      }
      chain.push(result);
      if (result.error) {
        return textResult({ error: "followup_chain_land_failed", task_id, failed_task_id: id, chain });
      }
    }
    return textResult({ task_id, chain });
  }
];

export const verifyDeliveryPushTool = [
  "verify_delivery_push",
  {
    title: "Verify landed work reached a remote branch",
    description: "Fetch a remote branch and prove the worker's landed_head is reachable from it. This never pushes or deploys. A passing check records push_verified; cleanup eligibility may depend on this evidence.",
    inputSchema: {
      task_id: z.string().min(1),
      remote: z.string().min(1).default("origin"),
      branch: z.string().min(1).optional()
    }
  },
  async ({ task_id, remote, branch }) => {
    const task = await getTask(task_id);
    if (!task) return textResult({ error: "task_not_found", task_id });
    const targetBranch = branch ?? task.landed_branch;
    if (!task.landed_at || !task.landed_head || !targetBranch) {
      return textResult({ error: "not_landed", task_id, reason: "land the worker first; this task has no landed head and branch to verify" });
    }
    try {
      git(task.project_root, ["remote", "get-url", remote]);
      git(task.project_root, ["fetch", "--no-tags", remote, `refs/heads/${targetBranch}`]);
      const remoteHead = git(task.project_root, ["rev-parse", "FETCH_HEAD"]);
      try {
        git(task.project_root, ["merge-base", "--is-ancestor", task.landed_head, remoteHead]);
      } catch {
        return textResult({
          error: "not_pushed",
          task_id,
          remote,
          branch: targetBranch,
          landed_head: task.landed_head,
          remote_head: remoteHead,
          reason: "landed_head is not reachable from the fetched remote branch"
        });
      }
      const now = new Date().toISOString();
      const verified = { ...task, push_verified_at: now, push_remote: remote, push_branch: targetBranch, push_remote_head: remoteHead, updated_at: now };
      await upsertTask(verified);
      await updateWorkItemDelivery(task_id, "push_verified");
      const event = await appendTaskEvent(task_id, {
        type: "supervisor.push_verified",
        remote,
        branch: targetBranch,
        landed_head: task.landed_head,
        remote_head: remoteHead,
        verified_at: now
      }, { runId: runIdFor(task_id, task.run_count ?? 1), actor: "supervisor" });
      const artifact = await recordJsonArtifact({
        runId: runIdFor(task_id, task.run_count ?? 1),
        type: "push_proof",
        value: { remote, branch: targetBranch, landed_head: task.landed_head, remote_head: remoteHead, verified_at: now, event_id: event.id },
        securityClass: "internal"
      });
      const workItem = await getWorkItemForTask(task_id);
      if (workItem) {
        await recordFact({
          workItemId: workItem.id,
          scopeType: "work_item",
          scopeId: workItem.id,
          key: "push_verified",
          value: { remote, branch: targetBranch, landed_head: task.landed_head, remote_head: remoteHead },
          state: "verified",
          sourceEventId: event.id,
          sourceArtifactId: artifact.id,
          validForSha: task.landed_head,
          watchedPaths: task.owned_paths ?? [],
          verifiedBy: "supervisor.remote_readback"
        });
        await recordFact({
          workItemId: workItem.id,
          scopeType: "dependency",
          scopeId: workItem.id,
          key: "push_delivery_summary",
          value: { task_id, landed_head: task.landed_head, remote, branch: targetBranch, remote_head: remoteHead },
          state: "verified",
          sourceEventId: event.id,
          sourceArtifactId: artifact.id,
          validForSha: task.landed_head,
          watchedPaths: task.owned_paths ?? [],
          verifiedBy: "supervisor.remote_readback"
        });
      }
      const cleanupPlan = await createCleanupPlan({ taskIds: [task_id] });
      await saveCleanupPlan(cleanupPlan);
      return textResult({
        task_id,
        remote,
        branch: targetBranch,
        landed_head: task.landed_head,
        remote_head: remoteHead,
        artifact_id: artifact.id,
        push_verified_at: now,
        cleanup_plan: { id: cleanupPlan.id, summary: cleanupPlan.summary, expires_at: cleanupPlan.expires_at, next_step: "Review SAFE items, then call apply_cleanup with their item IDs; cleanup is never automatic." }
      });
    } catch (error) {
      return textResult({ error: "push_verification_failed", task_id, remote, branch: targetBranch, reason: error.message.split("\n")[0] });
    }
  }
];

export const cleanupPlanTool = [
  "cleanup_plan",
  {
    title: "Plan safe worktree cleanup",
    description: "Classify managed worktrees as safe, review or blocked. The plan is read-only, expires after 15 minutes, estimates reclaimable bytes and never deletes branches, task rows, events, JSONL logs or artifacts.",
    inputSchema: {
      task_ids: z.array(z.string().min(1)).max(200).optional(),
      project_root: z.string().min(1).optional()
    }
  },
  async ({ task_ids, project_root }) => {
    try {
      const plan = await createCleanupPlan({ taskIds: task_ids ?? null, projectRoot: project_root ?? null });
      await saveCleanupPlan(plan);
      return textResult({
        plan_id: plan.id,
        generated_at: plan.generated_at,
        expires_at: plan.expires_at,
        policy: plan.policy,
        summary: plan.summary,
        items: plan.items
      });
    } catch (error) {
      return errorResult(error);
    }
  }
];

export const applyCleanupTool = [
  "apply_cleanup",
  {
    title: "Apply a safe cleanup plan",
    description: "Remove only selected SAFE worktrees from an unexpired cleanup plan after a second proof check. Uses git worktree remove and prune only; retains the branch, task row, event stream, JSONL log and artifacts.",
    inputSchema: {
      plan_id: z.string().uuid(),
      item_ids: z.array(z.string().uuid()).min(1).max(200)
    }
  },
  async ({ plan_id, item_ids }) => {
    const plan = await getCleanupPlan(plan_id);
    if (!plan) return textResult({ error: "cleanup_plan_not_found", plan_id });
    if (Date.parse(plan.expires_at) <= Date.now()) return textResult({ error: "cleanup_plan_expired", plan_id, expires_at: plan.expires_at });
    return textResult(await applyCleanupPlan({ plan, itemIds: item_ids, actor: "main_thread" }));
  }
];

export const cleanupHistoryTool = [
  "cleanup_history",
  {
    title: "Read cleanup history",
    description: "Read cleanup plan decisions and applied worktree removals, including safe/review/blocked reasons. This is audit history, not a delete command.",
    inputSchema: { task_id: z.string().min(1).optional(), limit: z.number().int().min(1).max(500).default(100) }
  },
  async ({ task_id, limit }) => textResult({ items: await readCleanupHistory(task_id ?? null, limit) })
];

export const cancelCodexWorkerTool = [
  "cancel_codex_worker",
  {
    title: "Cancel Codex worker",
    description:
      "Terminate a running Codex worker. Uses the in-process handle when available, otherwise the pid recorded on disk so a different MCP session can still cancel it.",
    inputSchema: {
      task_id: z.string().min(1)
    }
  },
  async ({ task_id }) => {
    const now = new Date().toISOString();
    const task = await getTask(task_id);
    // The marker is persisted before the signal is sent so the process that
    // owns the worker reports "cancelled" instead of "lost" when it exits.
    if (task && ACTIVE_STATUSES.has(task.status)) {
      await upsertTask({ ...task, cancel_requested_at: now, updated_at: now });
    }
    const result = await cancelCodexWorker(task_id);
    // A cancel that stopped an acceptance run leaves the worker's own
    // terminal status in place; the exit handler records the verdict.
    if (result.cancelled && task && result.via !== "acceptance") {
      await upsertTask({
        ...task,
        status: "cancelled",
        phase: null,
        cancel_requested_at: now,
        updated_at: now,
        completed_at: task.completed_at ?? now
      });
    }
    return textResult(result);
  }
];
