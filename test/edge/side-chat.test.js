// The side chat, state by state: fork on the first turn, resume on the next,
// one turn at a time, a page that leaves and comes back, a stop, a failure,
// a board restart, and the exact UI message stream the page consumes.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { dispatchArgs, makeRepo, startWebServer, tempHome, waitFor, withMcp } from "./helpers.js";

const home = await tempHome("supervisor-sidechat-");
const { dir: repo } = await makeRepo(join(home, "repo"));
const deleteLog = join(home, "deleted.txt");
let web;
let worker;
let legacy;

before(async () => {
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const created = await call("create_codex_worker", dispatchArgs("askable", repo));
    worker = await waitFor(call, created.id, (t) => t.status === "completed" && Boolean(t.thread_id));
    legacy = await call("create_codex_worker", dispatchArgs("no-thread", repo, { task: "x" }));
    await waitFor(call, legacy.id, (t) => t.status === "completed");
  });
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(home, "data", "supervisor.sqlite"));
  db.prepare("UPDATE tasks SET thread_id = NULL WHERE id = ?").run(legacy.id);
  db.close();
  web = await startWebServer({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "side-chat", FAKE_CODEX_DELETE_LOG: deleteLog });
});
after(() => web?.close());

const userMessage = (text) => ({ id: "req", messages: [{ id: "u1", role: "user", parts: [{ type: "text", text }] }] });
const post = (base, taskId, text, init = {}) =>
  fetch(`${base}/api/workers/${taskId}/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(userMessage(text)), ...init });
const parseSse = (raw) =>
  raw.split("\n\n").map((b) => b.replace(/^data: /, "").trim()).filter((l) => l && l !== "[DONE]").map((l) => JSON.parse(l));

async function ask(taskId, text) {
  const response = await post(web.base, taskId, text);
  const raw = await response.text();
  const chunks = parseSse(raw);
  return { response, raw, chunks, types: chunks.map((c) => c.type) };
}

test("first turn: fork, and the chunk sequence a page turns into reasoning, a tool call and the answer", async () => {
  const { response, raw, chunks, types } = await ask(worker.id, "what did you change?");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-vercel-ai-ui-message-stream"), "v1");
  assert.ok(raw.trimEnd().endsWith("data: [DONE]"));
  assert.deepEqual(
    types.filter((t) => !t.startsWith("data-")),
    ["start", "start-step", "reasoning-start", "reasoning-delta", "reasoning-end", "tool-input-available", "tool-output-available", "text-start", "text-delta", "text-end", "finish-step", "finish"]
  );
  assert.equal(chunks.find((c) => c.type === "data-session").data.fork_thread_id, `fork-${worker.thread_id}`);
  assert.match(chunks.find((c) => c.type === "data-notice").data.message, /unrecognized configuration/);
  assert.equal(chunks.find((c) => c.type === "text-delta").delta, `[fork of ${worker.thread_id}] answer to: what did you change?`);
  assert.equal(chunks.find((c) => c.type === "data-usage").data.input_tokens, 10);

  const state = (await web.get(`/api/workers/${worker.id}/chat`)).body;
  assert.equal(state.active, true);
  assert.equal(state.busy, false);
  assert.equal(state.fork_thread_id, `fork-${worker.thread_id}`);
  assert.equal(state.turns.length, 1);
  const turn = state.turns[0];
  assert.equal(turn.status, "completed");
  assert.equal(turn.question, "what did you change?");
  assert.equal(turn.usage.input_tokens, 10);
  const kinds = turn.parts.map((p) => p.type);
  assert.deepEqual(kinds.filter((k) => !k.startsWith("data-")), ["reasoning", "tool-shell", "text"]);
  assert.equal(turn.parts.find((p) => p.type === "tool-shell").state, "output-available");
  assert.equal(turn.parts.find((p) => p.type === "tool-shell").output.exit_code, 0);
  assert.match(turn.parts.find((p) => p.type === "text").text, /answer to/);
});

test("second turn resumes the fork and the history keeps both turns", async () => {
  const { chunks } = await ask(worker.id, "and why?");
  assert.equal(chunks.find((c) => c.type === "text-delta").delta, `[resume of fork-${worker.thread_id}] answer to: and why?`);
  const state = (await web.get(`/api/workers/${worker.id}/chat`)).body;
  assert.deepEqual(state.turns.map((t) => t.question), ["what did you change?", "and why?"]);
});

test("the history survives a board restart", async () => {
  const again = await startWebServer({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "side-chat" });
  try {
    const state = (await again.get(`/api/workers/${worker.id}/chat`)).body;
    assert.equal(state.turns.length, 2);
    assert.equal(state.fork_thread_id, `fork-${worker.thread_id}`);
  } finally {
    again.close();
  }
});

test("ending deletes the fork, clears the history, and the next question forks again", async () => {
  const closed = (await web.get(`/api/workers/${worker.id}/chat`, { method: "DELETE" })).body;
  assert.equal(closed.ended, true);
  assert.equal(closed.deleted, true);
  assert.equal((await readFile(deleteLog, "utf8")).trim(), `fork-${worker.thread_id}`);
  const state = (await web.get(`/api/workers/${worker.id}/chat`)).body;
  assert.equal(state.active, false);
  assert.equal(state.turns.length, 0);
  const { chunks } = await ask(worker.id, "again");
  assert.match(chunks.find((c) => c.type === "text-delta").delta, /^\[fork of /);
  await web.get(`/api/workers/${worker.id}/chat`, { method: "DELETE" });
});

test("a worker without a thread_id cannot be asked, and says so", async () => {
  assert.equal((await web.get(`/api/workers/${legacy.id}/chat`)).body.can_ask, false);
  const response = await post(web.base, legacy.id, "hello?");
  assert.equal(response.status, 400);
  assert.match(await response.text(), /no_thread/);
});

test("an empty question, a bad body, an unknown worker and a wrong method are refused", async () => {
  assert.equal((await post(web.base, worker.id, "   ")).status, 400);
  const bad = await fetch(`${web.base}/api/workers/${worker.id}/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: "{nope" });
  assert.equal(bad.status, 400);
  assert.equal((await web.get(`/api/workers/nope/chat`)).status, 404);
  assert.equal((await web.get(`/api/workers/${worker.id}/chat/stop`)).status, 405);
  assert.equal((await web.get(`/api/workers/${worker.id}/chat/x/stream`)).status, 204, "nothing running: 204 for the resume probe");
});

test("a page that leaves keeps the turn running, another page attaches and replays, a second question is 409, stop ends it", async () => {
  const hang = await startWebServer({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "side-chat-hang" });
  try {
    const controller = new AbortController();
    const first = post(hang.base, worker.id, "slow", { signal: controller.signal });
    await new Promise((r) => setTimeout(r, 700));
    let state = (await hang.get(`/api/workers/${worker.id}/chat`)).body;
    assert.equal(state.busy, true);
    assert.equal(state.watchers, 1);
    assert.equal(state.turns.at(-1).status, "running");

    controller.abort();
    await first.catch(() => {});
    await new Promise((r) => setTimeout(r, 300));
    state = (await hang.get(`/api/workers/${worker.id}/chat`)).body;
    assert.equal(state.busy, true, "the turn keeps running after its page left");
    assert.equal(state.watchers, 0);

    assert.equal((await post(hang.base, worker.id, "too")).status, 409);

    const attached = await fetch(`${hang.base}/api/workers/${worker.id}/chat/side-x/stream`);
    assert.equal(attached.status, 200);
    assert.equal(attached.headers.get("x-vercel-ai-ui-message-stream"), "v1");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await hang.get(`/api/workers/${worker.id}/chat`)).body.watchers, 1);

    const stopped = (await hang.get(`/api/workers/${worker.id}/chat/stop`, { method: "POST" })).body;
    assert.equal(stopped.stopped, true);
    const raw = await attached.text();
    const types = parseSse(raw).map((c) => c.type);
    assert.deepEqual(types.slice(0, 2), ["start", "data-session"], "the attach replays from the beginning");
    assert.ok(types.includes("start-step"));
    assert.equal(types.at(-2), "error");
    assert.equal(types.at(-1), "finish");
    assert.ok(raw.trimEnd().endsWith("data: [DONE]"));

    state = (await hang.get(`/api/workers/${worker.id}/chat`)).body;
    assert.equal(state.busy, false);
    assert.equal(state.turns.at(-1).status, "stopped");
    assert.equal(state.turns.at(-1).error, "stopped");
    await hang.get(`/api/workers/${worker.id}/chat`, { method: "DELETE" });
  } finally {
    hang.close();
  }
});

test("a turn nobody watched still finishes and its answer is in the history", async () => {
  const slow = await startWebServer({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "side-chat", FAKE_CODEX_STEP_MS: "800" });
  try {
    const controller = new AbortController();
    const inflight = post(slow.base, worker.id, "unwatched", { signal: controller.signal });
    await new Promise((r) => setTimeout(r, 200));
    controller.abort();
    await inflight.catch(() => {});
    const deadline = Date.now() + 8000;
    let state;
    for (;;) {
      state = (await slow.get(`/api/workers/${worker.id}/chat`)).body;
      if (!state.busy || Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(state.busy, false);
    const turn = state.turns.at(-1);
    assert.equal(turn.status, "completed");
    assert.match(turn.parts.find((p) => p.type === "text").text, /answer to: unwatched/);
    await slow.get(`/api/workers/${worker.id}/chat`, { method: "DELETE" });
  } finally {
    slow.close();
  }
});

test("turn.failed becomes a failed turn with the reason, and the session stays usable", async () => {
  const failing = await startWebServer({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "side-chat-fail" });
  try {
    const raw = await (await post(failing.base, worker.id, "fail")).text();
    assert.match(raw, /"errorText":"model refused"/);
    const state = (await failing.get(`/api/workers/${worker.id}/chat`)).body;
    assert.equal(state.busy, false);
    assert.equal(state.turns.at(-1).status, "failed");
    assert.equal(state.turns.at(-1).error, "model refused");
    await failing.get(`/api/workers/${worker.id}/chat`, { method: "DELETE" });
  } finally {
    failing.close();
  }
});

test("a board that restarts mid-turn marks the turn interrupted instead of leaving it running forever", async () => {
  const hang = await startWebServer({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "side-chat-hang" });
  const controller = new AbortController();
  const inflight = post(hang.base, worker.id, "cut", { signal: controller.signal });
  await new Promise((r) => setTimeout(r, 700));
  assert.equal((await hang.get(`/api/workers/${worker.id}/chat`)).body.busy, true);
  controller.abort();
  await inflight.catch(() => {});
  hang.close();
  await new Promise((r) => setTimeout(r, 300));
  const again = await startWebServer({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "side-chat" });
  try {
    const state = (await again.get(`/api/workers/${worker.id}/chat`)).body;
    assert.equal(state.busy, false);
    assert.equal(state.turns.at(-1).status, "interrupted");
    assert.match(state.turns.at(-1).error, /restarted/);
    const { chunks } = await ask(worker.id, "after restart");
    assert.ok(chunks.some((c) => c.type === "text-delta"), "the session is usable again");
    await again.get(`/api/workers/${worker.id}/chat`, { method: "DELETE" });
  } finally {
    again.close();
  }
});
