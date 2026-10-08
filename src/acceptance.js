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

export const DEFAULT_ACCEPTANCE_TIMEOUT_MS = 10 * 60 * 1000;
export const MAX_ACCEPTANCE_COMMANDS = 10;
const OUTPUT_TAIL_BYTES = 2000;
const KILL_GRACE_MS = 3000;

// One string or a list; blanks dropped; an empty list is "not configured".
export function normalizeAcceptance(value) {
  const list = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const commands = list.map((entry) => String(entry ?? "").trim()).filter(Boolean);
  if (commands.length === 0) return null;
  if (commands.length > MAX_ACCEPTANCE_COMMANDS) {
    const error = new Error(`acceptance lists ${commands.length} commands; at most ${MAX_ACCEPTANCE_COMMANDS} are run`);
    error.code = "too_many_acceptance_commands";
    throw error;
  }
  return commands;
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
      child = spawn(command, {
        shell: true,
        cwd,
        env,
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
    const finish = (code, signal) => {
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
export async function runAcceptance(commands, { cwd, env = process.env, timeoutMs = DEFAULT_ACCEPTANCE_TIMEOUT_MS, run = null, control = {} } = {}) {
  const startedAt = new Date().toISOString();
  if (!cwd || !existsSync(cwd)) {
    return { status: "failed", passed: false, run, started_at: startedAt, finished_at: new Date().toISOString(), error: "cwd_missing", cwd, checks: [] };
  }
  const checks = [];
  let passed = true;
  for (const command of commands) {
    if (control.isCancelled?.()) {
      return { status: "cancelled", passed: null, run, started_at: startedAt, finished_at: new Date().toISOString(), checks };
    }
    const result = await runOne(command, {
      cwd,
      env: { ...env, NO_COLOR: "1", CI: env.CI ?? "1" },
      timeoutMs,
      onSpawn: (kill) => {
        control.kill = kill;
      }
    });
    control.kill = null;
    checks.push(result);
    if (result.cancelled) {
      return { status: "cancelled", passed: null, run, started_at: startedAt, finished_at: new Date().toISOString(), checks };
    }
    if (result.exit_code !== 0) {
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
