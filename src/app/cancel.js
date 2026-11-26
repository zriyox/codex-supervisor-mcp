import "./compose.js";
import { describeProcess } from "../infra/process.js";
import { getTask, upsertTask } from "../infra/store/tasks.js";
import { loadRunner } from "../runners/registry.js";
import { acceptanceRuns, cancelledTasks, processes } from "./run-state.js";

// A pid on a row may have been reused; only a process that looks like this runner's CLI is signalled.
const isWorkerProcess = (task, runner) => runner.ownsPid(task.pid, describeProcess);

// Ends a worker and, on Windows, its whole process tree: the direct child there
// is the JS wrapper around the native Codex binary, so terminating it alone
// would leave the real CLI running and the task stuck in `running`.
export function terminateChild(child, runner) {
  runner.cancelChild(child);
}

export async function cancelCodexWorker(taskId) {
  const acceptance = acceptanceRuns.get(taskId);
  if (acceptance) {
    acceptance.cancelled = true;
    acceptance.kill?.();
    return { cancelled: true, via: "acceptance", pid: null };
  }
  const task = await getTask(taskId);
  // A runner from outside the package may not be loaded in this process yet.
  const runner = await loadRunner(task?.worker);
  const child = processes.get(taskId);
  if (child) {
    cancelledTasks.add(taskId);
    terminateChild(child, runner);
    return { cancelled: true, via: "process_handle", pid: child.pid ?? null };
  }
  // Another MCP process owns the handle; fall back to the pid recorded on disk.
  if (task?.acceptance_results?.status === "running" && await isPidAlive(task.acceptance_results.supervisor_pid)) {
    await upsertTask({ ...task, cancel_requested_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    return { cancelled: true, via: "acceptance", pid: null };
  }
  if (task?.pid && (await isPidAlive(task.pid)) && isWorkerProcess(task, runner)) {
    try {
      runner.cancelPid(task.pid);
      return { cancelled: true, via: "pid", pid: task.pid };
    } catch (error) {
      return { cancelled: false, reason: "kill_failed", message: error.message, pid: task.pid };
    }
  }
  return { cancelled: false, reason: "process_not_found" };
}

export async function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
