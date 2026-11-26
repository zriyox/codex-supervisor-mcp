// The Claude Code runner end to end against a stand-in CLI: a worker is
// dispatched, its output becomes the supervisor's events, it resumes in the
// same session, and what Claude Code cannot do is refused by name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dispatchArgs, makeRepo, tempHome, waitFor, withMcp } from "./helpers.js";

const fakeClaude = fileURLToPath(new URL("../fixtures/fake-claude.js", import.meta.url));

test("a claude worker runs, reports, lands nothing outside its paths and resumes in the same session", async () => {
  const home = await tempHome("supervisor-claude-");
  const { dir } = await makeRepo(join(home, "repo"));
  const argsLog = join(home, "claude-args.jsonl");
  await withMcp({ SUPERVISOR_HOME: home, CLAUDE_BIN: fakeClaude, FAKE_CLAUDE_WRITE: "result.txt", FAKE_CLAUDE_ARGS_LOG: argsLog }, async ({ call }) => {
    const worker = await call("create_worker", dispatchArgs("claude writes", dir, { runner: "claude", sandbox: { mode: "workspace-write" }, owned_paths: ["result.txt"] }));
    assert.match(worker.id, /^claude-/, JSON.stringify(worker));
    const done = await waitFor(call, worker.id, (task) => task.status === "completed" && task.exit_code === 0);
    assert.equal(done.worker, "claude");
    assert.equal(done.thread_id, "5f0a1b2c-0000-4000-8000-000000000001");
    assert.equal(done.attention_reason, null, JSON.stringify(done).slice(0, 600));

    const result = await call("get_worker", { task_id: worker.id, include: ["result"], include_files: true });
    assert.match(JSON.stringify(result.reports ?? result), /finished/);
    assert.deepEqual(result.changed_files.map((file) => file.split(/[\\/]/).at(-1)), ["result.txt"]);
    const { events } = await call("get_worker", { task_id: worker.id, include: ["events"] });
    const kinds = events.map((event) => event.item ? `${event.type}:${event.item.type}` : event.type);
    assert.deepEqual(kinds.slice(0, 4), ["thread.started", "turn.started", "item.started:command_execution", "item.completed:command_execution"]);
    assert.ok(kinds.includes("item.completed:file_change") && kinds.at(-1) === "turn.completed", kinds.join(" "));

    const resumed = await call("resume_worker", { task_id: worker.id, prompt: "one more pass" });
    assert.ok(!resumed.error, JSON.stringify(resumed));
    const second = await waitFor(call, worker.id, (task) => task.run_count === 2 && task.status === "completed" && task.exit_code === 0);
    assert.equal(second.thread_id, done.thread_id);
    const launches = (await readFile(argsLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(launches[0].includes("--settings") && launches[0].includes("--json-schema"), "the guard hook and the report schema are installed");
    assert.deepEqual(launches[1].slice(launches[1].indexOf("--resume"), launches[1].indexOf("--resume") + 2), ["--resume", done.thread_id]);

    // What this runner cannot do is refused by name, not attempted.
    const asked = await call("ask_worker", { task_id: worker.id, question: "what did you do?" });
    assert.equal(asked.error, "unsupported", JSON.stringify(asked));
    const scratch = await call("create_worker", dispatchArgs("claude scratch", dir, { runner: "claude", workspace: { kind: "scratch" }, sandbox: { mode: "workspace-write" }, owned_paths: [] }));
    assert.match(JSON.stringify(scratch), /no OS sandbox/);
  });
});

test("a failed claude turn is a failed worker with the CLI's message", async () => {
  const home = await tempHome("supervisor-claude-fail-");
  const { dir } = await makeRepo(join(home, "repo"));
  await withMcp({ SUPERVISOR_HOME: home, CLAUDE_BIN: fakeClaude, FAKE_CLAUDE_SCENARIO: "error" }, async ({ call }) => {
    const worker = await call("create_worker", dispatchArgs("claude fails", dir, { runner: "claude", sandbox: { mode: "read-only" }, owned_paths: [] }));
    const failed = await waitFor(call, worker.id, (task) => task.status === "failed" && task.exit_code !== null);
    assert.match(failed.error, /529 overloaded/);
  });
});

test("an unknown runner is refused with the ones that exist", async () => {
  const home = await tempHome("supervisor-runner-unknown-");
  const { dir } = await makeRepo(join(home, "repo"));
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const reply = await call("create_worker", dispatchArgs("nobody", dir, { runner: "nosuch", owned_paths: ["a.txt"] }));
    assert.match(JSON.stringify(reply), /runner \\?"nosuch\\?" is not available.*codex, claude/);
  });
});
