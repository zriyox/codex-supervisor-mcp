import { branchOf } from "../domain/worker-branch.js";
import "./compose.js";
import { readTaskEvents } from "../infra/store/events.js";
import { getTask } from "../infra/store/tasks.js";
import { createCodexWorker } from "./dispatch.js";
import { resolveCommit } from "./worktree-setup.js";

// A follow-up starts from the parent's branch while the parent has not landed,
// so commits made there are present. Uncommitted parent edits stay in the
// parent worktree and are deliberately not smuggled across task boundaries.
function followupBaseRef(parent, baseRef) {
  if (baseRef || parent.landed_at || !parent.project_root || !parent.worktree_path) return baseRef ?? null;
  try {
    resolveCommit(parent.project_root, branchOf(parent));
    return branchOf(parent);
  } catch {
    const error = new Error(`parent checkpoint ${branchOf(parent)} is unavailable; restore it or choose an explicit workspace.base_ref`);
    error.code = "followup_checkpoint_missing";
    throw error;
  }
}

function followupTaskText(parent, recentEvents, followupPrompt) {
  return [
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
}

// The guard and context a follow-up inherits from its parent unless given.
function inheritedPolicy(parent, given) {
  const guard = parent.guard_policy;
  return {
    forbid: given.forbid ?? guard?.forbid ?? [],
    allowedCommands: given.allowedCommands ?? guard?.allowedCommands ?? [],
    context: given.context ?? parent.input_context?.context ?? [],
    contracts: given.contracts ?? parent.input_context?.contracts ?? [],
    externalOutputs: given.externalOutputs ?? guard?.externalOutputs ?? [],
    networkAccess: given.networkAccess ?? guard?.networkAccess ?? false,
    writableRoots: given.writableRoots ?? guard?.writableRoots ?? [],
    maxRunMs: given.maxRunMs ?? guard?.maxRunMs ?? null,
    maxTotalMs: given.maxTotalMs ?? guard?.maxTotalMs ?? null
  };
}

export async function createFollowupWorker(options) {
  const { taskId, followupPrompt, sessionId = null, sessionTitle = null, sessionNote = null, title, cwd, sandbox, model, reasoningEffort } = options;
  const { ownedPaths, goal, baseRef, acceptance, acceptanceTimeoutMs, workspaceKind, inPlaceAuthorization, workspaceSetup } = options;
  const parent = await getTask(taskId);
  if (!parent) throw new Error(`task not found: ${taskId}`);
  // A follow-up continues the parent's session, which only the parent's CLI can open.
  if (options.runner && options.runner !== (parent.worker ?? "codex")) {
    throw Object.assign(new Error(`a follow-up runs on its parent's runner (${parent.worker}); dispatch a new worker to use ${options.runner}`), { code: "invalid_arguments" });
  }
  const inheritedBaseRef = followupBaseRef(parent, baseRef);
  const recentEvents = await readTaskEvents(taskId, 20);
  const inheritedAcceptance = parent.session_policy_revision == null ? parent.acceptance : parent.acceptance_local;

  return createCodexWorker({
    title: title ?? `Follow-up for ${parent.id}`,
    runner: parent.worker,
    task: followupTaskText(parent, recentEvents, followupPrompt),
    sessionId: sessionId ?? parent.session_id ?? null,
    sessionTitle,
    sessionNote,
    cwd: cwd ?? parent.project_root ?? parent.cwd,
    sandbox: sandbox ?? parent.sandbox,
    model: model ?? parent.model,
    reasoningEffort: reasoningEffort ?? parent.reasoning_effort ?? "high",
    skipGitRepoCheck: parent.skip_git_repo_check,
    ownedPaths: ownedPaths ?? parent.owned_paths,
    ...inheritedPolicy(parent, options),
    goal: goal ?? { objective: parent.goal_objective ?? `Follow-up for ${parent.id}`, tokenBudget: parent.goal_token_budget ?? undefined },
    dependsOn: [],
    followupOf: parent.id,
    workspaceKind: workspaceKind ?? (parent.workspace_kind === "legacy" ? null : parent.workspace_kind),
    inPlaceAuthorization: inPlaceAuthorization ?? parent.workspace_metadata?.in_place_authorization ?? null,
    workspaceSetup: workspaceSetup ?? parent.workspace_metadata?.setup ?? null,
    baseRef: inheritedBaseRef,
    // Inherited unless given; the follow-up runs in a fresh worktree cut
    // from the parent's branch, so checks that depend on the
    // parent checkpoint are valid before the parent has landed on the target.
    acceptance: acceptance === undefined ? inheritedAcceptance : acceptance,
    acceptanceTimeoutMs: acceptanceTimeoutMs ?? parent.acceptance_timeout_ms ?? null
  });
}
