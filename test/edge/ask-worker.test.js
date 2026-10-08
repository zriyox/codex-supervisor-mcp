// ask_codex_worker: the first question forks the worker's thread, the next
// resumes the fork, a question that outruns the budget can be read back,
// a worker without a thread says so, and end deletes the fork.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { dispatchArgs, makeRepo, tempHome, waitFor, withMcp } from "./helpers.js";

const home = await tempHome("supervisor-ask-");
const { dir: repo } = await makeRepo(join(home, "repo"));
const deleteLog = join(home, "deleted.txt");
let worker;
let legacy;

before(async () => {
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const created = await call("create_codex_worker", dispatchArgs("askable", repo));
    worker = await waitFor(call, created.id, (t) => t.status === "completed" && Boolean(t.thread_id));
    const second = await call("create_codex_worker", dispatchArgs("no-thread", repo));
    legacy = await waitFor(call, second.id, (t) => t.status === "completed");
  });
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(home, "data", "supervisor.sqlite"));
  db.prepare("UPDATE tasks SET thread_id = NULL WHERE id = ?").run(legacy.id);
  db.close();
});

const sideEnv = { SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "side-chat", FAKE_CODEX_DELETE_LOG: deleteLog };

test("first question forks, second resumes the fork, the worker's own thread is untouched", async () => {
  await withMcp(sideEnv, async ({ call }) => {
    const first = await call("ask_codex_worker", { task_id: worker.id, question: "what did you change?" });
    assert.equal(first.error, undefined, JSON.stringify(first).slice(0, 300));
    assert.equal(first.timed_out, false);
    assert.equal(first.turn.status, "completed");
    assert.equal(first.turn.answer, `[fork of ${worker.thread_id}] answer to: what did you change?`);
    assert.equal(first.fork_thread_id, `fork-${worker.thread_id}`);
    assert.equal(first.turn.usage.input_tokens, 10);

    const second = await call("ask_codex_worker", { task_id: worker.id, question: "and why?" });
    assert.equal(second.turn.answer, `[resume of fork-${worker.thread_id}] answer to: and why?`);

    const status = await call("get_codex_worker_status", { task_id: worker.id });
    assert.equal(status.thread_id, worker.thread_id, "the worker's thread id is still its own");
    assert.equal(status.status, "completed");

    const latest = await call("ask_codex_worker", { task_id: worker.id });
    assert.equal(latest.turn.question, "and why?");
    assert.equal(latest.turn.answer, second.turn.answer);
  });
});

test("an answer is clipped to maxChars", async () => {
  await withMcp(sideEnv, async ({ call }) => {
    const short = await call("ask_codex_worker", { task_id: worker.id, question: "x".repeat(300), maxChars: 50 });
    assert.ok(short.turn.answer.length <= 80, short.turn.answer.length);
    assert.match(short.turn.answer, /chars truncated/);
  });
});

test("a question that outruns the budget keeps running and can be read back", async () => {
  await withMcp({ ...sideEnv, FAKE_CODEX_STEP_MS: "400" }, async ({ call }) => {
    const slow = await call("ask_codex_worker", { task_id: worker.id, question: "slow one", timeoutMs: 1000 });
    assert.equal(slow.timed_out, true);
    assert.equal(slow.turn.status, "running");
    assert.match(slow.next_step, /only task_id/);

    const busy = await call("ask_codex_worker", { task_id: worker.id, question: "another" });
    assert.equal(busy.error, "busy");

    let latest;
    for (let i = 0; i < 50; i += 1) {
      latest = await call("ask_codex_worker", { task_id: worker.id });
      if (latest.turn.status !== "running") break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(latest.turn.status, "completed");
    assert.match(latest.turn.answer, /answer to: slow one/);
  });
});

test("a worker without a thread cannot be asked, and end deletes the fork", async () => {
  await withMcp(sideEnv, async ({ call }) => {
    const nope = await call("ask_codex_worker", { task_id: legacy.id, question: "hello?" });
    assert.equal(nope.error, "no_thread");
    const missing = await call("ask_codex_worker", { task_id: "codex-none", question: "hello?" });
    assert.equal(missing.error, "task_not_found");

    const ended = await call("ask_codex_worker", { task_id: worker.id, end: true });
    assert.equal(ended.ended, true);
    assert.equal(ended.fork_thread_id, `fork-${worker.thread_id}`);
    assert.match(await readFile(deleteLog, "utf8"), new RegExp(`fork-${worker.thread_id}`));
    const after = await call("ask_codex_worker", { task_id: worker.id });
    assert.equal(after.active, false);
    assert.equal(after.turn, null);
  });
});

test("wait_codex_workers compact: one short row per worker", async () => {
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const waited = await call("wait_codex_workers", { task_ids: [worker.id, legacy.id], compact: true, timeoutMs: 2000 });
    assert.equal(waited.workers.length, 2);
    assert.deepEqual(Object.keys(waited.workers[0]).sort(), ["acceptance", "changed_file_count", "command_running", "current_command", "exit_code", "id", "idle_seconds", "phase", "status", "title", "updated_at"]);
    assert.ok(JSON.stringify(waited).length < 1500, `compact wait is ${JSON.stringify(waited).length} chars`);
  });
});

test("the fork is told what a side question is, and has its MCP servers switched off", async () => {
  const stdinLog = join(home, "stdin.log");
  const codexHome = join(home, "codex-home");
  await (await import("node:fs/promises")).mkdir(codexHome, { recursive: true });
  await (await import("node:fs/promises")).writeFile(join(codexHome, "config.toml"), '[mcp_servers.codex-supervisor]\ncommand = "x"\n[mcp_servers.codex-supervisor.env]\nA = "1"\n[mcp_servers."obsidian"]\nurl = "http://x"\n');
  await withMcp({ ...sideEnv, FAKE_CODEX_STDIN_LOG: stdinLog, CODEX_HOME: codexHome }, async ({ call }) => {
    const asked = await call("ask_codex_worker", { task_id: worker.id, question: "where is the retry handled?", fresh: true });
    assert.equal(asked.turn.answer, `[fork of ${worker.thread_id}] answer to: where is the retry handled?`);
    const last = JSON.parse((await readFile(stdinLog, "utf8")).trim().split("\n").at(-1));
    assert.match(last.stdin, /^This is a side question/);
    assert.match(last.stdin, /no network/);
    assert.ok(last.stdin.endsWith("Question:\nwhere is the retry handled?"));
    assert.ok(last.args.includes("mcp_servers.codex-supervisor.enabled=false"), last.args.join(" "));
    assert.ok(last.args.includes("mcp_servers.obsidian.enabled=false"));
    assert.ok(!last.args.some((a) => a.includes("codex-supervisor.env")), "a sub-table is not a server");
    assert.ok(last.args.includes('sandbox_mode="read-only"'));
  });
});

test("fresh: true drops the fork and takes a new one; a resumed worker gets a new fork by itself", async () => {
  await withMcp(sideEnv, async ({ call }) => {
    await call("ask_codex_worker", { task_id: worker.id, end: true });
    const first = await call("ask_codex_worker", { task_id: worker.id, question: "one" });
    assert.equal(first.refreshed, "first", JSON.stringify(first).slice(0, 200));
    const second = await call("ask_codex_worker", { task_id: worker.id, question: "two" });
    assert.equal(second.refreshed, null);
    assert.match(second.turn.answer, /^\[resume of fork-/);

    const before = (await readFile(deleteLog, "utf8")).split("\n").filter(Boolean).length;
    const fresh = await call("ask_codex_worker", { task_id: worker.id, question: "three", fresh: true });
    assert.equal(fresh.refreshed, "requested");
    assert.match(fresh.turn.answer, /^\[fork of /, "a fresh ask forks again");
    const after = (await readFile(deleteLog, "utf8")).split("\n").filter(Boolean);
    assert.equal(after.length, before + 1, "the old fork was deleted");
    assert.equal(after.at(-1), `fork-${worker.thread_id}`);

    const resumed = await call("resume_codex_worker", { task_id: worker.id, prompt: "do a bit more" });
    assert.ok(!resumed.error, JSON.stringify(resumed).slice(0, 200));
    await waitFor(call, worker.id, (t) => t.status === "completed" && (t.run_count ?? 0) >= 2);
    const again = await call("ask_codex_worker", { task_id: worker.id, question: "four" });
    assert.equal(again.refreshed, "worker_resumed");
    assert.match(again.turn.answer, /^\[fork of /, "the fork is retaken from the resumed thread");
    const once_more = await call("ask_codex_worker", { task_id: worker.id, question: "five" });
    assert.equal(once_more.refreshed, null);
    assert.match(once_more.turn.answer, /^\[resume of fork-/);
  });
});

test("sideTurnConfigArgs: every top-level server, quoted or not, nothing else", async () => {
  const { sideTurnConfigArgs } = await import("../../src/side-chat.js");
  const args = sideTurnConfigArgs('[mcp_servers.a]\n[mcp_servers.a.env]\n[mcp_servers."b-c"] # note\n[model_providers.x]\n  [mcp_servers.d]\n');
  assert.deepEqual(args, ["-c", "mcp_servers.a.enabled=false", "-c", "mcp_servers.b-c.enabled=false", "-c", "mcp_servers.d.enabled=false"]);
  assert.deepEqual(sideTurnConfigArgs('[mcp_servers."has space"]\n'), [], "a name codex cannot take bare is left alone rather than breaking the config");
  assert.deepEqual(sideTurnConfigArgs(""), []);
});
