import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { commandFailed } from "./event-parser.js";

export const PREFLIGHT_VERSION = 1;

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])])
    );
  }
  return value;
}

function uniqueSorted(values) {
  return [...new Set((values ?? []).map((value) => String(value)))].sort();
}

export function normalizeObservedCommand(command) {
  const text = String(command ?? "").trim();
  const wrapped = text.match(/^(?:[^\s]+\/)?(?:zsh|bash|sh)\s+-l?c\s+(['"])([\s\S]*)\1$/);
  return wrapped ? wrapped[2].trim() : text;
}

export function buildRuntimeContract({
  projectRoot,
  baseCommit,
  sandbox,
  ownedPaths,
  allowedCommands,
  networkAccess,
  writableRoots,
  context,
  contracts,
  workspaceKind = "git_worktree",
  workspaceManifestSha256 = null
}) {
  return stableValue({
    version: PREFLIGHT_VERSION,
    project_root: resolve(projectRoot),
    base_commit: baseCommit ?? null,
    sandbox,
    owned_paths: uniqueSorted(ownedPaths),
    allowed_commands: uniqueSorted(allowedCommands),
    network_access: networkAccess === true,
    writable_roots: uniqueSorted(writableRoots),
    workspace_kind: workspaceKind,
    workspace_manifest_sha256: workspaceManifestSha256,
    context: (context ?? [])
      .map((entry) => ({ path: resolve(entry.path), sha256: entry.sha256 ?? null }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    contracts: uniqueSorted(contracts)
  });
}

export function runtimeContractHash(contract) {
  return createHash("sha256").update(JSON.stringify(stableValue(contract))).digest("hex");
}

export function createPreflightMetadata(contract, probeCommands) {
  const commands = uniqueSorted(probeCommands);
  if (commands.length === 0) throw new Error("preflight requires at least one probe command");
  return {
    version: PREFLIGHT_VERSION,
    contract,
    contract_hash: runtimeContractHash(contract),
    probe_commands: commands
  };
}

export function readPreflightResult(task) {
  const metadata = task?.guard_policy?.preflight;
  if (!metadata?.contract_hash || !Array.isArray(metadata.probe_commands)) {
    return { error: "not_a_preflight", status: "unknown" };
  }

  const commands = Array.isArray(task.commands) ? task.commands : [];
  const probes = metadata.probe_commands.map((command) => {
    const matches = commands.filter((entry) => normalizeObservedCommand(entry.command) === command);
    const result = matches.at(-1) ?? null;
    return {
      command,
      executed: Boolean(result),
      exit_code: result?.exit_code ?? null,
      status: result?.status ?? null,
      passed: Boolean(result) && !commandFailed(result)
    };
  });
  const terminal = ["completed", "failed", "cancelled", "lost"].includes(task.status);
  const failedCommands = commands.filter(commandFailed);
  let status = "running";
  if (terminal) {
    status = task.status === "completed" && task.exit_code === 0 && probes.every((probe) => probe.passed) && failedCommands.length === 0
      ? "passed"
      : "failed";
  }
  return {
    task_id: task.id,
    status,
    terminal,
    contract_hash: metadata.contract_hash,
    contract: metadata.contract,
    probes,
    failed_commands: failedCommands.map((entry) => ({
      command: entry.command,
      exit_code: entry.exit_code ?? null,
      status: entry.status ?? null,
      output_tail: entry.output_tail ?? null
    }))
  };
}
