// The argument groups dispatch and preflight share, and the mapping from the
// public names onto the operations' own.
import { z } from "zod";

// The public schema describes each group in one line instead of spelling out
// every nested field: the nested JSON Schema cost more context than every
// other tool put together. The operation behind the tool validates the
// fields strictly, so a wrong key or value still comes back as a clear error.
export const group = (text) => z.looseObject({}).optional().describe(text);

export const sandboxShape = group("{mode: read-only | workspace-write (default) | danger-full-access, network_access, writable_roots: [abs dirs], allowed_commands: [commands; trailing * = prefix], forbid: [paths or commands]}");

export const workspaceShape = group("{kind: git_worktree (default) | read_only_in_place | scratch | in_place_write, base_ref, setup: {links: [{path, source}], submodules, commands} run first, in_place_authorization, external_outputs: [{path}]}");

export const contextShape = group("{files: [{path}] abs paths to read, contracts: [binding statements]}");

export const acceptanceShape = group("{commands, timeout_ms}: shell commands the supervisor runs in the worktree after the worker exits; all must exit 0");

export const limitsShape = group("{max_run_ms, max_total_ms}");

const check = (entry) => (typeof entry === "string" ? entry : { command: entry.command, reportPath: entry.report_path ?? entry.reportPath, baseline: entry.baseline });

// Public acceptance commands -> the operations' shape.
export function acceptanceCommands(commands) {
  if (commands === undefined) return undefined;
  return Array.isArray(commands) ? commands.map(check) : commands;
}

// Public dispatch arguments -> the flat names the operations take.
export function dispatchOptions(args) {
  const { sandbox = {}, workspace = {}, context = {}, acceptance, limits = {}, session = {}, goal } = args;
  return {
    title: args.title,
    cwd: args.cwd,
    model: args.model,
    reasoningEffort: args.reasoning_effort,
    ownedPaths: args.owned_paths,
    goal: goal ? { objective: goal.objective, tokenBudget: goal.token_budget } : undefined,
    session_id: session.id,
    session_title: session.title,
    session_note: session.note,
    sandbox: sandbox.mode,
    networkAccess: sandbox.network_access,
    writableRoots: sandbox.writable_roots,
    allowedCommands: sandbox.allowed_commands,
    forbid: sandbox.forbid,
    workspaceKind: workspace.kind,
    baseRef: workspace.base_ref,
    workspaceSetup: workspace.setup,
    inPlaceAuthorization: workspace.in_place_authorization,
    skipGitRepoCheck: workspace.skip_git_repo_check,
    externalOutputs: workspace.external_outputs,
    context: context.files,
    contracts: context.contracts,
    acceptance: acceptanceCommands(acceptance?.commands),
    acceptanceTimeoutMs: acceptance?.timeout_ms,
    maxRunMs: limits.max_run_ms,
    maxTotalMs: limits.max_total_ms
  };
}

// Keeps only the names an operation knows, so one mapping serves several.
export function only(op, options) {
  const known = new Set(Object.keys(op.input.shape));
  return Object.fromEntries(Object.entries(options).filter(([key, value]) => known.has(key) && value !== undefined));
}
