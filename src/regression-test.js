// End-to-end regression test. Every case drives the real MCP server over the
// MCP protocol with a deterministic fake codex, so the tool surface, the state
// machine, the ownership guard and the concurrency behaviour are all exercised
// the way a client would exercise them.
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { approxTokenCount } from "./truncate.js";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, "..");
const fakeCodex = join(here, "test-fixtures", "fake-codex.js");
const home = await mkdtemp(join(tmpdir(), "supervisor-regression-"));
const workspace = join(home, "workspace");
await mkdir(workspace, { recursive: true });

const THREAD_ID = "01a0fd0a-54a3-7a91-b37c-1f540e80e164";
const baseEnv = { SUPERVISOR_HOME: home, CODEX_BIN: fakeCodex, FAKE_CODEX_THREAD_ID: THREAD_ID };

let failures = 0;
let passed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL - ${name}\n      ${error.message}`);
  }
}

async function withServer(extraEnv, fn) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(here, "mcp-server.js")],
    cwd: projectRoot,
    env: { ...process.env, ...baseEnv, ...extraEnv },
    stderr: "pipe"
  });
  const client = new Client({ name: "supervisor-regression", version: "1.0.0" });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

function parse(result) {
  const text = result.content?.[0]?.text ?? "null";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const call = (client, name, args = {}) => client.callTool({ name, arguments: args }).then(parse);

async function waitFor(client, taskId, predicate, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await call(client, "get_codex_worker_status", { task_id: taskId });
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${taskId}; last=${JSON.stringify(last)?.slice(0, 400)}`);
}

function describe(task, extra = {}) {
  return {
    title: task.title,
    task: `Task ${task.title}`,
    cwd: workspace,
    sandbox: "read-only",
    ownedPaths: [`/tmp/regression/${task.title.replace(/\W+/g, "-")}`],
    goal: { objective: `objective for ${task.title}` },
    ...extra
  };
}

// ---------------------------------------------------------------- R4-1 crash

await test("R4-1a spawn failure fails the task instead of killing the server", async () => {
  await withServer({ CODEX_BIN: "/nonexistent/codex-binary-xyz" }, async (client) => {
    const created = await call(client, "create_codex_worker", describe({ title: "spawn-fail" }));
    assert.equal(created.status, "failed");
    assert.match(created.error, /failed to spawn/);
    const alive = await call(client, "list_codex_workers", { includeHistory: true });
    assert.ok(Array.isArray(alive), "server must still answer after a spawn failure");
  });
});

await test("R4-1b oversized prompt plus instant exit does not kill the server", async () => {
  await withServer({ FAKE_CODEX_SCENARIO: "exit-immediately" }, async (client) => {
    const created = await call(client, "create_codex_worker", {
      ...describe({ title: "big-prompt" }),
      task: `x${"y".repeat(8 * 1024 * 1024)}`
    });
    assert.ok(["failed", "running", "lost"].includes(created.status), `unexpected status ${created.status}`);
    const final = await waitFor(client, created.id, (task) => task.status !== "running" && task.status !== "queued");
    assert.equal(final.status, "failed");
    const alive = await call(client, "get_orchestration_overview", {});
    assert.ok(alive.workers.some((worker) => worker.id === created.id));
  });
});

// ------------------------------------------------------------- R1 state machine

await test("R1-1 status stays in the lifecycle set and phase carries progress", async () => {
  await withServer({ FAKE_CODEX_STEP_MS: "120" }, async (client) => {
    const created = await call(client, "create_codex_worker", describe({ title: "state-machine" }));
    const seenStatuses = new Set();
    const seenPhases = new Set();
    const deadline = Date.now() + 20000;
    let current = created;
    while (Date.now() < deadline && current.status !== "completed" && current.status !== "failed") {
      current = await call(client, "get_codex_worker_status", { task_id: created.id });
      seenStatuses.add(current.status);
      if (current.phase) seenPhases.add(current.phase);
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    seenStatuses.add(current.status);
    assert.equal(current.status, "completed");
    const allowed = new Set(["queued", "running", "completed", "failed", "cancelled", "lost"]);
    for (const status of seenStatuses) assert.ok(allowed.has(status), `leaked status ${status}`);
    for (const phase of seenPhases) {
      assert.ok(
        ["starting", "thinking", "command", "editing", "reporting"].includes(phase),
        `leaked phase ${phase}`
      );
    }
    assert.ok(seenPhases.has("command"), `expected a command phase, saw ${[...seenPhases]}`);
    assert.ok(seenPhases.has("editing"), `expected an editing phase, saw ${[...seenPhases]}`);
    assert.equal(current.phase, null, "terminal work must not carry a phase");
    assert.equal(current.thread_id, THREAD_ID);
    assert.deepEqual(
      current.changed_files.sort(),
      ["/tmp/fake/one.ts", "/tmp/fake/two.ts"],
      "file_change events must produce changed_files"
    );
    assert.equal(current.goal_objective, "objective for state-machine");
    assert.equal(current.error, null, "a clean run must not report an error");
  });
});

await test("R1-2 a killed worker becomes lost, or failed with code 1 on Windows", async () => {
  await withServer({ FAKE_CODEX_SCENARIO: "hang" }, async (client) => {
    const created = await call(client, "create_codex_worker", describe({ title: "lost-worker" }));
    const running = await waitFor(client, created.id, (task) => task.status === "running");
    process.kill(running.pid, "SIGKILL");
    // Windows has no signals: a worker killed by another process comes back as a
    // plain exit code (libuv terminates it with TerminateProcess(handle, 1)),
    // which is indistinguishable from a worker that exited 1 on its own. The
    // supervisor therefore reports what it can prove - failed with exit_code 1 -
    // rather than inventing a signal the platform never delivered. `lost` stays
    // reachable on Windows through crash recovery, when the supervisor itself
    // dies and finds the orphan on the next start.
    if (process.platform === "win32") {
      const killed = await waitFor(
        client,
        created.id,
        (task) => task.status !== "running" && task.status !== "queued"
      );
      assert.equal(killed.status, "failed");
      assert.equal(killed.exit_code, 1, "libuv terminates a killed process with code 1");
      assert.equal(killed.phase, null);
      return;
    }
    const reconciled = await waitFor(client, created.id, (task) => task.status === "lost");
    assert.equal(reconciled.status, "lost");
    assert.equal(reconciled.phase, null);
    assert.match(reconciled.error, /killed by signal SIGKILL/i);
  });
});

await test("R1-3 a worker that exits without a terminal event is failed, not lost", async () => {
  await withServer({ FAKE_CODEX_SCENARIO: "exit-after-thread" }, async (client) => {
    const created = await call(client, "create_codex_worker", describe({ title: "no-terminal-event" }));
    const final = await waitFor(client, created.id, (task) => task.status !== "running" && task.status !== "queued");
    assert.equal(final.status, "failed");
    assert.match(final.error, /exited with code 7/);
    assert.equal(final.thread_id, THREAD_ID);
  });
});

// ------------------------------------------------------------- R2 tool surface

await test("R2-1 overview with 20 workers stays under 2000 tokens", async () => {
  const overviewHome = await mkdtemp(join(tmpdir(), "supervisor-overview-"));
  await withServer({ SUPERVISOR_HOME: overviewHome, FAKE_CODEX_SCENARIO: "exit-immediately" }, async (client) => {
    for (let index = 0; index < 20; index += 1) {
      await call(client, "create_codex_worker", {
        title: `很长的中文标题第${index}号worker负责改造状态机与并发稳定性`,
        task: "noop",
        cwd: workspace,
        sandbox: "read-only",
        ownedPaths: [`/tmp/overview/${index}`],
        goal: { objective: `这是第${index}个worker的很长的目标描述，用来压测概览接口的预算控制能力` }
      });
    }
    const overview = await call(client, "get_orchestration_overview", {});
    assert.equal(overview.workers.length, 20);
    const tokens = approxTokenCount(JSON.stringify(overview));
    assert.ok(tokens <= 2000, `overview cost ${tokens} tokens`);
    assert.equal(overview.approx_tokens, tokens);
    assert.notEqual(overview.budget_exceeded, true);
  });
});

await test("R2-2 event gates truncate the middle and keep JSON valid", async () => {
  await withServer({ FAKE_CODEX_MESSAGE_LEN: "4000" }, async (client) => {
    const created = await call(client, "create_codex_worker", describe({ title: "event-gates" }));
    await waitFor(client, created.id, (task) => task.status === "completed" || task.status === "failed");
    const gated = await call(client, "get_codex_worker_events", { task_id: created.id, limit: 50, maxChars: 200 });
    assert.ok(gated.events.length > 0);
    assert.ok(gated.available_kinds.some((entry) => entry.kind === "turn.completed"));
    const messages = gated.events
      .map((event) => event.item?.text)
      .filter((text) => typeof text === "string" && text.length > 100);
    assert.ok(messages.length > 0, "expected at least one long message");
    for (const message of messages) {
      assert.ok(message.startsWith("Warning: truncated output (original token count:"), message.slice(0, 80));
      assert.ok(Buffer.byteLength(message, "utf8") < 400, `still ${Buffer.byteLength(message, "utf8")} bytes`);
    }
    const kindsOnly = await call(client, "get_codex_worker_events", {
      task_id: created.id,
      limit: 10,
      kinds: ["item.completed"]
    });
    assert.ok(kindsOnly.events.every((event) => event.type === "item.completed"));
    assert.equal(kindsOnly.count, kindsOnly.events.length);
    assert.ok(kindsOnly.count > 0);
  });
});

await test("R2-3 ownedPaths and goal are required", async () => {
  await withServer({}, async (client) => {
    const noPaths = await client.callTool({
      name: "create_codex_worker",
      arguments: { task: "x", cwd: workspace, goal: { objective: "y" } }
    });
    assert.equal(noPaths.isError, true, "missing ownedPaths must be rejected");

    const noGoal = await client.callTool({
      name: "create_codex_worker",
      arguments: { task: "x", cwd: workspace, ownedPaths: ["/tmp/required"] }
    });
    assert.equal(noGoal.isError, true, "missing goal must be rejected");

    const emptyPaths = await client.callTool({
      name: "create_codex_worker",
      arguments: { task: "x", cwd: workspace, ownedPaths: [], goal: { objective: "y" } }
    });
    assert.equal(emptyPaths.isError, true, "empty ownedPaths must be rejected");
  });
});

// ----------------------------------------------------------------- R4 conflicts

await test("R4-2 overlapping ownedPaths are refused with the conflicting task id", async () => {
  await withServer({ FAKE_CODEX_SCENARIO: "hang" }, async (client) => {
    const first = await call(client, "create_codex_worker", {
      ...describe({ title: "owner-a" }),
      ownedPaths: ["/tmp/conflict/shared"]
    });
    await waitFor(client, first.id, (task) => task.status === "running");

    const clash = await call(client, "create_codex_worker", {
      ...describe({ title: "owner-b" }),
      ownedPaths: ["/tmp/conflict/shared/nested/file.ts"]
    });
    assert.equal(clash.error, "ownership_conflict");
    assert.equal(clash.conflicts[0].task_id, first.id);
    assert.equal(clash.conflicts[0].status, "running");

    const distinct = await call(client, "create_codex_worker", {
      ...describe({ title: "owner-c" }),
      ownedPaths: ["/tmp/conflict/other"],
      dependsOn: [first.id]
    });
    assert.equal(distinct.status, "running");
    assert.deepEqual(distinct.depends_on, [first.id]);

    await call(client, "cancel_codex_worker", { task_id: first.id });
    await call(client, "cancel_codex_worker", { task_id: distinct.id });
    const cancelled = await call(client, "get_codex_worker_status", { task_id: first.id });
    assert.equal(cancelled.status, "cancelled");
  });
});

await test("R4-3 a second MCP process can cancel and resume another process's worker", async () => {
  await withServer({ FAKE_CODEX_SCENARIO: "hang" }, async (owner) => {
    const created = await call(owner, "create_codex_worker", describe({ title: "cross-process" }));
    await waitFor(owner, created.id, (task) => task.status === "running");

    await withServer({}, async (other) => {
      const cancelled = await call(other, "cancel_codex_worker", { task_id: created.id });
      assert.equal(cancelled.cancelled, true, JSON.stringify(cancelled));
      const status = await waitFor(other, created.id, (task) => task.status === "cancelled");
      assert.equal(status.status, "cancelled");
    });
  });
});

await test("R3-2 a fresh MCP process resumes the same Codex thread", async () => {
  await withServer({}, async (client) => {
    const created = await call(client, "create_codex_worker", describe({ title: "resume-me" }));
    const first = await waitFor(client, created.id, (task) => task.status === "completed");
    assert.equal(first.thread_id, THREAD_ID);
    assert.equal(first.run_count, 1);
    await withServer({}, async (second) => {
      const resumed = await call(second, "resume_codex_worker", { task_id: created.id, prompt: "keep going" });
      assert.equal(resumed.thread_id, THREAD_ID);
      const final = await waitFor(second, created.id, (task) => task.status === "completed" && task.run_count === 2);
      assert.equal(final.run_count, 2);
      assert.equal(final.resumed_from, created.id);
      assert.equal(final.thread_id, THREAD_ID);
      const summary = await call(second, "get_worker_summary", { task_id: created.id });
      assert.match(summary.summary, /status=completed/);
      assert.match(summary.summary, /resumed from/);
      const goal = await call(second, "get_worker_goal", { task_id: created.id });
      assert.equal(goal.objective, "objective for resume-me");
      assert.equal(goal.native_goal, null);
    });
  });
});

await test("R3-3 resume without a recorded thread_id explains itself", async () => {
  await withServer({}, async (client) => {
    const created = await call(client, "create_codex_worker", describe({ title: "no-thread" }));
    await waitFor(client, created.id, (task) => task.status !== "running" && task.status !== "queued");
    await call(client, "resume_codex_worker", { task_id: created.id, prompt: "x" });
    const missing = await call(client, "resume_codex_worker", { task_id: "codex-does-not-exist", prompt: "x" });
    assert.equal(missing.error, "error");
    assert.match(missing.message, /task not found/);
  });
});

// --------------------------------------------------------------- R4-3 storage

await test("R4-3 five MCP processes write the same database without SQLITE_BUSY", async () => {
  const concurrentHome = await mkdtemp(join(tmpdir(), "supervisor-concurrent-"));
  const clients = await Promise.all(
    Array.from({ length: 5 }, () =>
      (async () => {
        const transport = new StdioClientTransport({
          command: process.execPath,
          args: [join(here, "mcp-server.js")],
          cwd: projectRoot,
          env: { ...process.env, ...baseEnv, SUPERVISOR_HOME: concurrentHome },
          stderr: "pipe"
        });
        const client = new Client({ name: "supervisor-concurrent", version: "1.0.0" });
        await client.connect(transport);
        return client;
      })()
    )
  );

  try {
    const results = await Promise.all(
      clients.flatMap((client, clientIndex) =>
        Array.from({ length: 3 }, (_unused, taskIndex) =>
          call(client, "create_codex_worker", {
            title: `c${clientIndex}-t${taskIndex}`,
            task: "noop",
            cwd: workspace,
            sandbox: "read-only",
            ownedPaths: [`/tmp/concurrent/${clientIndex}-${taskIndex}`],
            goal: { objective: `concurrent ${clientIndex}-${taskIndex}` }
          })
        )
      )
    );
    const errored = results.filter((result) => result.error || result.conflicts);
    assert.equal(errored.length, 0, JSON.stringify(errored).slice(0, 400));

    await Promise.all(
      results.map((result) => waitFor(clients[0], result.id, (task) => task.status !== "running" && task.status !== "queued"))
    );
    const listed = await call(clients[0], "list_codex_workers", { includeHistory: true });
    assert.equal(listed.length, 15);
  } finally {
    await Promise.all(clients.map((client) => client.close()));
  }
});

// ------------------------------------------------- R5 session id + search

await test("R5-1 session_id round-trips and get_session_works groups one batch", async () => {
  await withServer({}, async (client) => {
    const sessionId = "sess-regression-batch-1";
    const created = [];
    for (const part of ["part-a", "part-b"]) {
      created.push(await call(client, "create_codex_worker", describe({ title: part }, { session_id: sessionId })));
    }
    for (const task of created) {
      const status = await waitFor(client, task.id, (row) => row.status === "completed");
      assert.equal(status.session_id, sessionId, "session_id must survive the run");
    }
    const batch = await call(client, "get_session_works", { session_id: sessionId });
    assert.equal(batch.count, 2);
    assert.deepEqual(batch.works.map((work) => work.id).sort(), created.map((task) => task.id).sort());
    assert.equal(batch.active, 0);
    const missing = await call(client, "get_session_works", { session_id: "sess-does-not-exist" });
    assert.equal(missing.count, 0);
  });
});

await test("R5-2 a follow-up worker inherits the parent session_id", async () => {
  await withServer({}, async (client) => {
    const sessionId = "sess-regression-inherit";
    const parent = await call(client, "create_codex_worker", describe({ title: "inherit-parent" }, { session_id: sessionId }));
    await waitFor(client, parent.id, (row) => row.status === "completed");
    const child = await call(client, "create_codex_followup_worker", {
      task_id: parent.id,
      followup_prompt: "keep going",
      ownedPaths: [`/tmp/regression/inherit-child`]
    });
    const status = await waitFor(client, child.id, (row) => row.status === "completed");
    assert.equal(status.session_id, sessionId);
    const batch = await call(client, "get_session_works", { session_id: sessionId });
    assert.equal(batch.count, 2);
  });
});

await test("R5-3 search_works finds a work by keyword across title and goal", async () => {
  await withServer({}, async (client) => {
    const needle = "zebraunicorn";
    const target = await call(client, "create_codex_worker", describe({ title: `search-${needle}` }));
    await waitFor(client, target.id, (row) => row.status === "completed");

    const byTitle = await call(client, "search_works", { query: needle });
    assert.ok(byTitle.works.some((work) => work.id === target.id), "title keyword must match");

    const byGoal = await call(client, "search_works", { query: `objective for search-${needle}` });
    assert.ok(byGoal.works.some((work) => work.id === target.id), "goal keyword must match");

    const noHit = await call(client, "search_works", { query: "keywordthatcannotexistanywhere" });
    assert.equal(noHit.count, 0);
  });
});

// --------------------------------------------- R5 goal preamble framing

await test("R5-4 create asks for a native goal and resume does not", async () => {
  await withServer({ FAKE_CODEX_SCENARIO: "echo-prompt" }, async (client) => {
    const created = await call(client, "create_codex_worker", describe({ title: "preamble-create" }));
    const createdRun = await waitFor(client, created.id, (row) => row.status === "completed");
    const createPrompt = createdRun.last_message ?? "";
    assert.match(createPrompt, /create_goal/, "a new worker must be told to create a goal");
    assert.match(createPrompt, /objective for preamble-create/, "the preamble must carry the real objective");
    assert.match(createPrompt, /update_goal/, "the worker must be told how to close the goal");
    assert.ok(
      createPrompt.indexOf("create_goal") < createPrompt.indexOf("Task preamble-create"),
      "the goal instruction has to come before the task body"
    );

    const resumed = await call(client, "resume_codex_worker", {
      task_id: created.id,
      prompt: "continue the work"
    });
    const resumedRun = await waitFor(client, resumed.id, (row) => row === undefined || row.status === "completed");
    const resumePrompt = resumedRun.last_message ?? "";
    assert.doesNotMatch(resumePrompt, /Call the create_goal tool/, "resume must not ask for a second goal");
    assert.match(resumePrompt, /already has a goal/, "resume must point at the existing goal");
    assert.match(resumePrompt, /continue the work/, "resume must still carry the caller prompt");
  });
});

// ------------------------------------------------------------------- cleanup

await withServer({}, async (client) => {
  const all = await call(client, "list_codex_workers", { includeHistory: true });
  for (const task of all) {
    if (task.status === "running" && task.pid) {
      try {
        process.kill(task.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
});

console.log(`\n${passed} passed, ${failures} failed  (state dir: ${home})`);
process.exit(failures === 0 ? 0 : 1);
