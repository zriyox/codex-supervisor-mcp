import "./compose.js";
import { readTaskEvents } from "../infra/store/events.js";
import { getTask } from "../infra/store/tasks.js";
import { createCodexWorker } from "./dispatch.js";
import { resolveCommit } from "./worktree-setup.js";

export async function createFollowupWorker({
  taskId,
  followupPrompt,
  sessionId = null,
  sessionTitle = null,
  sessionNote = null,
  title,
  cwd,
  sandbox,
  model,
  reasoningEffort,
  ownedPaths,
  goal,
  baseRef,
  acceptance,
  acceptanceTimeoutMs,
  forbid,
  allowedCommands,
  context,
  contracts,
  externalOutputs,
  networkAccess,
  writableRoots,
  maxRunMs,
  maxTotalMs,
  workspaceKind,
  inPlaceAuthorization,
  workspaceSetup
}) {
  const parent = await getTask(taskId);
  if (!parent) throw new Error(`task not found: ${taskId}`);
  let inheritedBaseRef = baseRef ?? null;
  if (!baseRef && !parent.landed_at && parent.project_root && parent.worktree_path) {
    try {
      resolveCommit(parent.project_root, `codex/${parent.id}`);
      inheritedBaseRef = `codex/${parent.id}`;
    } catch {
      const error = new Error(`parent checkpoint codex/${parent.id} is unavailable; restore it or choose an explicit baseRef`);
      error.code = "followup_checkpoint_missing";
      throw error;
    }
  }
  const recentEvents = await readTaskEvents(taskId, 20);
  const prompt = [
    "You are continuing a previous Codex worker run.",
    "",
    `Parent task ID: ${parent.id}`,
    `Parent status: ${parent.status}`,
    `Parent title: ${parent.title}`,
    "",
    "Parent prompt:",
    parent.prompt,
    "",
    "Parent recent summary:",
    `- current_action: ${parent.current_action ?? "-"}`,
    `- current_command: ${parent.current_command ?? "-"}`,
    `- changed_files: ${(parent.changed_files ?? []).join(", ") || "-"}`,
    `- last_message: ${parent.last_message ?? "-"}`,
    "",
    "Parent recent events:",
    ...recentEvents.map((event) => `- ${JSON.stringify(event)}`),
    "",
    "Follow-up instruction:",
    followupPrompt
  ].join("\n");

  return createCodexWorker({
    title: title ?? `Follow-up for ${parent.id}`,
    task: prompt,
    sessionId: sessionId ?? parent.session_id ?? null,
    sessionTitle,
    sessionNote,
    cwd: cwd ?? parent.project_root ?? parent.cwd,
    sandbox: sandbox ?? parent.sandbox,
    model: model ?? parent.model,
    reasoningEffort: reasoningEffort ?? parent.reasoning_effort ?? "high",
    skipGitRepoCheck: parent.skip_git_repo_check,
    ownedPaths: ownedPaths ?? parent.owned_paths,
    forbid: forbid ?? parent.guard_policy?.forbid ?? [],
    allowedCommands: allowedCommands ?? parent.guard_policy?.allowedCommands ?? [],
    context: context ?? parent.input_context?.context ?? [],
    contracts: contracts ?? parent.input_context?.contracts ?? [],
    externalOutputs: externalOutputs ?? parent.guard_policy?.externalOutputs ?? [],
    networkAccess: networkAccess ?? parent.guard_policy?.networkAccess ?? false,
    writableRoots: writableRoots ?? parent.guard_policy?.writableRoots ?? [],
    maxRunMs: maxRunMs ?? parent.guard_policy?.maxRunMs ?? null,
    maxTotalMs: maxTotalMs ?? parent.guard_policy?.maxTotalMs ?? null,
    goal: goal ?? { objective: parent.goal_objective ?? `Follow-up for ${parent.id}`, tokenBudget: parent.goal_token_budget ?? undefined },
    dependsOn: [],
    followupOf: parent.id,
    workspaceKind: workspaceKind ?? (parent.workspace_kind === "legacy" ? null : parent.workspace_kind),
    inPlaceAuthorization: inPlaceAuthorization ?? parent.workspace_metadata?.in_place_authorization ?? null,
    workspaceSetup: workspaceSetup ?? parent.workspace_metadata?.setup ?? null,
    // A follow-up continues the same logical line of work. Start from the
    // parent branch so commits already made there are present; uncommitted
    // parent edits remain in the parent worktree and are deliberately not
    // smuggled across task boundaries.
    baseRef: inheritedBaseRef,
    // Inherited unless given; the follow-up runs in a fresh worktree cut
    // from the parent's codex/<parent> branch, so checks that depend on the
    // parent checkpoint are valid before the parent has landed on the target.
    acceptance: acceptance === undefined ? (parent.session_policy_revision == null ? parent.acceptance : parent.acceptance_local) : acceptance,
    acceptanceTimeoutMs: acceptanceTimeoutMs ?? parent.acceptance_timeout_ms ?? null
  });
}
