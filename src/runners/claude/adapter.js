// Claude Code as a worker, through its headless mode (`claude -p`).
//
// What it has: sessions that resume, a PreToolUse hook, a structured final
// answer. What it lacks: an OS sandbox (the hook is the only confinement, so
// the core allows it only a worktree or a read-only run), a read-only fork to
// ask side questions in, and a native goal.
import { workerReportSchemaPath } from "../../domain/worker-report.js";
import { defaultBinDirs, findBinaryPath, resolveCommand, shimMessage } from "../../infra/bin-resolver.js";
import { runSync, spawnProcess } from "../../infra/process.js";
import { applyCodexEvent } from "../codex/event-parser.js";
import { createTranslator } from "./events.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CLAUDE_NPM_ENTRY = { pkg: "@anthropic-ai/claude-code", bin: "cli.js" };
const EFFORTS = new Set(["low", "medium", "high"]);
const quoteCommand = (path) => process.platform === "win32" ? `"${path.replace(/"/g, '""')}"` : `'${path.replace(/'/g, "'\\''")}'`;

export class ClaudeRunnerAdapter {
  constructor({ env = process.env } = {}) {
    this.env = env;
    this.name = "claude";
    this.capabilities = { os_sandbox: false, resume: true, side_chat: false, tool_guard: true, structured_report: true, native_goal: false };
    this.translate = createTranslator();
  }

  resolveTarget() {
    const configured = this.env.CLAUDE_BIN?.trim();
    const located = configured ? configured : (findBinaryPath("claude", { extraDirs: defaultBinDirs() }) ?? "claude");
    const target = resolveCommand(located, { npmEntry: CLAUDE_NPM_ENTRY });
    if (target.shim) return { error: shimMessage("claude", target.cmd, "CLAUDE_BIN") };
    return { cmd: target.cmd, prefixArgs: target.prefixArgs };
  }

  capabilityPreflight(target = this.resolveTarget()) {
    if (target.error) return { ok: false, error: target.error };
    try {
      const help = runSync(target.cmd, [...target.prefixArgs, "--help"], { encoding: "utf8", timeout: 20000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      const missing = ["--json-schema", "--settings", "--resume", "--output-format"].filter((flag) => !help.includes(flag));
      if (missing.length) return { ok: false, error: `Claude Code lacks ${missing.join(", ")}; install a newer Claude Code before dispatch` };
      return { ok: true, target };
    } catch (error) {
      return { ok: false, error: error.code === "ENOENT"
        ? `failed to spawn ${target.cmd} for the Claude Code capability preflight: ${error.message}`
        : `Claude Code capability preflight failed: ${error.message}` };
    }
  }

  // The prompt is read from stdin. The working directory is the process's own.
  baseArgs({ sandbox, model, reasoningEffort }) {
    // Headless, nobody can answer a permission prompt: permissions are bypassed
    // and the guard hook decides instead.
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions",
      // A worker must not inherit this supervisor and start a second orchestration tree.
      "--strict-mcp-config"];
    if (sandbox === "read-only") args.push("--disallowed-tools", "Edit", "Write", "MultiEdit", "NotebookEdit");
    if (model) args.push("--model", model);
    if (EFFORTS.has(reasoningEffort)) args.push("--effort", reasoningEffort);
    return args;
  }

  startArgs({ sandbox, model, reasoningEffort }) {
    return this.baseArgs({ sandbox, model, reasoningEffort });
  }

  resumeArgs(task) {
    return [...this.baseArgs({ sandbox: task.sandbox, model: task.model, reasoningEffort: task.reasoning_effort }), "--resume", task.thread_id];
  }

  launchArgs({ args, outputSchema }) {
    const guard = fileURLToPath(new URL("./tool-guard.js", import.meta.url));
    const settings = { hooks: { PreToolUse: [{ matcher: "Bash|Edit|Write|MultiEdit|NotebookEdit",
      hooks: [{ type: "command", command: `${quoteCommand(process.execPath)} ${quoteCommand(guard)}` }] }] } };
    const launch = [...args, "--settings", JSON.stringify(settings)];
    if (outputSchema) launch.push("--json-schema", JSON.stringify(JSON.parse(readFileSync(workerReportSchemaPath, "utf8"))));
    return launch;
  }

  start(target, args, options) {
    return spawnProcess(target.cmd, [...target.prefixArgs, ...args], options);
  }

  toEvents(line) {
    return this.translate(JSON.parse(line));
  }

  // The translated events are the supervisor's vocabulary, which the shared reducer reads.
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
    return describeProcess(pid).includes("claude");
  }
}

export const claudeRunner = new ClaudeRunnerAdapter();
