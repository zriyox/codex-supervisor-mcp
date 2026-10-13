// The supervisor's own run of a worker's acceptance commands.
//
// A worker's report says what it did; its command history says what it ran.
// Neither says whether the work is right. The one thing a harness can check
// is a criterion the dispatcher wrote down: run these commands in the
// worktree once the worker has exited, every one must exit 0. The worker
// never grades its own homework here: the commands run after it is gone,
// in a process it did not start, and the verdict is recorded next to its
// report so a reviewer sees both.
//
// The commands are shell lines written by the main thread, so they run with
// the supervisor's own privileges, exactly as if the main thread had run
// them itself. That is the trust model and it is stated in the tool text.
import { spawn, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, isAbsolute, relative, resolve } from "node:path";
import { findBinaryPath } from "./bin-resolver.js";
import { compareFailureBaseline } from "./acceptance-baseline.js";

export const DEFAULT_ACCEPTANCE_TIMEOUT_MS = 10 * 60 * 1000;
export const MAX_ACCEPTANCE_COMMANDS = 10;
const OUTPUT_TAIL_BYTES = 2000;
const KILL_GRACE_MS = 3000;

// One string or a list; blanks dropped; an empty list is "not configured".
export function normalizeAcceptance(value) {
  const list = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const commands = list.filter((entry) => entry != null && entry !== "").map((entry) => {
    if (typeof entry === "string") return entry.trim();
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.command !== "string" || !entry.command.trim()) throw new Error("acceptance requires a command string or structured check");
    if (typeof entry.reportPath !== "string" || !entry.reportPath || isAbsolute(entry.reportPath) || /^[A-Za-z]:|^\\\\/.test(entry.reportPath) || entry.reportPath.split(/[\\/]/).includes("..")) throw new Error("reportPath must stay inside the worktree");
    const validation = compareFailureBaseline(entry.baseline, {
      complete: true, identity: entry.baseline?.identity,
      executed: [...new Set([...(entry.baseline?.required ?? []), ...(entry.baseline?.failures ?? []).map((item) => item?.test_id)])],
      skipped: [], failures: entry.baseline?.failures
    });
    // Validation errors concern the contract; diff results concern actual
    // failures, which do not exist at normalization time.
    if (validation.errors.length) throw new Error(`invalid acceptance baseline: ${validation.errors.join("; ")}`);
    return { command: entry.command.trim(), reportPath: entry.reportPath, baseline: structuredClone(entry.baseline) };
  }).filter(Boolean);
  if (commands.length === 0) return null;
  if (commands.length > MAX_ACCEPTANCE_COMMANDS) {
    const error = new Error(`acceptance lists ${commands.length} commands; at most ${MAX_ACCEPTANCE_COMMANDS} are run`);
    error.code = "too_many_acceptance_commands";
    throw error;
  }
  return commands;
}

async function readCheckEvidence(check, cwd, checkId, baseCommit) {
  try {
    const root = await realpath(cwd);
    const path = resolve(cwd, check.reportPath);
    const canonical = await realpath(path);
    const outside = relative(root, canonical);
    if (outside === ".." || outside.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(outside)) throw new Error("reportPath escapes the worktree");
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error("report must be a regular file of at most 1 MiB");
    const report = JSON.parse(await readFile(path, "utf8"));
    if (report.check_id !== checkId) throw new Error("report check_id does not belong to this check; reused evidence is invalid");
    if (baseCommit && check.baseline.identity.base_commit !== baseCommit) throw new Error("approved baseline base_commit differs from the current run base");
    const baseline = compareFailureBaseline(check.baseline, report);
    return { passed: baseline.passed, baseline };
  } catch (error) {
    return { passed: false, error: `acceptance evidence: ${error.message}` };
  }
}

function tail(buffer) {
  if (buffer.length <= OUTPUT_TAIL_BYTES) return buffer.toString("utf8").trim();
  let start = buffer.length - OUTPUT_TAIL_BYTES;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
  return `…${buffer.subarray(start).toString("utf8").trim()}`;
}

// Kills the command and everything it started. A test runner forks its own
// processes; killing only the shell would leave them running in the
// worktree, where the next git read or land would trip over them.
function killTree(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", timeout: 5000, windowsHide: true });
    } catch {
      child.kill();
    }
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  setTimeout(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }, KILL_GRACE_MS).unref();
}

function runOne(command, { cwd, env, timeoutMs, onSpawn }) {
  return new Promise((resolveRun) => {
    const startedAt = Date.now();
    const chunks = [];
    let total = 0;
    let child;
    try {
      // cmd.exe and the default POSIX sh report only the last pipeline stage.
      // Use one explicit shell contract on every platform, including Windows
      // installations where Git's Bash is not on a GUI client's PATH.
      let bash = "/bin/bash";
      if (process.platform === "win32") {
        const git = findBinaryPath("git", { env });
        const candidates = git ? [
          join(dirname(git), "..", "bin", "bash.exe"),
          join(dirname(git), "..", "usr", "bin", "bash.exe"),
          join(dirname(git), "bash.exe")
        ] : [];
        for (const root of [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs")].filter(Boolean)) {
          candidates.push(join(root, "Git", "bin", "bash.exe"));
        }
        const onPath = findBinaryPath("bash", { env });
        // Windows' System32/WindowsApps launchers start WSL, which cannot run
        // the worker's Windows paths and toolchain under the same contract.
        if (onPath && !/[\\/](?:System32|WindowsApps)[\\/]/i.test(onPath)) candidates.push(onPath);
        bash = candidates.find((candidate) => existsSync(candidate));
        if (!bash) throw new Error("acceptance requires Git for Windows Bash; install Git for Windows or add its bin directory to PATH");
      } else if (!existsSync(bash)) {
        bash = findBinaryPath("bash", { env });
        if (!bash) throw new Error("acceptance requires Bash with pipefail; install Bash or add it to PATH");
      }
      const shellEnv = { ...env };
      // Non-interactive Bash reads BASH_ENV even with --noprofile/--norc. A
      // user's startup file must not switch off the acceptance failure flags.
      delete shellEnv.BASH_ENV;
      delete shellEnv.ENV;
      child = spawn(bash, ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", command], {
        cwd,
        env: shellEnv,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32"
      });
    } catch (error) {
      resolveRun({ command, exit_code: null, signal: null, duration_ms: 0, timed_out: false, output_tail: `spawn failed: ${error.message}` });
      return;
    }
    const collect = (chunk) => {
      // Keep the pipe drained; only the tail is kept.
      chunks.push(chunk);
      total += chunk.length;
      while (total - chunks[0].length > OUTPUT_TAIL_BYTES && chunks.length > 1) total -= chunks.shift().length;
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.stdout.on("error", () => {});
    child.stderr.on("error", () => {});
    let timedOut = false;
    let killed = false;
    let spawnError = null;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    timer.unref();
    const kill = () => {
      killed = true;
      killTree(child);
    };
    onSpawn?.(kill);
    let finished = false;
    const finish = (code, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolveRun({
        command,
        exit_code: code,
        signal: signal ?? null,
        duration_ms: Date.now() - startedAt,
        timed_out: timedOut,
        cancelled: killed && !timedOut,
        output_tail: spawnError ? `spawn failed: ${spawnError.message}` : tail(Buffer.concat(chunks))
      });
    };
    child.on("error", (error) => {
      spawnError = error;
      finish(null, null);
    });
    child.on("close", (code, signal) => finish(code, signal));
  });
}

// Runs every command in order and returns the verdict. `control.kill` is
// filled in so a cancel can stop the command that is running; `control.isCancelled`
// is consulted between commands.
export async function runAcceptance(commands, { cwd, env = process.env, timeoutMs = DEFAULT_ACCEPTANCE_TIMEOUT_MS, run = null, taskId = null, baseCommit = null, control = {} } = {}) {
  const startedAt = new Date().toISOString();
  if (!cwd || !existsSync(cwd)) {
    return { status: "failed", passed: false, run, started_at: startedAt, finished_at: new Date().toISOString(), error: "cwd_missing", cwd, checks: [] };
  }
  const checks = [];
  let passed = true;
  const checkEnv = {
    ...env,
    NO_COLOR: "1",
    CI: env.CI ?? "1",
    CODEX_SUPERVISOR_TASK_ID: taskId ?? "",
    CODEX_SUPERVISOR_BASE_COMMIT: baseCommit ?? "",
    CODEX_SUPERVISOR_RUN: run == null ? "" : String(run)
  };
  for (const check of normalizeAcceptance(commands) ?? []) {
    const command = typeof check === "string" ? check : check.command;
    if (control.isCancelled?.()) {
      return { status: "cancelled", passed: null, run, started_at: startedAt, finished_at: new Date().toISOString(), checks };
    }
    const checkId = randomUUID();
    const result = await runOne(command, {
      cwd,
      env: { ...checkEnv, CODEX_SUPERVISOR_CHECK_ID: checkId },
      timeoutMs,
      onSpawn: (kill) => {
        control.kill = kill;
      }
    });
    control.kill = null;
    result.passed = result.exit_code === 0 && !result.timed_out && !result.cancelled;
    if (typeof check !== "string" && result.passed) Object.assign(result, await readCheckEvidence(check, cwd, checkId, baseCommit));
    checks.push(result);
    if (result.cancelled) {
      return { status: "cancelled", passed: null, run, started_at: startedAt, finished_at: new Date().toISOString(), checks };
    }
    if (!result.passed) {
      passed = false;
      break;
    }
  }
  return { status: passed ? "passed" : "failed", passed, run, started_at: startedAt, finished_at: new Date().toISOString(), checks };
}

// The one-word view for a status row: what the last run concluded.
export function acceptanceVerdict(task) {
  const results = task?.acceptance_results;
  if (!results) return null;
  return results.status ?? null;
}
