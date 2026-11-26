import { runSync, spawnProcess } from "../../infra/process.js";
import { defaultBinDirs, findBinaryPath, resolveCommand, shimMessage } from "../../infra/bin-resolver.js";
import { workerReportSchemaPath } from "../../domain/worker-report.js";
import { chunksFor } from "./chat-chunks.js";
import { applyCodexEvent } from "./event-parser.js";
import { readNativeGoal, readNativeGoalState } from "./goal-store.js";
import { codexConfigText, disableMcpServerArgs, supervisorMcpDisableArgs } from "./mcp-config.js";
import { fileURLToPath } from "node:url";

const quoteCommand = (path) => process.platform === "win32" ? `"${path.replace(/"/g, '""')}"` : `'${path.replace(/'/g, "'\\''")}'`;

const CODEX_NPM_ENTRY = { pkg: "@openai/codex", bin: "bin/codex.js" };

export class CodexRunnerAdapter {
  constructor({ env = process.env } = {}) {
    this.env = env;
    this.name = "codex";
    this.capabilities = { os_sandbox: true, resume: true, side_chat: true, tool_guard: true, structured_report: true, native_goal: true };
    // The read-only fork a side question runs in.
    this.sideChat = {
      forkArgs: (options) => this.forkSideArgs(options),
      // Config overrides go before the thread id and the stdin marker.
      withConfig: (args, configArgs) => [...args.slice(0, -2), ...configArgs, ...args.slice(-2)],
      configText: codexConfigText,
      disableMcpServerArgs,
      chunksFor,
      deleteArgs: (threadId) => ["delete", "--force", threadId]
    };
  }

  // Adds what installs the guard hook, the report schema and the sandbox
  // settings to the arguments of a start or a resume.
  launchArgs({ args, record, outputSchema, writableRoots }) {
    const guard = fileURLToPath(new URL("./tool-guard.js", import.meta.url));
    const hookCommand = `${quoteCommand(process.execPath)} ${quoteCommand(guard)}`;
    const configArgs = [...(outputSchema ? ["--output-schema", workerReportSchemaPath] : []), "--dangerously-bypass-hook-trust", "-c",
      `hooks.PreToolUse=[{matcher="Bash|apply_patch|create_goal",hooks=[{type="command",command=${JSON.stringify(hookCommand)}}]}]`];
    // A worker may use its explicitly configured business MCP servers, but it
    // must not inherit this supervisor and create a second orchestration tree.
    configArgs.push(...supervisorMcpDisableArgs());
    configArgs.push("-c", `sandbox_workspace_write.network_access=${record.guard_policy?.networkAccess === true}`);
    if (writableRoots.length) configArgs.push("-c", `sandbox_workspace_write.writable_roots=${JSON.stringify(writableRoots)}`);
    // Before the prompt/session positional argument that ends exec and resume.
    return [...args.slice(0, -1), ...configArgs, args.at(-1)];
  }

  // Codex already prints the supervisor's event vocabulary.
  toEvents(line) {
    return [JSON.parse(line)];
  }

  nativeGoal(threadId) {
    return readNativeGoal(threadId);
  }

  nativeGoalState(threadId) {
    return readNativeGoalState(threadId);
  }

  // Only a thread with no native goal, or one explicitly stored as complete,
  // can safely resume with a structured output schema. Paused, blocked,
  // usage-limited and budget-limited goals are not complete; Codex can still
  // activate their goal turn and reject the incompatible schema.
  resumeAllowsOutputSchema(threadId) {
    const goalRead = readNativeGoalState(threadId);
    return ["missing_goal", "missing_database"].includes(goalRead.state)
      || (goalRead.state === "available" && goalRead.goal?.storage_status === "complete");
  }

  resolveTarget() {
    const configured = this.env.CODEX_BIN?.trim();
    const located = configured ? configured : (findBinaryPath("codex", { extraDirs: defaultBinDirs() }) ?? "codex");
    const target = resolveCommand(located, { npmEntry: CODEX_NPM_ENTRY });
    if (target.shim) return { error: shimMessage("codex", target.cmd, "CODEX_BIN") };
    return { cmd: target.cmd, prefixArgs: target.prefixArgs };
  }

  capabilityPreflight(target = this.resolveTarget()) {
    if (target.error) return { ok: false, error: target.error };
    try {
      const help = runSync(target.cmd, [...target.prefixArgs, "exec", "--help"], {
        encoding: "utf8",
        timeout: 15000,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
      if (!help.includes("--dangerously-bypass-hook-trust") || !help.includes("--output-schema")) {
        return { ok: false, error: "Codex CLI lacks required per-run hooks/output-schema; install Codex 0.162 or newer before dispatch" };
      }
      return { ok: true, target };
    } catch (error) {
      return { ok: false, error: error.code === "ENOENT"
        ? `failed to spawn ${target.cmd} for Codex capability preflight: ${error.message}`
        : `Codex capability preflight failed: ${error.message}` };
    }
  }

  startArgs({ cwd, sandbox, model, reasoningEffort, skipGitRepoCheck }) {
    const args = ["exec", "--json", "--cd", cwd, "--sandbox", sandbox];
    if (skipGitRepoCheck) args.push("--skip-git-repo-check");
    if (model) args.push("--model", model);
    args.push("-c", `model_reasoning_effort="${reasoningEffort}"`, "-");
    return args;
  }

  resumeArgs(task) {
    const args = ["exec", "resume", "--json", "-c", `sandbox_mode="${task.sandbox}"`];
    if (task.model) args.push("--model", task.model);
    args.push("-c", `model_reasoning_effort="${task.reasoning_effort ?? "high"}"`);
    if (task.skip_git_repo_check) args.push("--skip-git-repo-check");
    args.push(task.thread_id, "-");
    return args;
  }

  forkSideArgs({ forkThreadId, workerThreadId, model }) {
    const args = forkThreadId
      ? ["exec", "resume", "--json", "--skip-git-repo-check", "-c", 'sandbox_mode="read-only"']
      : ["exec", "fork", "--json", "--skip-git-repo-check", "-c", 'sandbox_mode="read-only"'];
    if (model) args.push("-m", model);
    args.push(forkThreadId ?? workerThreadId, "-");
    return args;
  }

  start(target, args, options) {
    return spawnProcess(target.cmd, [...target.prefixArgs, ...args], options);
  }

  parseEvent(task, event) {
    return applyCodexEvent(task, event);
  }

  cancelChild(child) {
    if (process.platform === "win32" && child.pid) {
      try {
        runSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", timeout: 5000, windowsHide: true });
        return;
      } catch {
        // fall through to the process handle
      }
    }
    child.kill("SIGTERM");
  }

  cancelPid(pid) {
    if (process.platform === "win32") {
      runSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", timeout: 5000, windowsHide: true });
      return;
    }
    process.kill(pid, "SIGTERM");
  }

  ownsPid(pid, describeProcess) {
    return describeProcess(pid).includes("codex");
  }
}

export const codexRunner = new CodexRunnerAdapter();
