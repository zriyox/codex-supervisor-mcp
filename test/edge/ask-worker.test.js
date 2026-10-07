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
    assert.deepEqual(Object.keys(waited.workers[0]).sort(), ["changed_file_count", "exit_code", "id", "phase", "status", "title", "updated_at"]);
    assert.ok(JSON.stringify(waited).length < 1500, `compact wait is ${JSON.stringify(waited).length} chars`);
  });
});
