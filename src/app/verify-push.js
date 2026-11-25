// Proves a landed commit is on a remote branch. Read-only towards the remote:
// it fetches and compares, and never pushes or deploys.
import "./compose.js";
import { runGit } from "../infra/git.js";
import { appendTaskEvent } from "../infra/store/events.js";
import { getWorkItemForTask, recordFact } from "../infra/store/facts.js";
import { recordJsonArtifact, saveCleanupPlan, updateWorkItemDelivery } from "../infra/store/records.js";
import { getTask, upsertTask } from "../infra/store/tasks.js";
import { runIdFor } from "../infra/store/db.js";
import { createCleanupPlan } from "./cleanup-plan.js";

const git = (cwd, args) => runGit(cwd, args, { timeout: 60000 });
const CLEANUP_NEXT_STEP = "Review SAFE items, then call apply_cleanup with their item IDs; cleanup is never automatic.";

async function recordPushFacts(task, proof, { eventId, artifactId }) {
  const workItem = await getWorkItemForTask(task.id);
  if (!workItem) return;
  const { remote, branch, remoteHead } = proof;
  const shared = {
    workItemId: workItem.id,
    scopeId: workItem.id,
    state: "verified",
    sourceEventId: eventId,
    sourceArtifactId: artifactId,
    validForSha: task.landed_head,
    watchedPaths: task.owned_paths ?? [],
    verifiedBy: "supervisor.remote_readback"
  };
  await recordFact({
    ...shared,
    scopeType: "work_item",
    key: "push_verified",
    value: { remote, branch, landed_head: task.landed_head, remote_head: remoteHead }
  });
  await recordFact({
    ...shared,
    scopeType: "dependency",
    key: "push_delivery_summary",
    value: { task_id: task.id, landed_head: task.landed_head, remote, branch, remote_head: remoteHead }
  });
}

// Writes the task row, the delivery state, the event, the proof artifact and the facts.
async function recordPushVerified(task, proof) {
  const { remote, branch, remoteHead } = proof;
  const now = new Date().toISOString();
  await upsertTask({ ...task, push_verified_at: now, push_remote: remote, push_branch: branch, push_remote_head: remoteHead, updated_at: now });
  await updateWorkItemDelivery(task.id, "push_verified");
  const runId = runIdFor(task.id, task.run_count ?? 1);
  const event = await appendTaskEvent(task.id, {
    type: "supervisor.push_verified",
    remote,
    branch,
    landed_head: task.landed_head,
    remote_head: remoteHead,
    verified_at: now
  }, { runId, actor: "supervisor" });
  const artifact = await recordJsonArtifact({
    runId,
    type: "push_proof",
    value: { remote, branch, landed_head: task.landed_head, remote_head: remoteHead, verified_at: now, event_id: event.id },
    securityClass: "internal"
  });
  await recordPushFacts(task, proof, { eventId: event.id, artifactId: artifact.id });
  return { now, artifact };
}

function remoteHeadOf(task, remote, branch) {
  git(task.project_root, ["remote", "get-url", remote]);
  git(task.project_root, ["fetch", "--no-tags", remote, `refs/heads/${branch}`]);
  return git(task.project_root, ["rev-parse", "FETCH_HEAD"]);
}

function reaches(task, remoteHead) {
  try {
    git(task.project_root, ["merge-base", "--is-ancestor", task.landed_head, remoteHead]);
    return true;
  } catch {
    return false;
  }
}

export async function verifyDeliveryPush({ taskId, remote, branch }) {
  const task = await getTask(taskId);
  if (!task) return { error: "task_not_found", task_id: taskId };
  const targetBranch = branch ?? task.landed_branch;
  if (!task.landed_at || !task.landed_head || !targetBranch) {
    return { error: "not_landed", task_id: taskId, reason: "land the worker first; this task has no landed head and branch to verify" };
  }
  try {
    const remoteHead = remoteHeadOf(task, remote, targetBranch);
    if (!reaches(task, remoteHead)) {
      return {
        error: "not_pushed",
        task_id: taskId,
        remote,
        branch: targetBranch,
        landed_head: task.landed_head,
        remote_head: remoteHead,
        reason: "landed_head is not reachable from the fetched remote branch"
      };
    }
    const { now, artifact } = await recordPushVerified(task, { remote, branch: targetBranch, remoteHead });
    const cleanupPlan = await createCleanupPlan({ taskIds: [taskId] });
    await saveCleanupPlan(cleanupPlan);
    return {
      task_id: taskId,
      remote,
      branch: targetBranch,
      landed_head: task.landed_head,
      remote_head: remoteHead,
      artifact_id: artifact.id,
      push_verified_at: now,
      cleanup_plan: { id: cleanupPlan.id, summary: cleanupPlan.summary, expires_at: cleanupPlan.expires_at, next_step: CLEANUP_NEXT_STEP }
    };
  } catch (error) {
    return { error: "push_verification_failed", task_id: taskId, remote, branch: targetBranch, reason: error.message.split("\n")[0] };
  }
}
