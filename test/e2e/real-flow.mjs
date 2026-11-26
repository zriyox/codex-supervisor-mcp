#!/usr/bin/env node
// End-to-end check of an installed package against a real CLI: two workers in
// parallel, each through preflight, dispatch, wait, result, diff and land, then
// a cleanup plan. It drives the globally installed server over stdio, so it
// tests what a user gets from `npm i -g`, not the checkout.
//
//   node real-flow.mjs [--keep]
//
// Not part of `npm test`: it needs a logged-in CLI and spends real tokens.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const PACKAGE = process.env.E2E_PACKAGE ?? "codex-supervisor-mcp";
const keep = process.argv.includes("--keep");
const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const packageRoot = join(globalRoot, PACKAGE);
assert.ok(existsSync(packageRoot), `${PACKAGE} is not installed globally at ${packageRoot}`);
const sdk = (path) => import(pathToFileURL(join(packageRoot, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", path)).href);
const { Client } = await sdk("client/index.js");
const { StdioClientTransport } = await sdk("client/stdio.js");
const installed = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));

const home = await mkdtemp(join(tmpdir(), "supervisor-e2e-"));
const repo = join(home, "repo");
await mkdir(repo, { recursive: true });
const git = (args, cwd = repo) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
git(["init", "-q", "-b", "main"]);
git(["config", "user.email", "e2e@example.com"]);
git(["config", "user.name", "Supervisor E2E"]);
await writeFile(join(repo, "alpha.txt"), "alpha\n");
await writeFile(join(repo, "beta.txt"), "beta\n");
git(["add", "."]);
git(["commit", "-q", "-m", "init"]);

const steps = [];
const step = (name, detail) => {
  steps.push({ step: name, ...detail });
  console.error(`ok  ${name} ${JSON.stringify(detail)}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TERMINAL = ["completed", "failed", "cancelled", "lost", "timed_out"];

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(packageRoot, installed.bin[PACKAGE] ?? "src/mcp-server.js")],
  cwd: home,
  env: {
    ...process.env, SUPERVISOR_HOME: home, AGENT_SUPERVISOR_NO_UPDATE_CHECK: "1", AGENT_SUPERVISOR_NO_AUTO_UPDATE: "1", AGENT_SUPERVISOR_SKIP_SKILL_SYNC: "1",
    // Sweep on every poll and treat unlanded work as past its hold period, so cleanup can be observed in one run.
    AGENT_SUPERVISOR_CLEANUP_INTERVAL_MS: "0", AGENT_SUPERVISOR_CLEANUP_HOLD_DAYS: "0", AGENT_SUPERVISOR_TOOLS: ""
  },
  stderr: "inherit"
});
const client = new Client({ name: "supervisor-e2e", version: "1.0.0" });
await client.connect(transport);
// E2E_RUNNER=claude runs the same flow with Claude Code workers.
const RUNNER = process.env.E2E_RUNNER ?? null;
const call = async (name, given = {}) => {
  const dispatches = name === "create_worker" || (name === "preflight_worker" && given.probe_commands);
  const args = RUNNER && dispatches ? { ...given, runner: RUNNER } : given;
  const reply = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
  const text = reply.content?.[0]?.text ?? "null";
  try { return JSON.parse(text); } catch { return { raw: text }; }
};

async function settle(taskId, timeoutMs = 600000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await call("get_worker", { task_id: taskId, include: ["status"] });
    // completed and failed are written before the exit code; the others end by a signal and may have none.
    const exited = last.exit_code !== null && last.exit_code !== undefined;
    if (TERMINAL.includes(last.status) && (exited || !["completed", "failed"].includes(last.status))) return last;
    await sleep(3000);
  }
  throw new Error(`timed out waiting for ${taskId}: ${JSON.stringify(last)?.slice(0, 500)}`);
}

const WORK = [
  { file: "alpha.txt", seed: "alpha", line: "alpha-done" },
  { file: "beta.txt", seed: "beta", line: "beta-done" }
];
const session = `e2e-${Date.now()}`;
let failure = null;

try {
  const tools = (await client.listTools()).tools;
  const schemaChars = tools.reduce((sum, tool) => sum + JSON.stringify(tool).length, 0);
  const largest = Math.max(...tools.map((tool) => JSON.stringify(tool).length));
  assert.equal(tools.length, 14, `default tools: ${tools.map((tool) => tool.name).join(", ")}`);
  assert.ok(schemaChars <= 16000, `tools/list is ${schemaChars} characters`);
  assert.ok(largest <= 2500, `the largest tool is ${largest} characters`);
  step("tools/list", { version: installed.version, count: tools.length, schema_chars: schemaChars, largest });

  // A name from before 1.0 and a misspelled argument must both be refused, not ignored.
  const oldName = await client.callTool({ name: "create_codex_worker", arguments: {} }).catch((error) => ({ isError: true, thrown: error.message }));
  assert.ok(oldName.isError, "the old tool name still answers");
  const oldArgument = await client.callTool({ name: "wait_workers", arguments: { task_ids: ["x"], timeoutMs: 1000 } }).catch((error) => ({ isError: true, thrown: error.message }));
  assert.ok(oldArgument.isError, "an unknown argument was accepted");
  step("old names refused", { tool: true, argument: true });

  const contract = (work) => ({ cwd: repo, sandbox: { mode: "workspace-write" }, owned_paths: [work.file] });

  const probes = await Promise.all(WORK.map((work) => call("preflight_worker", { ...contract(work), title: `probe ${work.file}`, probe_commands: ["git status --short"] })));
  for (const probe of probes) assert.ok(probe.id, `preflight did not start: ${JSON.stringify(probe).slice(0, 400)}`);
  await Promise.all(probes.map((probe) => settle(probe.id)));
  for (const probe of probes) {
    const verdict = await call("get_worker", { task_id: probe.id, include: ["preflight"] });
    assert.equal(verdict.status, "passed", `preflight ${probe.id}: ${JSON.stringify(verdict).slice(0, 600)}`);
  }
  step("preflight", { passed: probes.length });

  const created = await Promise.all(WORK.map((work, index) => call("create_worker", {
    ...contract(work),
    title: `append to ${work.file}`,
    task: `Append exactly one new line containing ${work.line} to the end of ${work.file}. Change nothing else. Then run: grep -q ${work.line} ${work.file}`,
    goal: { objective: `${work.file} ends with a line ${work.line}` },
    acceptance: { commands: [`grep -q ${work.line} ${work.file}`] },
    preflight_id: probes[index].id,
    session: { id: session, title: "e2e real flow" }
  })));
  for (const worker of created) assert.ok(worker.id, `create failed: ${JSON.stringify(worker).slice(0, 600)}`);
  const ids = created.map((worker) => worker.id);
  // A server that ignored SUPERVISOR_HOME would be working on the real store.
  assert.ok(existsSync(join(home, "data", "supervisor.sqlite")), `SUPERVISOR_HOME=${home} was ignored`);
  step("create", { ids });

  const waited = await call("wait_workers", { task_ids: ids, mode: "all" });
  step("wait", { termination_reason: waited.termination_reason ?? null });
  const settled = await Promise.all(ids.map((id) => settle(id)));
  for (const task of settled) assert.equal(task.status, "completed", `worker ${task.id} ended ${task.status}: ${JSON.stringify(task).slice(0, 600)}`);
  step("settled", { statuses: settled.map((task) => task.status) });

  for (const [index, id] of ids.entries()) {
    const result = await call("get_worker", { task_id: id, include: ["result"] });
    assert.equal(result.acceptance?.passed, true, `acceptance for ${id}: ${JSON.stringify(result.acceptance).slice(0, 600)}`);
    const diff = await call("get_worker_diff", { task_id: id });
    const files = (diff.files ?? []).map((file) => file.path);
    assert.deepEqual(files, [WORK[index].file], `diff for ${id} touched ${JSON.stringify(files)}`);
  }
  step("result+diff", { accepted: ids.length });

  for (const [index, id] of ids.entries()) {
    const landed = await call("land_worker", { task_id: id, commit_message: `Append ${WORK[index].line} to ${WORK[index].file}` });
    assert.ok(landed.landed_head || landed.landed || landed.head, `land ${id}: ${JSON.stringify(landed).slice(0, 600)}`);
  }
  for (const work of WORK) assert.equal(await readFile(join(repo, work.file), "utf8"), `${work.seed}\n${work.line}\n`);
  assert.equal(git(["status", "--porcelain"]), "", "integration checkout is dirty after land");
  step("land", { commits: Number(git(["rev-list", "--count", "HEAD"])) });

  const plan = await call("cleanup", { action: "plan", task_ids: ids });
  assert.deepEqual((plan.items ?? []).map((item) => item.verdict), ["safe", "safe"], `landed work must be safe: ${JSON.stringify(plan.items).slice(0, 600)}`);
  step("cleanup", { summary: plan.summary, action: "plan" });

  // A third worker leaves an uncommitted draft and is never landed.
  const draft = await call("create_worker", {
    cwd: repo, sandbox: { mode: "workspace-write" }, owned_paths: ["notes.txt"],
    title: "leave a draft",
    task: "Create a file notes.txt containing exactly one line: draft-kept. Do not run git add or git commit. Then run: grep -q draft-kept notes.txt",
    goal: { objective: "notes.txt exists with the line draft-kept" },
    acceptance: { commands: ["grep -q draft-kept notes.txt"] },
    session: { id: session }
  });
  assert.ok(draft.id, `create failed: ${JSON.stringify(draft).slice(0, 600)}`);
  const draftSettled = await settle(draft.id);
  assert.equal(draftSettled.status, "completed", JSON.stringify(draftSettled).slice(0, 600));
  step("draft worker", { id: draft.id, worktree: existsSync(draftSettled.worktree_path) });

  // The table hands out the cursor; the loop poll with it does the cleanup.
  const table = await call("poll_workers", {});
  assert.ok(table.next_cursor, "the table gave no cursor");
  const polled = await call("poll_workers", { cursor: table.next_cursor });
  const cleaned = polled.cleaned ?? [];
  // The preflight probes' worktrees go in the same sweep, so this is a subset check.
  const cleanedIds = new Set(cleaned.map((entry) => entry.task_id));
  for (const id of [...ids, draft.id]) assert.ok(cleanedIds.has(id), `${id} was not cleaned: ${JSON.stringify(cleaned).slice(0, 800)}`);
  const draftRemoval = cleaned.find((entry) => entry.task_id === draft.id);
  assert.ok(draftRemoval.checkpoint_commit, "the uncommitted draft must be committed to the branch before removal");
  for (const id of [...ids, draft.id]) {
    assert.equal(existsSync(join(home, "worktrees", id)), false, `worktree of ${id} is still there`);
    assert.notEqual(git(["branch", "--list", `worker/${id}`]), "", `branch of ${id} was removed`);
  }
  assert.equal(git(["show", `worker/${draft.id}:notes.txt`]).trim(), "draft-kept");
  step("auto cleanup", { removed: cleaned.length, checkpoint: draftRemoval.checkpoint_commit.slice(0, 12), branches_kept: true });

  // The cleaned-up draft can still be landed: its worktree comes back from the branch.
  const landedDraft = await call("land_worker", { task_id: draft.id });
  assert.ok(landedDraft.landed_head || landedDraft.landed || landedDraft.head, `land after cleanup: ${JSON.stringify(landedDraft).slice(0, 600)}`);
  assert.equal((await readFile(join(repo, "notes.txt"), "utf8")).trim(), "draft-kept");
  step("land after cleanup", { commits: Number(git(["rev-list", "--count", "HEAD"])) });

  // A worker that runs out of its time budget is timed_out, not lost, and is not retried.
  const hurried = await call("create_worker", {
    cwd: repo, sandbox: { mode: "workspace-write" }, owned_paths: ["slow.txt"],
    title: "runs out of time",
    task: "Write a 400 word essay about rivers into slow.txt, one sentence per line.",
    goal: { objective: "slow.txt holds the essay" },
    limits: { max_run_ms: 2000 },
    session: { id: session }
  });
  assert.ok(hurried.id, `create failed: ${JSON.stringify(hurried).slice(0, 600)}`);
  const hurriedSettled = await settle(hurried.id);
  assert.equal(hurriedSettled.status, "timed_out", JSON.stringify(hurriedSettled).slice(0, 600));
  assert.equal(hurriedSettled.failure?.source, "time_limit");
  const afterTimeout = await call("poll_workers", { cursor: polled.next_cursor });
  assert.deepEqual((afterTimeout.recoveries ?? []).filter((entry) => (entry.task_id ?? entry.id) === hurried.id), [], "a timed-out worker was retried");
  step("time budget", { status: hurriedSettled.status, reason: hurriedSettled.attention_reason, source: hurriedSettled.failure.source });

  // Kill the run host and the worker under it: the first poll finds the run dead and resumes it once.
  const victim = await call("create_worker", {
    cwd: repo, sandbox: { mode: "workspace-write", allowed_commands: ["sleep 40"] }, owned_paths: ["gamma.txt"],
    title: "is killed mid-run",
    task: "First run the shell command: sleep 40. After it finishes, create gamma.txt containing exactly one line: gamma-done. Do not run git add or git commit.",
    goal: { objective: "gamma.txt exists with the line gamma-done" },
    acceptance: { commands: ["grep -q gamma-done gamma.txt"] },
    session: { id: session }
  });
  assert.ok(victim.id, `create failed: ${JSON.stringify(victim).slice(0, 600)}`);
  let running = null;
  for (let waited = 0; waited < 120000 && !(running?.pid && running.thread_id); waited += 2000) {
    await sleep(2000);
    running = await call("get_worker", { task_id: victim.id, include: ["status"] });
  }
  assert.ok(running?.pid && running.thread_id, `the worker never started: ${JSON.stringify(running).slice(0, 600)}`);
  // The run host is the worker's parent; only this run's host is killed.
  const hosts = [Number(execFileSync("ps", ["-o", "ppid=", "-p", String(running.pid)], { encoding: "utf8" }).trim())].filter((pid) => pid > 1);
  assert.equal(hosts.length, 1, "the worker's run host was not found");
  for (const pid of [...hosts, running.pid]) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
  // The CLI is a launcher around a binary that can outlive it and still hold the
  // session, so recovery waits until nothing of the dead run is left.
  let cursor = afterTimeout.next_cursor;
  let recovered = false;
  let polls = 0;
  for (let waited = 0; waited < 240000 && !recovered; waited += 5000) {
    await sleep(5000);
    const afterKill = await call("poll_workers", { cursor });
    cursor = afterKill.next_cursor ?? cursor;
    polls += 1;
    recovered = (afterKill.recoveries ?? []).some((entry) => (entry.task_id ?? entry.id) === victim.id);
  }
  assert.ok(recovered, `the killed run was not recovered after ${polls} polls`);
  const victimSettled = await settle(victim.id);
  assert.equal(victimSettled.status, "completed", JSON.stringify(victimSettled).slice(0, 600));
  assert.equal(victimSettled.run_count, 2);
  const victimResult = await call("get_worker", { task_id: victim.id, include: ["result"] });
  assert.equal(victimResult.acceptance?.passed, true, `the recovered run did not finish the work: ${JSON.stringify(victimResult.acceptance).slice(0, 400)}`);
  step("killed run host", { killed: hosts.length + 1, recovered, polls, status: victimSettled.status, runs: victimSettled.run_count });

  // A command with a large output: the store keeps a clipped copy, the full body comes back from the run log.
  const noisy = await call("create_worker", {
    cwd: repo, sandbox: { mode: "read-only" }, owned_paths: [], workspace: { kind: "read_only_in_place" },
    title: "prints a lot",
    task: "Run exactly this shell command once and then reply with the single word done: seq 1 6000",
    goal: { objective: "the command seq 1 6000 was run" },
    session: { id: session }
  });
  assert.ok(noisy.id, `create failed: ${JSON.stringify(noisy).slice(0, 600)}`);
  await settle(noisy.id);
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(home, "data", "supervisor.sqlite"), { readOnly: true });
  const storedRows = db.prepare("SELECT payload FROM task_events WHERE task_id = ? AND payload LIKE '%supervisor_clipped%'").all(noisy.id);
  db.close();
  assert.ok(storedRows.length > 0, "no event of the noisy worker was clipped in the store");
  const clippedBytes = Math.max(...storedRows.map((row) => row.payload.length));
  const read = await call("get_worker", { task_id: noisy.id, include: ["events"], event_limit: 200 });
  const whole = (read.events ?? []).filter((event) => event.item?.aggregated_output?.includes("\n5999\n6000") && event.item.aggregated_output.includes("\n3000\n"));
  assert.ok(whole.length > 0, "the full command output did not come back from the log");
  assert.ok(!(read.events ?? []).some((event) => event.supervisor_clipped), "an event came back clipped");
  step("event bodies", { clipped_rows: storedRows.length, stored_bytes: clippedBytes, restored_bytes: JSON.stringify(whole[0]).length });
} catch (error) {
  failure = error;
} finally {
  await client.close().catch(() => {});
}

console.log(JSON.stringify({ ok: !failure, runner: RUNNER ?? "codex", package: PACKAGE, version: installed.version, home, error: failure?.message ?? null, steps }, null, 2));
if (!keep && !failure) await rm(home, { recursive: true, force: true });
process.exitCode = failure ? 1 : 0;
