// What a worker process is started with: the guard policy, the CLI arguments
// that install it, and the environment the worker's tools read.
import { workspaceSetupWriteRoots } from "../app/worktree-setup.js";
import { findOutsideOwnedChanges } from "../domain/owned-changes.js";
import { buildGuardPreamble } from "../domain/prompt.js";
import { withWorkerToolPath } from "../domain/worker-env.js";
import { cacheRoots } from "../infra/sandbox-roots.js";
import { runnerOf } from "../runners/registry.js";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

function guardPolicyFor(record, externalBefore, outputSchema) {
  const owned = [...findOutsideOwnedChanges(record, []).mapping.map((entry) => entry.worker), ...externalBefore.map((entry) => entry.path)];
  return { cwd: record.cwd, worktree: record.cwd, sandbox: record.sandbox, ownedPaths: owned, ...(record.guard_policy ?? {}),
    output_schema: outputSchema,
    goalTokenBudget: record.goal_token_budget ?? null,
    allowedCommands: [
      ...(record.guard_policy?.allowedCommands ?? []),
      ...(record.acceptance ?? []).map((check) => typeof check === "string" ? check : check.command),
      // This CLI writes only data/stages/<this task>.json. It is part of the
      // runtime contract, not an ad-hoc command the model must declare. The
      // task id comes from the injected environment; stage.js has no override.
      'node "$AGENT_SUPERVISOR_STAGE_CLI"*',
      'node "$AGENT_SUPERVISOR_ACCEPTANCE_CLI"*'
    ] };
}

// Directories the sandbox must let the worker write besides its worktree.
function writableRootsFor(record, externalBefore) {
  return [...new Set([
    ...externalBefore.map((file) => dirname(file.path)),
    ...cacheRoots(),
    ...workspaceSetupWriteRoots(record),
    ...(record.guard_policy?.writableRoots ?? [])
  ])];
}

export function buildLaunch({ record, args, prompt, outputSchema, externalBefore }) {
  const guardPolicy = guardPolicyFor(record, externalBefore, outputSchema);
  const stageCli = fileURLToPath(new URL("../interface/bin/stage.js", import.meta.url));
  const acceptanceCli = fileURLToPath(new URL("../interface/bin/acceptance-cli.js", import.meta.url));
  const guardedArgs = runnerOf(record).launchArgs({ args, record, outputSchema, writableRoots: writableRootsFor(record, externalBefore) });
  const env = () => withWorkerToolPath({ ...process.env, NO_COLOR: "1", AGENT_SUPERVISOR_TASK_ID: record.id,
    AGENT_SUPERVISOR_BASE_COMMIT: record.base_commit ?? "",
    AGENT_SUPERVISOR_STAGE_CLI: stageCli,
    AGENT_SUPERVISOR_ACCEPTANCE_CLI: acceptanceCli,
    AGENT_SUPERVISOR_RUN: String((record.run_count ?? 0) + 1), AGENT_SUPERVISOR_GUARD_POLICY: JSON.stringify(guardPolicy) });
  return { guardedArgs, prompt: `${buildGuardPreamble(guardPolicy)}\n\n${prompt}`, env };
}
