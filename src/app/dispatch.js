import { newWorkerBranch } from "../domain/worker-branch.js";
import { failedStart } from "./run-state.js";
import "./compose.js";
import { frameWorkerPrompt } from "../domain/prompt.js";
import { buildRuntimeContract, createPreflightMetadata, readPreflightResult, runtimeContractHash } from "../domain/worker-preflight.js";
import { captureExternalOutputs } from "../infra/external-output.js";
import { gitBin, gitSucceeds } from "../infra/git.js";
import { buildHandoff } from "../infra/handoff.js";
import { runToExit } from "../infra/process.js";
import { resolveWritableRoot } from "../infra/sandbox-roots.js";
import { getSession, upsertSession } from "../infra/store/sessions.js";
import { getTask, reserveTaskOwnership, taskRunPath, upsertTask } from "../infra/store/tasks.js";
import { isGitCheckout, prepareWorkspace } from "../infra/workspace-kind.js";
import { codexRunner } from "../runners/codex/adapter.js";
import { DEFAULT_ACCEPTANCE_TIMEOUT_MS, isArtifactOnlyAcceptance, normalizeAcceptance } from "./acceptance.js";
import { findOwnershipConflicts, normalizeOwnedPaths, ownershipConflictError } from "./ownership.js";
import { allowedReasoningEfforts } from "./run-state.js";
import { startTrackedRun } from "./start-run.js";
import { ensureWorktree, invalidBaseRefError, normalizeWorkspaceSetup, prepareWorktreeWorkspace, requireDependencySetup, withWorktreeCreationLock } from "./worktree-setup.js";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

function validateGoal(goal) {
  if (!goal || typeof goal !== "object" || typeof goal.objective !== "string" || goal.objective.trim() === "") {
    throw new Error("goal.objective is required");
  }
  const tokenBudget = goal.tokenBudget ?? goal.token_budget ?? null;
  if (tokenBudget !== null && (!Number.isInteger(tokenBudget) || tokenBudget <= 0)) {
    throw new Error("goal.token_budget must be a positive integer when provided");
  }
  return { objective: goal.objective, tokenBudget };
}

function dependencyError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function containsCommit(cwd, ancestor, descendant) {
  return gitSucceeds(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]);
}

async function validateDependencies(dependsOn, projectRoot, baseCommit) {
  const dependencyIds = [...new Set(dependsOn ?? [])];
  for (const dependencyId of dependencyIds) {
    const dependency = await getTask(dependencyId);
    if (!dependency) {
      throw dependencyError("dependency_not_found", `dependency ${dependencyId} does not exist`, { dependency_id: dependencyId });
    }
    if (resolve(dependency.project_root) !== resolve(projectRoot)) {
      throw dependencyError("dependency_project_mismatch", `dependency ${dependencyId} belongs to a different project root`, {
        dependency_id: dependencyId,
        dependency_project_root: dependency.project_root,
        project_root: projectRoot
      });
    }
    if (dependency.status !== "completed" || dependency.exit_code !== 0 || dependency.attention_reason) {
      throw dependencyError("dependency_not_ready", `dependency ${dependencyId} is not successfully settled`, {
        dependency_id: dependencyId,
        status: dependency.status,
        exit_code: dependency.exit_code ?? null,
        attention_reason: dependency.attention_reason ?? null
      });
    }
    if (Array.isArray(dependency.acceptance) && dependency.acceptance.length > 0 && dependency.acceptance_results?.passed !== true) {
      throw dependencyError("dependency_not_ready", `dependency ${dependencyId} has not passed acceptance`, {
        dependency_id: dependencyId,
        acceptance: dependency.acceptance_results?.status ?? null
      });
    }
    if (!dependency.landed_at || !dependency.landed_head) {
      throw dependencyError("dependency_not_landed", `dependency ${dependencyId} must be landed before a dependent worker starts`, {
        dependency_id: dependencyId,
        landed_at: dependency.landed_at ?? null
      });
    }
    if (!baseCommit || !containsCommit(projectRoot, dependency.landed_head, baseCommit)) {
      throw dependencyError("dependency_base_mismatch", `worker base does not contain landed dependency ${dependencyId}; use the integrated branch or a newer workspace.base_ref`, {
        dependency_id: dependencyId,
        dependency_head: dependency.landed_head,
        base_commit: baseCommit ?? null
      });
    }
  }
}

function coded(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

const DISPATCH_DEFAULTS = {
  sessionId: null, sessionTitle: null, sessionNote: null, sandbox: "workspace-write", model: null, reasoningEffort: "high",
  skipGitRepoCheck: true, dependsOn: [], followupOf: null, workspaceKind: null, inPlaceAuthorization: null, workspaceSetup: null,
  baseRef: null, preflightId: null, preflight: null, acceptance: null, acceptanceTimeoutMs: null, forbid: [], allowedCommands: [],
  context: [], contracts: [], externalOutputs: [], networkAccess: false, writableRoots: [], maxRunMs: null, maxTotalMs: null
};

// An explicit undefined means "not given", the same as leaving the key out.
function withDispatchDefaults(input) {
  const given = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
  return { ...DISPATCH_DEFAULTS, ...given };
}

// Everything that can be refused before anything is created on disk. The
// order of the checks is the order callers see the errors in.
async function validateDispatch(input) {
  const { task, acceptance, cwd, reasoningEffort, ownedPaths, goal, context, contracts, externalOutputs, sandbox } = input;
  const { networkAccess, writableRoots, maxRunMs, maxTotalMs, forbid, allowedCommands, baseRef, preflight } = input;
  if (!task || typeof task !== "string") throw new Error("task is required");
  const acceptanceCommands = normalizeAcceptance(acceptance);
  if (!cwd || typeof cwd !== "string") throw new Error("cwd is required");
  if (!allowedReasoningEfforts.has(reasoningEffort)) {
    throw new Error(`unsupported reasoning_effort: ${reasoningEffort}`);
  }
  if (!Array.isArray(ownedPaths)) {
    throw new Error("owned_paths is required; pass an empty list only for a worker that must never land a change (a read-only verifier, or a research worker that reads and reports)");
  }
  if (ownedPaths.length > 0 && acceptanceCommands?.length && acceptanceCommands.every(isArtifactOnlyAcceptance)) {
    throw new Error("a write worker cannot use only file-existence acceptance; add a real test, endpoint probe or structured execution evidence");
  }
  const validatedGoal = validateGoal(goal);
  await buildHandoff({ context, contracts });
  await captureExternalOutputs(externalOutputs, { checkBaseline: true });
  if (externalOutputs.length && !acceptanceCommands?.length) throw new Error("shared outputs require explicit acceptance commands");
  if (externalOutputs.length && sandbox === "read-only") throw new Error("a read-only worker cannot declare writable shared outputs");
  if (networkAccess && sandbox === "danger-full-access") throw new Error("sandbox.network_access is only for the sandboxed workers");
  if (networkAccess && sandbox === "read-only") throw new Error("the read-only sandbox has no network (a fetch there fails on DNS even with network_access); for a worker that must fetch, use sandbox \"workspace-write\" with sandbox.network_access: true and owned_paths: []");
  if (!Array.isArray(writableRoots) || writableRoots.length > 20 || writableRoots.some((root) => typeof root !== "string" || !isAbsolute(root))) {
    throw new Error("sandbox.writable_roots must be a list of at most 20 absolute paths");
  }
  if (writableRoots.length && sandbox !== "workspace-write") throw new Error("sandbox.writable_roots is only configurable for workspace-write workers");
  // Codex refuses a writable root with a symlink component and then fails every
  // command in the worker, so a declared root is stored resolved. Passing the
  // alias would look fine in the receipt and break the run.
  const resolvedWritableRoots = [];
  for (const root of writableRoots) {
    const resolved = resolveWritableRoot(root);
    if (resolved.error) throw new Error(`sandbox.writable_roots entry is unusable: ${root} (${resolved.error}); pass an existing directory whose path has no symlink component`);
    resolvedWritableRoots.push(resolved.path);
  }
  for (const value of [maxRunMs, maxTotalMs]) if (value !== null && (!Number.isInteger(value) || value < 1000)) throw new Error("time limits must be integer milliseconds of at least 1000");
  for (const [name, values] of Object.entries({ forbid, allowedCommands })) {
    if (!Array.isArray(values) || values.length > 100 || values.some((value) => typeof value !== "string" || !value.trim())) throw new Error(`${name} must be a list of at most 100 nonempty strings`);
  }
  if (baseRef && !isGitCheckout(cwd)) throw invalidBaseRefError(cwd, baseRef);
  if (preflight && (!Array.isArray(preflight.probeCommands) || preflight.probeCommands.length === 0
    || preflight.probeCommands.some((command) => typeof command !== "string" || !command.trim()))) {
    throw new Error("preflight.probe_commands must be a nonempty list of shell commands");
  }
  return { acceptanceCommands, validatedGoal, resolvedWritableRoots };
}

async function claimWorkspace(input, id, acceptanceCommands) {
  const { cwd, workspaceKind, sandbox, ownedPaths, networkAccess, externalOutputs, inPlaceAuthorization, preflight, workspaceSetup } = input;
  const workspace = await prepareWorkspace({
    cwd,
    workspaceKind,
    sandbox,
    ownedPaths,
    networkAccess,
    acceptance: acceptanceCommands,
    externalOutputs,
    inPlaceAuthorization,
    taskId: id,
    isPreflight: Boolean(preflight)
  });
  const projectRoot = workspace.sourceRoot;
  const normalizedOwnedPaths = normalizeOwnedPaths([...ownedPaths, ...externalOutputs.map((entry) => entry.path)], projectRoot);
  const normalizedWorkspaceSetup = normalizeWorkspaceSetup(workspaceSetup, projectRoot);
  if (normalizedWorkspaceSetup && workspace.kind !== "git_worktree") throw new Error("workspace.setup is only supported for git_worktree workers");
  const conflicts = await findOwnershipConflicts(normalizedOwnedPaths);
  if (conflicts.length > 0) throw ownershipConflictError(conflicts);
  return { workspace, projectRoot, normalizedOwnedPaths, normalizedWorkspaceSetup };
}

async function sessionPolicy({ sessionId, sessionTitle, sessionNote }, acceptanceCommands) {
  if (sessionId && (sessionTitle || sessionNote)) {
    await upsertSession({ id: sessionId, title: sessionTitle, note: sessionNote });
  }
  const session = sessionId ? await getSession(sessionId) : null;
  if (session?.approval_state === "waiting_user") throw coded("session_waiting_user", "session is waiting for user approval; do not dispatch or auto-resume");
  const combinedAcceptance = normalizeAcceptance([...(session?.default_acceptance ?? []), ...(acceptanceCommands ?? [])]);
  return { session, combinedAcceptance };
}

// This checkout belongs to a dispatch that never started and contains no
// model edits. Remove it normally; never force-remove user work.
async function discardWorktree(projectRoot, worktreePath, id) {
  await runToExit(gitBin(), ["-C", projectRoot, "worktree", "remove", worktreePath]).catch(() => {});
  await runToExit(gitBin(), ["-C", projectRoot, "branch", "-D", newWorkerBranch(id)]).catch(() => {});
}

async function createWorkerWorktree({ workspace, projectRoot, normalizedWorkspaceSetup }, id, baseRef) {
  const worktree = workspace.kind === "git_worktree"
    ? await withWorktreeCreationLock(projectRoot, () => ensureWorktree(projectRoot, id, baseRef))
    : { path: null, baseCommit: null };
  if (workspace.kind === "git_worktree" && !worktree.path) {
    throw coded("git_worktree_unavailable", "workspace.kind git_worktree could not create an isolated worktree; use read_only_in_place for a non-writing inspection or initialize and commit the repository first");
  }
  if (normalizedWorkspaceSetup) {
    try {
      await prepareWorktreeWorkspace(normalizedWorkspaceSetup, projectRoot, worktree.path, id);
    } catch (error) {
      await discardWorktree(projectRoot, worktree.path, id);
      throw error;
    }
  }
  return worktree;
}

function buildGuard(input, place, worktree, resolvedWritableRoots) {
  const { forbid, allowedCommands, preflight, externalOutputs, networkAccess, maxRunMs, maxTotalMs, sandbox, context, contracts } = input;
  const { workspace, projectRoot, normalizedOwnedPaths, normalizedWorkspaceSetup } = place;
  const guardPolicy = {
    forbid,
    // Probe commands need enough permission to prove the worker environment,
    // but they are not part of the target worker's executable contract. Keep
    // them in this preflight run's guard only so the final worker can reuse the
    // exact contract its dispatcher declared.
    allowedCommands: [...new Set([
      ...allowedCommands,
      ...(preflight?.probeCommands ?? [])
    ])],
    externalOutputs,
    networkAccess,
    writableRoots: [...new Set(resolvedWritableRoots)],
    maxRunMs,
    maxTotalMs,
    workspaceKind: workspace.kind
  };
  const runtimeContract = buildRuntimeContract({
    projectRoot,
    baseCommit: worktree.baseCommit,
    sandbox,
    ownedPaths: normalizedOwnedPaths,
    allowedCommands,
    networkAccess,
    writableRoots: guardPolicy.writableRoots,
    context,
    contracts,
    workspaceSetup: normalizedWorkspaceSetup,
    workspaceKind: workspace.kind,
    workspaceManifestSha256: workspace.beforeManifest?.sha256 ?? null
  });
  const preflightMetadata = preflight
    ? createPreflightMetadata(runtimeContract, preflight.probeCommands)
    : null;
  return { guardPolicy, runtimeContract, preflightMetadata };
}

function buildRecord(input, parts) {
  const { title, task, inPlaceAuthorization, sandbox, model, reasoningEffort, skipGitRepoCheck, followupOf, sessionId } = input;
  const { context, contracts, dependsOn, preflightId, acceptanceTimeoutMs } = input;
  const { id, workspace, projectRoot, normalizedOwnedPaths, normalizedWorkspaceSetup, worktree, effectiveCwd } = parts;
  const { guardPolicy, preflightMetadata, validatedGoal, combinedAcceptance, acceptanceCommands, session } = parts;
  const worktreePath = worktree.path;
  const record = {
    id,
    title: title || task.split("\n").find(Boolean)?.slice(0, 80) || "Codex worker",
    worker: "codex",
    status: "queued",
    phase: null,
    cwd: effectiveCwd,
    project_root: projectRoot,
    workspace_kind: workspace.kind,
    workspace_metadata: {
      source_root: workspace.sourceRoot,
      execution_root: effectiveCwd,
      manifest_paths: workspace.manifestPaths,
      before_manifest: workspace.beforeManifest,
      in_place_authorization: workspace.kind === "in_place_write" ? String(inPlaceAuthorization).trim() : null,
      landable: workspace.landable,
      cleanable: workspace.cleanable,
      setup: normalizedWorkspaceSetup,
      branch: worktreePath ? newWorkerBranch(id) : null
    },
    sandbox,
    model,
    reasoning_effort: reasoningEffort,
    skip_git_repo_check: skipGitRepoCheck,
    followup_of: followupOf,
    resumed_from: null,
    session_id: sessionId ?? null,
    thread_id: null,
    owned_paths: normalizedOwnedPaths,
    guard_policy: {
      ...guardPolicy,
      ...(preflightMetadata ? { preflight: preflightMetadata } : {}),
      ...(preflightId ? { preflight_source_id: preflightId } : {}),
      workspace: {
        kind: workspace.kind,
        source_root: workspace.sourceRoot,
        execution_root: effectiveCwd,
        manifest_paths: workspace.manifestPaths,
        before_manifest_sha256: workspace.beforeManifest?.sha256 ?? null
      }
    },
    input_context: { context, contracts },
    depends_on: Array.isArray(dependsOn) ? dependsOn : [],
    goal_objective: validatedGoal.objective,
    goal_token_budget: validatedGoal.tokenBudget,
    goal_status: null,
    goal_tokens_used: null,
    goal_time_used_seconds: null,
    goal_updated_at: null,
    run_count: 0,
    worktree_path: worktreePath,
    base_commit: worktree.baseCommit,
    acceptance: combinedAcceptance,
    acceptance_local: acceptanceCommands,
    session_policy_revision: session?.policy_revision ?? null,
    acceptance_timeout_ms: combinedAcceptance ? (acceptanceTimeoutMs ?? DEFAULT_ACCEPTANCE_TIMEOUT_MS) : null,
    acceptance_results: null,
    prompt: task,
    changed_files: [],
    commands: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    run_log: taskRunPath(id)
  };
  return record;
}

async function assertPreflightMatches(preflightId, runtimeContract) {
  const preflightTask = await getTask(preflightId);
  const preflightResult = readPreflightResult(preflightTask);
  if (preflightResult.status !== "passed") {
    throw coded("preflight_not_passed", `preflight ${preflightId} is ${preflightResult.status}; wait for its probes to pass before dispatching this worker`, preflightResult);
  }
  const contractHash = runtimeContractHash(runtimeContract);
  if (preflightResult.contract_hash === contractHash) return;
  throw coded("preflight_mismatch", `preflight ${preflightId} does not match this worker's runtime contract; create a new preflight after changing workspace.base_ref, sandbox, owned_paths, commands, context, contracts, network or writable roots`, {
    preflight_id: preflightId,
    expected_contract_hash: contractHash,
    actual_contract_hash: preflightResult.contract_hash,
    preflight: { expected_contract: runtimeContract, actual_contract: preflightResult.contract }
  });
}

// Dependencies, the preflight contract and the path reservation. A refusal
// here removes the worktree and scratch directory made for this dispatch.
async function admitWorker(record, { dependsOn, preflightId }, { workspace, projectRoot, worktree, runtimeContract }) {
  try {
    await validateDependencies(dependsOn, projectRoot, worktree.baseCommit);
    if (preflightId) await assertPreflightMatches(preflightId, runtimeContract);
    await reserveTaskOwnership(record);
  } catch (error) {
    if (worktree.path) await discardWorktree(projectRoot, worktree.path, record.id);
    if (workspace.scratchPath) await rm(workspace.scratchPath, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function createCodexWorker(rawInput) {
  const input = withDispatchDefaults(rawInput);
  const { acceptanceCommands, validatedGoal, resolvedWritableRoots } = await validateDispatch(input);
  const id = `codex-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const place = await claimWorkspace(input, id, acceptanceCommands);
  const { session, combinedAcceptance } = await sessionPolicy(input, acceptanceCommands);
  requireDependencySetup({ kind: place.workspace.kind, projectRoot: place.projectRoot, setup: place.normalizedWorkspaceSetup,
    commands: [...(combinedAcceptance ?? []), ...(input.preflight?.probeCommands ?? [])] });
  const worktree = await createWorkerWorktree(place, id, input.baseRef);
  const effectiveCwd = worktree.path ?? place.workspace.executionCwd;
  const guard = buildGuard(input, place, worktree, resolvedWritableRoots);
  const record = buildRecord(input, { id, ...place, worktree, effectiveCwd, ...guard, validatedGoal, combinedAcceptance, acceptanceCommands, session });
  await admitWorker(record, input, { ...place, worktree, runtimeContract: guard.runtimeContract });

  const { sandbox, model, reasoningEffort, skipGitRepoCheck, task } = input;
  const args = codexRunner.startArgs({ cwd: effectiveCwd, sandbox, model, reasoningEffort, skipGitRepoCheck });
  const job = {
    record,
    args,
    prompt: frameWorkerPrompt(task, {
      objective: validatedGoal.objective,
      tokenBudget: validatedGoal.tokenBudget
    }, { acceptance: combinedAcceptance, outputSchema: true }),
    logPath: record.run_log,
    outputSchema: true,
    // --cd tells Codex where the agent works. The shell/tool process must also
    // inherit the worktree as its OS cwd: otherwise a login shell may restore
    // the project directory and relative probes read the wrong checkout.
    spawnOptions: { cwd: effectiveCwd }
  };
  try {
    return (await startTrackedRun(job)).record;
  } catch (error) {
    // The row is reserved as queued, which blocks its paths for every later
    // dispatch. A start that threw never ran, so the row is closed as failed.
    await upsertTask(failedStart(job.record, `dispatch failed before the worker started: ${error.message}`).record).catch(() => {});
    throw error;
  }
}
