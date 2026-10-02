import { createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { join, basename } from "node:path";
import { appendTaskEvent, getTask, readTaskEvents, taskRunPath, upsertTask } from "./task-store.js";
import { applyCodexEvent } from "./event-parser.js";
import { worktreesDir } from "./paths.js";

const processes = new Map();
const defaultCodexBin = process.env.CODEX_BIN?.trim() || "codex";
const defaultGitBin = process.env.GIT_BIN?.trim() || "git";
const allowedReasoningEfforts = new Set(["minimal", "low", "medium", "high"]);

function splitLines(buffer, chunk) {
  const next = buffer + chunk;
  const lines = next.split(/\r?\n/);
  return { lines: lines.slice(0, -1), rest: lines.at(-1) ?? "" };
}

async function ensureWorktree(cwd, taskId) {
  const taskWorktreeDir = join(worktreesDir, taskId);
  await mkdir(worktreesDir, { recursive: true });
  const gitDir = join(cwd, ".git");
  if (!(await exists(cwd)) || !(await exists(gitDir))) {
    return null;
  }
  try {
    await rm(taskWorktreeDir, { recursive: true, force: true });
    const branch = `codex/${taskId}`;
    await runCommand(defaultGitBin, ["-C", cwd, "worktree", "add", "--detach", taskWorktreeDir, "HEAD"]);
    await runCommand(defaultGitBin, ["-C", taskWorktreeDir, "switch", "-c", branch]);
    return taskWorktreeDir;
  } catch {
    return null;
  }
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", ...options });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
    child.on("error", reject);
  });
}

export async function createCodexWorker({
  title,
  task,
  cwd,
  sandbox = "workspace-write",
  model = null,
  reasoningEffort = "high",
  skipGitRepoCheck = true,
  followupOf = null,
  useWorktree = true
}) {
  if (!task || typeof task !== "string") {
    throw new Error("task is required");
  }
  if (!cwd || typeof cwd !== "string") {
    throw new Error("cwd is required");
  }
  if (!allowedReasoningEfforts.has(reasoningEffort)) {
    throw new Error(`unsupported reasoningEffort: ${reasoningEffort}`);
  }

  const id = `codex-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const projectRoot = cwd;
  const worktreePath = useWorktree ? await ensureWorktree(projectRoot, id) : null;
  const effectiveCwd = worktreePath ?? projectRoot;
  let record = {
    id,
    title: title || task.split("\n").find(Boolean)?.slice(0, 80) || "Codex worker",
    worker: "codex",
    status: "queued",
    phase: "queued",
    cwd: effectiveCwd,
    project_root: projectRoot,
    sandbox,
    model,
    reasoning_effort: reasoningEffort,
    skip_git_repo_check: skipGitRepoCheck,
    followup_of: followupOf,
    worktree_path: worktreePath,
    prompt: task,
    changed_files: [],
    commands: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    run_log: taskRunPath(id)
  };
  await upsertTask(record);

  const args = ["exec", "--json", "--cd", effectiveCwd, "--sandbox", sandbox];
  if (skipGitRepoCheck) args.push("--skip-git-repo-check");
  if (model) args.push("--model", model);
  args.push("-c", `model_reasoning_effort="${reasoningEffort}"`);
  args.push("-");

  const child = spawn(defaultCodexBin, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1" }
  });

  processes.set(id, child);
  const logStream = createWriteStream(taskRunPath(id), { flags: "a" });
  child.stdin.end(task);

  record = {
    ...record,
    status: "running",
    phase: "starting",
    pid: child.pid,
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  await upsertTask(record);

  let stdoutRest = "";
  child.stdout.on("data", async (chunk) => {
    const split = splitLines(stdoutRest, chunk.toString("utf8"));
    stdoutRest = split.rest;
    for (const line of split.lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        logStream.write(`${JSON.stringify(event)}\n`);
        await appendTaskEvent(id, event);
        record = applyCodexEvent(record, event);
        record.updated_at = new Date().toISOString();
        await upsertTask(record);
      } catch (error) {
        logStream.write(JSON.stringify({ type: "supervisor.parse_error", line, error: error.message }) + "\n");
      }
    }
  });

  let stderr = "";
  child.stderr.on("data", async (chunk) => {
    stderr += chunk.toString("utf8");
    record = {
      ...record,
      stderr_tail: stderr.slice(-4000),
      updated_at: new Date().toISOString()
    };
    await upsertTask(record);
  });

  child.on("exit", async (code, signal) => {
    processes.delete(id);
    logStream.end();
    const terminalStatus = record.status === "completed" ? "completed" : code === 0 ? "completed" : "failed";
    record = {
      ...record,
      status: terminalStatus,
      phase: terminalStatus,
      exit_code: code,
      signal,
      current_command: null,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    await upsertTask(record);
  });

  return record;
}

export async function cancelCodexWorker(taskId) {
  const child = processes.get(taskId);
  if (!child) return { cancelled: false, reason: "process_not_found" };
  child.kill("SIGTERM");
  return { cancelled: true };
}

export async function createFollowupWorker({ taskId, followupPrompt, title, cwd, sandbox, model, reasoningEffort }) {
  const parent = await getTask(taskId);
  if (!parent) {
    throw new Error(`task not found: ${taskId}`);
  }
  const recentEvents = await readTaskEvents(taskId, 20);
  const prompt = [
    "You are continuing a previous Codex worker run.",
    "",
    `Parent task ID: ${parent.id}`,
    `Parent status: ${parent.status}`,
    `Parent title: ${parent.title}`,
    "",
    "Parent prompt:",
    parent.prompt,
    "",
    "Parent recent summary:",
    `- current_action: ${parent.current_action ?? "-"}`,
    `- current_command: ${parent.current_command ?? "-"}`,
    `- changed_files: ${(parent.changed_files ?? []).join(", ") || "-"}`,
    `- last_message: ${parent.last_message ?? "-"}`,
    "",
    "Parent recent events:",
    ...recentEvents.map((event) => `- ${JSON.stringify(event)}`),
    "",
    "Follow-up instruction:",
    followupPrompt
  ].join("\n");

  return createCodexWorker({
    title: title ?? `Follow-up for ${parent.id}`,
    task: prompt,
    cwd: cwd ?? parent.project_root ?? parent.cwd,
    sandbox: sandbox ?? parent.sandbox,
    model: model ?? parent.model,
    reasoningEffort: reasoningEffort ?? parent.reasoning_effort ?? "high",
    skipGitRepoCheck: parent.skip_git_repo_check,
    followupOf: parent.id,
    useWorktree: true
  });
}
