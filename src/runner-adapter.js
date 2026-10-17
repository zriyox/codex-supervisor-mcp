import { execFileSync, spawn } from "node:child_process";
import { defaultBinDirs, findBinaryPath, resolveCommand, shimMessage } from "./bin-resolver.js";
import { applyCodexEvent } from "./event-parser.js";

const CODEX_NPM_ENTRY = { pkg: "@openai/codex", bin: "bin/codex.js" };

export class CodexRunnerAdapter {
  constructor({ env = process.env } = {}) {
    this.env = env;
    this.name = "codex";
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
      const help = execFileSync(target.cmd, [...target.prefixArgs, "exec", "--help"], {
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
    return spawn(target.cmd, [...target.prefixArgs, ...args], options);
  }

  parseEvent(task, event) {
    return applyCodexEvent(task, event);
  }

  cancelChild(child) {
    if (process.platform === "win32" && child.pid) {
      try {
        execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", timeout: 5000, windowsHide: true });
        return;
      } catch {
        // fall through to the process handle
      }
    }
    child.kill("SIGTERM");
  }

  cancelPid(pid) {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", timeout: 5000, windowsHide: true });
      return;
    }
    process.kill(pid, "SIGTERM");
  }

  ownsPid(pid, describeProcess) {
    return describeProcess(pid).includes("codex");
  }
}

export const codexRunner = new CodexRunnerAdapter();
