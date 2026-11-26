// One set of checks for every runner. The transcripts are what each CLI
// printed for a finished run; the Claude Code one was recorded from 2.1.332.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { dispatchArgs, makeRepo, tempHome, waitFor, withMcp } from "./helpers.js";
import { checkRunner } from "../../src/runners/contract-check.js";
import { ClaudeRunnerAdapter } from "../../src/runners/claude/adapter.js";
import { CodexRunnerAdapter } from "../../src/runners/codex/adapter.js";

const transcript = async (name) => (await readFile(new URL(`../fixtures/transcripts/${name}.jsonl`, import.meta.url), "utf8")).trim().split("\n");

for (const [name, Runner] of [["codex", CodexRunnerAdapter], ["claude", ClaudeRunnerAdapter]]) {
  test(`the ${name} runner meets the runner contract`, async () => {
    assert.deepEqual(checkRunner(new Runner(), { transcript: await transcript(name) }), []);
  });
}

test("the contract check names what a broken runner is missing", () => {
  const problems = checkRunner({ name: "Broken", capabilities: { resume: true }, startArgs: () => "nope" });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /name must be a short lowercase identifier/);
  assert.match(problems[0], /capabilities\.os_sandbox must be true or false/);
  assert.match(problems[0], /toEvents\(\) is missing/);
  assert.match(problems[0], /resumeArgs is required by capabilities\.resume/);
});

test("a runner outside the package is loaded from the file an environment variable names", async () => {
  const home = await tempHome("supervisor-runner-plugin-");
  const { dir } = await makeRepo(join(home, "repo"));
  const plugin = join(home, "plugin", "echo-runner.mjs");
  await mkdir(join(home, "plugin"), { recursive: true });
  const adapter = pathToFileURL(join(import.meta.dirname, "../../src/runners/claude/adapter.js")).href;
  // The smallest plugin: an existing adapter under another name.
  await writeFile(plugin, `import { ClaudeRunnerAdapter } from ${JSON.stringify(adapter)};\nexport const runner = new ClaudeRunnerAdapter();\nrunner.name = "echo";\n`);
  const fakeClaude = join(import.meta.dirname, "../fixtures/fake-claude.js");
  await withMcp({ SUPERVISOR_HOME: home, CLAUDE_BIN: fakeClaude, AGENT_SUPERVISOR_RUNNER_ECHO: plugin }, async ({ call }) => {
    const worker = await call("create_worker", dispatchArgs("plugin worker", dir, { runner: "echo", sandbox: { mode: "read-only" }, owned_paths: [] }));
    assert.match(worker.id ?? "", /^echo-/, JSON.stringify(worker));
    const done = await waitFor(call, worker.id, (task) => task.status === "completed" && task.exit_code === 0);
    assert.equal(done.worker, "echo");
  });
});
