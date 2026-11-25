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

// One place to rename when the tool surface changes.
const TOOL = {
  preflight: "preflight_codex_worker",
  preflightResult: "get_worker_preflight",
  create: "create_codex_worker",
  wait: "wait_codex_workers",
  status: "get_codex_worker_status",
  result: "get_worker_result",
  diff: "get_worker_diff",
  land: "land_codex_worker",
  cleanupPlan: "cleanup_plan",
  poll: "check_workers"
};

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
const TERMINAL = ["completed", "failed", "cancelled", "lost"];

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(packageRoot, installed.bin[PACKAGE] ?? "src/mcp-server.js")],
  cwd: home,
  env: {
    ...process.env, SUPERVISOR_HOME: home, CODEX_SUPERVISOR_NO_UPDATE_CHECK: "1", CODEX_SUPERVISOR_NO_AUTO_UPDATE: "1", CODEX_SUPERVISOR_SKIP_SKILL_SYNC: "1",
    // Sweep on every poll and treat unlanded work as past its hold period, so cleanup can be observed in one run.
    CODEX_SUPERVISOR_CLEANUP_INTERVAL_MS: "0", CODEX_SUPERVISOR_CLEANUP_HOLD_DAYS: "0"
  },
  stderr: "inherit"
});
const client = new Client({ name: "supervisor-e2e", version: "1.0.0" });
await client.connect(transport);
const call = async (name, args = {}) => {
  const reply = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
  const text = reply.content?.[0]?.text ?? "null";
  try { return JSON.parse(text); } catch { return { raw: text }; }
};

async function settle(taskId, timeoutMs = 600000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await call(TOOL.status, { task_id: taskId });
    if (TERMINAL.includes(last.status) && last.exit_code !== null && last.exit_code !== undefined) return last;
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
  step("tools/list", { version: installed.version, count: tools.length });

  const contract = (work) => ({ cwd: repo, sandbox: "workspace-write", ownedPaths: [work.file] });

  const probes = await Promise.all(WORK.map((work) => call(TOOL.preflight, { ...contract(work), title: `probe ${work.file}`, probeCommands: ["git status --short"] })));
  for (const probe of probes) assert.ok(probe.id, `preflight did not start: ${JSON.stringify(probe).slice(0, 400)}`);
  await Promise.all(probes.map((probe) => settle(probe.id)));
  for (const probe of probes) {
    const verdict = await call(TOOL.preflightResult, { task_id: probe.id });
    assert.equal(verdict.status, "passed", `preflight ${probe.id}: ${JSON.stringify(verdict).slice(0, 600)}`);
  }
  step("preflight", { passed: probes.length });

  const created = await Promise.all(WORK.map((work, index) => call(TOOL.create, {
    ...contract(work),
    title: `append to ${work.file}`,
    task: `Append exactly one new line containing ${work.line} to the end of ${work.file}. Change nothing else. Then run: grep -q ${work.line} ${work.file}`,
    goal: { objective: `${work.file} ends with a line ${work.line}` },
    acceptance: [`grep -q ${work.line} ${work.file}`],
    preflight_id: probes[index].id,
    session_id: session,
    session_title: "e2e real flow"
  })));
  for (const worker of created) assert.ok(worker.id, `create failed: ${JSON.stringify(worker).slice(0, 600)}`);
  const ids = created.map((worker) => worker.id);
  // A server that ignored SUPERVISOR_HOME would be working on the real store.
  assert.ok(existsSync(join(home, "data", "supervisor.sqlite")), `SUPERVISOR_HOME=${home} was ignored`);
  step("create", { ids });

  const waited = await call(TOOL.wait, { task_ids: ids, mode: "all" });
  step("wait", { termination_reason: waited.termination_reason ?? null });
  const settled = await Promise.all(ids.map((id) => settle(id)));
  for (const task of settled) assert.equal(task.status, "completed", `worker ${task.id} ended ${task.status}: ${JSON.stringify(task).slice(0, 600)}`);
  step("settled", { statuses: settled.map((task) => task.status) });

  for (const [index, id] of ids.entries()) {
    const result = await call(TOOL.result, { task_id: id });
    assert.equal(result.acceptance?.passed, true, `acceptance for ${id}: ${JSON.stringify(result.acceptance).slice(0, 600)}`);
    const diff = await call(TOOL.diff, { task_id: id });
    const files = (diff.files ?? []).map((file) => file.path);
    assert.deepEqual(files, [WORK[index].file], `diff for ${id} touched ${JSON.stringify(files)}`);
  }
  step("result+diff", { accepted: ids.length });

  for (const [index, id] of ids.entries()) {
    const landed = await call(TOOL.land, { task_id: id, commitMessage: `Append ${WORK[index].line} to ${WORK[index].file}` });
    assert.ok(landed.landed_head || landed.landed || landed.head, `land ${id}: ${JSON.stringify(landed).slice(0, 600)}`);
  }
  for (const work of WORK) assert.equal(await readFile(join(repo, work.file), "utf8"), `${work.seed}\n${work.line}\n`);
  assert.equal(git(["status", "--porcelain"]), "", "integration checkout is dirty after land");
  step("land", { commits: Number(git(["rev-list", "--count", "HEAD"])) });

  const plan = await call(TOOL.cleanupPlan, { task_ids: ids });
  assert.deepEqual((plan.items ?? []).map((item) => item.verdict), ["safe", "safe"], `landed work must be safe: ${JSON.stringify(plan.items).slice(0, 600)}`);
  step("cleanup_plan", { summary: plan.summary });

  // A third worker leaves an uncommitted draft and is never landed.
  const draft = await call(TOOL.create, {
    cwd: repo, sandbox: "workspace-write", ownedPaths: ["notes.txt"],
    title: "leave a draft",
    task: "Create a file notes.txt containing exactly one line: draft-kept. Do not run git add or git commit. Then run: grep -q draft-kept notes.txt",
    goal: { objective: "notes.txt exists with the line draft-kept" },
    acceptance: ["grep -q draft-kept notes.txt"],
    session_id: session
  });
  assert.ok(draft.id, `create failed: ${JSON.stringify(draft).slice(0, 600)}`);
  const draftSettled = await settle(draft.id);
  assert.equal(draftSettled.status, "completed", JSON.stringify(draftSettled).slice(0, 600));
  step("draft worker", { id: draft.id, worktree: existsSync(draftSettled.worktree_path) });

  const polled = await call(TOOL.poll, {});
  const cleaned = polled.cleaned ?? [];
  assert.deepEqual(cleaned.map((entry) => entry.task_id).sort(), [...ids, draft.id].sort(), `sweep result: ${JSON.stringify(polled).slice(0, 800)}`);
  const draftRemoval = cleaned.find((entry) => entry.task_id === draft.id);
  assert.ok(draftRemoval.checkpoint_commit, "the uncommitted draft must be committed to the branch before removal");
  for (const id of [...ids, draft.id]) {
    assert.equal(existsSync(join(home, "worktrees", id)), false, `worktree of ${id} is still there`);
    assert.notEqual(git(["branch", "--list", `codex/${id}`]), "", `branch of ${id} was removed`);
  }
  assert.equal(git(["show", `codex/${draft.id}:notes.txt`]).trim(), "draft-kept");
  step("auto cleanup", { removed: cleaned.length, checkpoint: draftRemoval.checkpoint_commit.slice(0, 12), branches_kept: true });

  // The cleaned-up draft can still be landed: its worktree comes back from the branch.
  const landedDraft = await call(TOOL.land, { task_id: draft.id });
  assert.ok(landedDraft.landed_head || landedDraft.landed || landedDraft.head, `land after cleanup: ${JSON.stringify(landedDraft).slice(0, 600)}`);
  assert.equal((await readFile(join(repo, "notes.txt"), "utf8")).trim(), "draft-kept");
  step("land after cleanup", { commits: Number(git(["rev-list", "--count", "HEAD"])) });
} catch (error) {
  failure = error;
} finally {
  await client.close().catch(() => {});
}

console.log(JSON.stringify({ ok: !failure, package: PACKAGE, version: installed.version, home, error: failure?.message ?? null, steps }, null, 2));
if (!keep && !failure) await rm(home, { recursive: true, force: true });
process.exitCode = failure ? 1 : 0;
