// What a worker process is started with: the guard policy, the CLI arguments
// that install it, and the environment the worker's tools read.
import { workspaceSetupWriteRoots } from "../app/worktree-setup.js";
import { findOutsideOwnedChanges } from "../domain/owned-changes.js";
import { buildGuardPreamble } from "../domain/prompt.js";
import { withWorkerToolPath } from "../domain/worker-env.js";
import { workerReportSchemaPath } from "../domain/worker-report.js";
import { cacheRoots } from "../infra/sandbox-roots.js";
import { supervisorMcpDisableArgs } from "../runners/codex/mcp-config.js";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const quoteCommand = (path) => process.platform === "win32" ? `"${path.replace(/"/g, '""')}"` : `'${path.replace(/'/g, "'\\''")}'`;

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

function configArgsFor(record, externalBefore, outputSchema) {
  const guard = fileURLToPath(new URL("../runners/codex/tool-guard.js", import.meta.url));
  const hookCommand = `${quoteCommand(process.execPath)} ${quoteCommand(guard)}`;
  const configArgs = [...(outputSchema ? ["--output-schema", workerReportSchemaPath] : []), "--dangerously-bypass-hook-trust", "-c",
    `hooks.PreToolUse=[{matcher="Bash|apply_patch|create_goal",hooks=[{type="command",command=${JSON.stringify(hookCommand)}}]}]`];
  // A worker may use its explicitly configured business MCP servers, but it
  // must not inherit this supervisor and create a second orchestration tree.
  configArgs.push(...supervisorMcpDisableArgs());
  configArgs.push("-c", `sandbox_workspace_write.network_access=${record.guard_policy?.networkAccess === true}`);
  const sandboxWritableRoots = [...new Set([
    ...externalBefore.map((file) => dirname(file.path)),
    ...cacheRoots(),
    ...workspaceSetupWriteRoots(record),
    ...(record.guard_policy?.writableRoots ?? [])
  ])];
  if (sandboxWritableRoots.length) configArgs.push("-c", `sandbox_workspace_write.writable_roots=${JSON.stringify(sandboxWritableRoots)}`);
  return configArgs;
}

export function buildLaunch({ record, args, prompt, outputSchema, externalBefore }) {
  const guardPolicy = guardPolicyFor(record, externalBefore, outputSchema);
  const stageCli = fileURLToPath(new URL("../interface/bin/stage.js", import.meta.url));
  const acceptanceCli = fileURLToPath(new URL("../interface/bin/acceptance-cli.js", import.meta.url));
  const configArgs = configArgsFor(record, externalBefore, outputSchema);
  // Insert before the prompt/session positional arguments for exec/resume.
  const guardedArgs = [...args.slice(0, -1), ...configArgs, args.at(-1)];
  const env = () => withWorkerToolPath({ ...process.env, NO_COLOR: "1", AGENT_SUPERVISOR_TASK_ID: record.id,
    AGENT_SUPERVISOR_BASE_COMMIT: record.base_commit ?? "",
    AGENT_SUPERVISOR_STAGE_CLI: stageCli,
    AGENT_SUPERVISOR_ACCEPTANCE_CLI: acceptanceCli,
    AGENT_SUPERVISOR_RUN: String((record.run_count ?? 0) + 1), AGENT_SUPERVISOR_GUARD_POLICY: JSON.stringify(guardPolicy) });
  return { guardedArgs, prompt: `${buildGuardPreamble(guardPolicy)}\n\n${prompt}`, env };
}
