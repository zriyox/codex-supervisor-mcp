import "./compose.js";
import { runSync, SHARED_CONSOLE_ENV, spawnProcess } from "../infra/process.js";
import { upsertTask } from "../infra/store/tasks.js";
import { compileWorkerContext } from "./context-compiler.js";
import { failedStart, MAX_RUN_HOST_PROMPT_BYTES, RUN_HOST_STARTUP_TIMEOUT_MS } from "./run-state.js";
import { closeSync, existsSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The MCP client may disappear at any point. A detached process owns the
// streams, exit write and acceptance until all three settle; IPC is only a
// startup handshake and never the channel carrying worker results.
export async function startTrackedRun(job) {
  if (Buffer.byteLength(String(job.prompt ?? ""), "utf8") > MAX_RUN_HOST_PROMPT_BYTES) {
    const result = failedStart(job.record, `worker prompt is too large for the detached run host IPC channel (maximum ${MAX_RUN_HOST_PROMPT_BYTES} bytes); reduce task text and move materials to context files`);
    await upsertTask(result.record);
    return result;
  }
  const compiled = await compileWorkerContext(job.record, { attempt: (job.record.run_count ?? 0) + 1 });
  job.record = {
    ...job.record,
    input_context: {
      ...job.record.input_context,
      context: compiled.sourceRefs,
      source_refs: compiled.sourceRefs,
      content_hash: compiled.contentHash,
      context_snapshot_id: compiled.snapshot.id,
      context_snapshot_tokens: compiled.snapshot.estimated_tokens,
      context_fact_count: compiled.factCount
    }
  };
  job.prompt = `${compiled.text}\n\n${job.prompt}\n\nRequired input refs (read-only): ${JSON.stringify(compiled.sourceRefs)}\nRequired contracts: ${JSON.stringify(job.record.input_context.contracts ?? [])}`;
  const hostLogPath = job.logPath.endsWith(".jsonl")
    ? job.logPath.replace(/\.jsonl$/, ".host.log")
    : `${job.logPath}.host.log`;
  if (process.platform === "win32") {
    const started = await startHostInSharedConsole(job, hostLogPath);
    if (!started.ok) await upsertTask(started.record);
    return started;
  }
  let hostLogFd;
  try {
    hostLogFd = openSync(hostLogPath, "a");
  } catch (error) {
    const result = failedStart(job.record, `cannot open run host log ${hostLogPath}: ${error.message}`);
    await upsertTask(result.record);
    return result;
  }
  let host;
  try {
    host = spawnProcess(process.execPath, [fileURLToPath(new URL("../run-host/entry.js", import.meta.url)), "--run-host"], {
      detached: true, stdio: ["ignore", hostLogFd, hostLogFd, "ipc"],
      env: process.env, windowsHide: true
    });
  } finally {
    closeSync(hostLogFd);
  }
  const started = await new Promise((resolveStart) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      host.removeAllListeners("message");
      host.removeAllListeners("exit");
      if (host.connected) host.disconnect();
      host.unref();
      resolveStart(result);
    };
    const timer = setTimeout(() => {
      host.kill();
      finish(failedStart(job.record, "run host startup timed out"));
    }, RUN_HOST_STARTUP_TIMEOUT_MS);
    host.once("message", finish);
    host.once("error", (error) => finish(failedStart(job.record, `run host startup failed: ${error.message}`)));
    host.once("exit", (code) => finish(failedStart(job.record, `run host exited before startup: ${code}`)));
    host.send(job, (error) => {
      if (error) finish(failedStart(job.record, `run host IPC failed: ${error.message}`));
    });
  });
  if (!started.ok) await upsertTask(started.record);
  return started;
}

// On Windows the run host must share this process's hidden console and live
// outside the job that ends this process's children: `start /b` gives both.
// That path has no IPC channel, so the job and the startup answer are files.
async function startHostInSharedConsole(job, hostLogPath) {
  const base = hostLogPath.replace(/\.host\.log$/, "");
  const jobPath = `${base}.job.json`;
  const ackPath = `${base}.ack.json`;
  const entry = fileURLToPath(new URL("../run-host/entry.js", import.meta.url));
  for (const path of [process.execPath, entry, jobPath, ackPath]) {
    if (/[%&^|<>"]/.test(path)) {
      return failedStart(job.record, `run host cannot launch: path contains a cmd.exe special character (% & ^ | < > "): ${path}`);
    }
  }
  rmSync(ackPath, { force: true });
  writeFileSync(jobPath, JSON.stringify(job));
  const line = `/d /c start "" /b "${process.execPath}" "${entry}" --run-host --job-file "${jobPath}" --ack-file "${ackPath}"`;
  let hostLogFd;
  try {
    hostLogFd = openSync(hostLogPath, "a");
  } catch (error) {
    rmSync(jobPath, { force: true });
    return failedStart(job.record, `cannot open run host log ${hostLogPath}: ${error.message}`);
  }
  let spawnError = null;
  try {
    const launcher = spawnProcess(process.env.ComSpec || "cmd.exe", [line], {
      stdio: ["ignore", hostLogFd, hostLogFd],
      env: { ...process.env, [SHARED_CONSOLE_ENV]: "1" },
      windowsVerbatimArguments: true,
      windowsHide: true
    });
    launcher.on("error", (error) => {
      spawnError = error;
    });
    launcher.unref();
  } finally {
    closeSync(hostLogFd);
  }
  const deadline = Date.now() + RUN_HOST_STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (spawnError) {
      rmSync(jobPath, { force: true });
      return failedStart(job.record, `run host launcher failed: ${spawnError.message}`);
    }
    if (existsSync(ackPath)) {
      let answer;
      try {
        answer = JSON.parse(readFileSync(ackPath, "utf8"));
      } catch (error) {
        return failedStart(job.record, `run host answer unreadable (${error.message}); host log: ${hostLogPath}`);
      } finally {
        rmSync(ackPath, { force: true });
      }
      return answer;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  return failedStart(job.record, `run host startup timed out; ${abandonLateHost(jobPath)}; host log: ${hostLogPath}`);
}

// The host claims the job by renaming the job file; whoever renames it first
// owns the start. A host that claimed it after the deadline is killed.
function abandonLateHost(jobPath) {
  try {
    renameSync(jobPath, `${jobPath}.abandoned`);
    rmSync(`${jobPath}.abandoned`, { force: true });
    return "the host never claimed the job";
  } catch (error) {
    if (error.code !== "ENOENT") return `job file could not be withdrawn: ${error.message}`;
  }
  const pidPath = `${jobPath}.pid`;
  if (!existsSync(pidPath)) return "the host claimed the job but left no pid";
  const pid = Number(readFileSync(pidPath, "utf8"));
  rmSync(pidPath, { force: true });
  try {
    runSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", timeout: 5000, windowsHide: true });
    return `the late host ${pid} was stopped`;
  } catch (error) {
    return `the late host ${pid} could not be stopped: ${error.message}`;
  }
}
