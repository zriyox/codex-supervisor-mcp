// End-to-end test against the real `codex` CLI: worktree creation, event
// parsing, thread id capture and a cross-process `codex exec resume`.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, "..");
const home = await mkdtemp(join(tmpdir(), "supervisor-real-"));
const repo = join(home, "repo");
await mkdir(repo, { recursive: true });

const git = (args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
git(["init", "-q", "-b", "main"]);
git(["config", "user.email", "test@example.com"]);
git(["config", "user.name", "Supervisor Test"]);
await writeFile(join(repo, "README.md"), "# test repo\n");
git(["add", "."]);
git(["commit", "-q", "-m", "init"]);

const PROMPT = "Reply with exactly the word PONG and nothing else. Do not modify, create, or delete any files.";
const TERMINAL = ["completed", "failed", "cancelled", "lost"];
const VALID_PHASES = ["starting", "thinking", "command", "editing", "reporting"];

async function withServer(fn) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(here, "mcp-server.js")],
    cwd: projectRoot,
    env: { ...process.env, SUPERVISOR_HOME: home },
    stderr: "pipe"
  });
  const client = new Client({ name: "supervisor-real-codex", version: "1.0.0" });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

const parse = (result) => JSON.parse(result.content?.[0]?.text ?? "null");
const call = (client, name, args = {}) => client.callTool({ name, arguments: args }).then(parse);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(client, taskId, predicate, timeoutMs = 300000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await call(client, "get_codex_worker_status", { task_id: taskId });
    if (predicate(last)) return last;
    await sleep(1000);
  }
  throw new Error(`timed out for ${taskId}: ${JSON.stringify(last)?.slice(0, 600)}`);
}

console.log("creating a worker with the real codex CLI ...");

// Create and poll inside one MCP session: a worker's lifecycle is currently
// bound to the MCP process that spawned it (the resident daemon is next phase).
const first = await withServer(async (client) => {
  const created = await call(client, "create_codex_worker", {
    title: "real codex pong",
    task: PROMPT,
    cwd: repo,
    sandbox: "read-only",
    reasoningEffort: "low",
    ownedPaths: ["README.md"],
    goal: { objective: "Have the real codex CLI answer PONG without touching files" }
  });
  console.log(`  worker=${created.id} status=${created.status} pid=${created.pid}`);

  const seenStatuses = new Set();
  const seenPhases = new Set();
  const deadline = Date.now() + 300000;
  let current = created;
  while (Date.now() < deadline && !TERMINAL.includes(current.status)) {
    seenStatuses.add(current.status);
    if (current.phase) seenPhases.add(current.phase);
    await sleep(700);
    current = await call(client, "get_codex_worker_status", { task_id: created.id });
  }
  seenStatuses.add(current.status);
  if (current.phase) seenPhases.add(current.phase);

  const allowedStatuses = new Set(["queued", "running", ...TERMINAL]);
  for (const status of seenStatuses) assert.ok(allowedStatuses.has(status), `leaked status ${status}`);
  for (const phase of seenPhases) assert.ok(VALID_PHASES.includes(phase), `leaked phase ${phase}`);
  console.log(`  statuses seen: ${[...seenStatuses].join(", ")}`);
  console.log(`  phases seen:   ${[...seenPhases].join(", ") || "(none observed)"}`);

  const events = await call(client, "get_codex_worker_events", { task_id: created.id, limit: 200 });
  const kinds = new Set(events.events.map((event) => event.type));
  assert.ok(kinds.has("thread.started"), `missing thread.started in ${[...kinds]}`);
  assert.ok(kinds.has("turn.completed"), `missing turn.completed in ${[...kinds]}`);
  assert.equal(
    events.events.find((event) => event.type === "thread.started").thread_id,
    current.thread_id,
    "thread.started must match the stored thread id"
  );

  const overview = await call(client, "get_orchestration_overview", {});
  assert.equal(overview.workers.length, 1);

  const summary = await call(client, "get_worker_summary", { task_id: created.id });
  assert.equal(summary.thread_id, current.thread_id);
  console.log(`  summary: ${summary.summary.split("\n")[0]}`);

  const goal = await call(client, "get_worker_goal", { task_id: created.id });
  assert.equal(goal.objective, "Have the real codex CLI answer PONG without touching files");
  assert.equal(goal.needs_attention, false);
  console.log(`  native goal: ${goal.native_goal ? JSON.stringify(goal.native_goal) : "none for this thread"}`);

  return { task: current, id: created.id };
});

const taskId = first.id;
const finished = first.task;

assert.equal(finished.status, "completed", JSON.stringify(finished).slice(0, 900));
assert.equal(finished.phase, null);
assert.equal(finished.error, null, `unexpected error: ${finished.error}`);
assert.match(finished.thread_id ?? "", /^[0-9a-f-]{36}$/, `bad thread_id: ${finished.thread_id}`);
assert.equal(finished.run_count, 1);
assert.ok(finished.last_message, "expected a final agent message");
console.log(`  thread_id=${finished.thread_id}`);
console.log(`  last_message=${JSON.stringify(finished.last_message.slice(0, 120))}`);

// The supervisor must keep its state out of the target repository.
const repoEntries = await readdir(repo);
assert.ok(!repoEntries.includes("data"), `target repo got a data/ dir: ${repoEntries}`);
assert.ok(!repoEntries.includes("worktrees"), `target repo got a worktrees/ dir: ${repoEntries}`);
assert.ok(finished.worktree_path?.startsWith(home), `worktree_path ${finished.worktree_path}`);
assert.ok(await stat(finished.worktree_path).then(() => true, () => false), "worktree should exist");

await withServer(async (client) => {
  const listed = await call(client, "list_codex_workers", { includeHistory: true });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].goal_objective, "Have the real codex CLI answer PONG without touching files");
});

// Resume the SAME Codex session from a brand new MCP server process.
console.log("resuming the same thread from a new MCP process ...");
const resumed = await withServer(async (client) => {
  const started = await call(client, "resume_codex_worker", {
    task_id: taskId,
    prompt: "Reply with exactly the word PONG2 and nothing else."
  });
  assert.equal(started.thread_id, finished.thread_id, "resume must keep the same thread id");
  assert.equal(started.run_count, 2);
  const final = await waitFor(client, taskId, (task) => task.status === "completed" && task.run_count === 2);
  const events = await call(client, "get_codex_worker_events", { task_id: taskId, limit: 500 });
  const starts = events.events.filter((event) => event.type === "thread.started");
  assert.ok(starts.length >= 2, `expected two runs in the event stream, got ${starts.length}`);
  for (const start of starts) assert.equal(start.thread_id, finished.thread_id);
  const summary = await call(client, "get_worker_summary", { task_id: taskId });
  assert.match(summary.summary, /runs: 2/);
  return final;
});

assert.equal(resumed.status, "completed", JSON.stringify(resumed).slice(0, 900));
assert.equal(resumed.thread_id, finished.thread_id);
assert.equal(resumed.resumed_from, taskId);
assert.equal(resumed.error, null);
assert.equal(resumed.last_message && resumed.last_message.length > 0, true, "expected a message from the resumed run");
console.log(`  run_count=${resumed.run_count} thread_id unchanged`);
console.log(`  last_message=${JSON.stringify(resumed.last_message.slice(0, 120))}`);

// A real write run: the edit must land in the worker's own worktree and the
// changed files must be reported, while the target repository stays untouched.
console.log("running a real write worker ...");
const writeRun = await withServer(async (client) => {
  const created = await call(client, "create_codex_worker", {
    title: "real codex write",
    task: "Create a file named NOTES.md in the repository root containing exactly the line: hello from worker",
    cwd: repo,
    sandbox: "workspace-write",
    reasoningEffort: "low",
    ownedPaths: ["NOTES.md"],
    goal: { objective: "Prove a real worker writes only inside its own worktree" }
  });
  const seenPhases = new Set();
  // Wait for the process exit, not just turn.completed: the exit handler is
  // what reconciles changed_files against the worktree.
  const final = await waitFor(client, created.id, (task) => {
    if (task.phase) seenPhases.add(task.phase);
    return TERMINAL.includes(task.status) && task.exit_code !== null;
  });
  return { id: created.id, final, seenPhases };
});

assert.equal(writeRun.final.status, "completed", JSON.stringify(writeRun.final).slice(0, 900));
// The phase depends on how the model edits (patch tool vs shell command);
// changed_files must be right either way.
assert.ok(
  writeRun.final.changed_files.some((path) => path.endsWith("NOTES.md")),
  `changed_files did not include NOTES.md: ${JSON.stringify(writeRun.final.changed_files)}`
);
console.log(`  phases seen:   ${[...writeRun.seenPhases].join(", ") || "(none observed)"}`);
console.log(`  changed_files=${JSON.stringify(writeRun.final.changed_files)}`);

const worktreeNotes = await stat(join(writeRun.final.worktree_path, "NOTES.md")).then(() => true, () => false);
assert.ok(worktreeNotes, "NOTES.md should exist inside the worker worktree");
const repoTouched = await stat(join(repo, "NOTES.md")).then(() => true, () => false);
assert.equal(repoTouched, false, "the target repository must not be written by the worker");
const gitStatus = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).trim();
assert.equal(gitStatus, "", `target repo is dirty: ${gitStatus}`);
console.log("  worktree has NOTES.md, target repo is clean");

console.log(`\nreal codex end-to-end passed  (state dir: ${home})`);
