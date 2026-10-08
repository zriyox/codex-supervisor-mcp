#!/usr/bin/env node
// Deterministic stand-in for the `codex` CLI, used by the supervisor tests.
// Scenario is selected with FAKE_CODEX_SCENARIO.
const args = process.argv.slice(2);
const scenario = process.env.FAKE_CODEX_SCENARIO ?? "happy";
const threadId = process.env.FAKE_CODEX_THREAD_ID ?? "01a0fd0a-0000-7000-8000-000000000001";
const stepMs = Number(process.env.FAKE_CODEX_STEP_MS ?? "0");
const messageLen = Number(process.env.FAKE_CODEX_MESSAGE_LEN ?? "0");
const messageText = messageLen > 0 ? "m".repeat(messageLen) : "done";
// A command can be a heredoc that writes a whole file. FAKE_CODEX_COMMAND_LEN
// reproduces that so the reads that echo commands can be checked for clipping.
const commandLen = Number(process.env.FAKE_CODEX_COMMAND_LEN ?? "0");
const commandText = commandLen > 0 ? `cat <<'EOF' > file.txt\n${"c".repeat(commandLen)}\nEOF` : "ls -la";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
// The worktree the supervisor handed this worker, same flag the real CLI gets.
const cdIndex = args.indexOf("--cd");
const workDir = cdIndex === -1 ? process.cwd() : args[cdIndex + 1];
// How long the process lingers after turn.completed before exiting. The real
// CLI flushes and tears down after its last event; the gap is where a wait
// used to return a half-written terminal state.
const lingerMs = Number(process.env.FAKE_CODEX_LINGER_MS ?? "0");

// Not reading stdin is deliberate: it makes the supervisor hit EPIPE on large
// prompts, which is one of the crash points under test. The echo-prompt
// scenario is the exception: it needs the prompt to assert on prompt framing.
process.stdin.on("error", () => {});
const stdinChunks = [];
process.stdin.on("data", (chunk) => stdinChunks.push(chunk));
process.stdin.on("end", () => {
  if (scenario === "echo-prompt") {
    emit({ type: "thread.started", thread_id: threadId });
    emit({
      type: "item.completed",
      item: { id: "item_0", type: "agent_message", text: Buffer.concat(stdinChunks).toString("utf8") }
    });
    emit({ type: "turn.completed", usage: {} });
  }
});

async function main() {
  if (args[0] === "delete") {
    if (process.env.FAKE_CODEX_DELETE_LOG) {
      const { appendFileSync } = await import("node:fs");
      appendFileSync(process.env.FAKE_CODEX_DELETE_LOG, `${args.filter((a) => !a.startsWith("-")).at(-1)}\n`);
    }
    process.exit(0);
  }
  if (scenario === "exit-immediately") process.exit(3);
  // Output is driven by the stdin "end" handler above.
  if (scenario === "echo-prompt") return;

  // A side question: `exec fork <thread> -` forks, `exec resume <fork> -`
  // continues the fork. The reply echoes the mode and the question, plus
  // one reasoning block and one read-only command, so a test can check the
  // whole chunk sequence the board turns this into.
  if (args[0] === "exec" && (args[1] === "fork" || (args[1] === "resume" && scenario === "side-chat"))) {
    const mode = args[1];
    const target = args.filter((a) => !a.startsWith("-")).at(-1) === "-" ? args.filter((a) => !a.startsWith("-")).at(-2) : args.filter((a) => !a.startsWith("-")).at(-1);
    const raw = Buffer.concat(await new Promise((resolve) => {
      const chunks = [];
      process.stdin.on("data", (c) => chunks.push(c));
      process.stdin.on("end", () => resolve(chunks));
      setTimeout(() => resolve(chunks), 1500);
    })).toString("utf8").trim();
    if (process.env.FAKE_CODEX_STDIN_LOG) {
      const { appendFileSync } = await import("node:fs");
      appendFileSync(process.env.FAKE_CODEX_STDIN_LOG, `${JSON.stringify({ args, stdin: raw })}\n`);
    }
    // The side-chat runner wraps the question in a preamble; the echo below
    // is of the question alone so tests can compare it exactly.
    const marker = raw.lastIndexOf("Question:\n");
    const question = marker === -1 ? raw : raw.slice(marker + "Question:\n".length).trim();
    if (scenario === "side-chat-fail") {
      emit({ type: "thread.started", thread_id: mode === "fork" ? "fork-" + threadId : target });
      emit({ type: "turn.started" });
      emit({ type: "turn.failed", error: { message: "model refused" } });
      return;
    }
    emit({ type: "thread.started", thread_id: mode === "fork" ? `fork-${threadId}` : target });
    emit({ type: "item.completed", item: { id: "item_0", type: "error", message: "Codex is ignoring 1 unrecognized configuration setting." } });
    emit({ type: "turn.started" });
    if (scenario === "side-chat-hang") {
      setInterval(() => {}, 1000);
      return;
    }
    emit({ type: "item.completed", item: { id: "item_1", type: "reasoning", text: `thinking about: ${question}` } });
    emit({ type: "item.started", item: { id: "item_2", type: "command_execution", command: "cat README.md", status: "in_progress" } });
    await wait(stepMs);
    emit({ type: "item.completed", item: { id: "item_2", type: "command_execution", command: "cat README.md", exit_code: 0, status: "completed", aggregated_output: "# readme\n" } });
    emit({ type: "item.completed", item: { id: "item_3", type: "agent_message", text: `[${mode} of ${target}] answer to: ${question}` } });
    emit({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 5, output_tokens: 3 } });
    return;
  }

  if (args[0] === "exec" && args[1] === "resume") {
    if (scenario === "resume-fail") process.exit(4);
    emit({ type: "thread.started", thread_id: threadId });
    await wait(stepMs);
    emit({ type: "turn.started" });
    await wait(stepMs);
    emit({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: `resumed ${args[3] ?? ""}` } });
    await wait(stepMs);
    emit({ type: "turn.completed", usage: {} });
    return;
  }

  if (scenario === "exit-after-thread") {
    emit({ type: "thread.started", thread_id: threadId });
    process.exit(7);
  }

  // The model gateway is down: Codex retries, gives up, writes turn.failed
  // with the error as an object, and exits non-zero. Seen for real against a
  // provider answering 502.
  if (scenario === "turn-failed") {
    emit({ type: "thread.started", thread_id: threadId });
    emit({ type: "turn.started" });
    emit({ type: "error", message: "Reconnecting... 1/5 (unexpected status 502 Bad Gateway)" });
    emit({ type: "turn.failed", error: { message: "unexpected status 502 Bad Gateway: Unknown error, url: http://127.0.0.1:15721/v1/responses" } });
    process.exit(1);
  }

  // A worker whose check fails and who calls the work done anyway: the
  // command exits 1 with output, the report says the tests pass.
  if (scenario === "failing-command") {
    emit({ type: "thread.started", thread_id: threadId });
    emit({ type: "turn.started" });
    emit({ type: "item.started", item: { id: "item_1", type: "command_execution", command: "npm test" } });
    emit({ type: "item.completed", item: { id: "item_1", type: "command_execution", command: "npm test", exit_code: 1, status: "failed", aggregated_output: `${"line\n".repeat(80)}npm ERR! Test failed.  See above for more details.\n` } });
    emit({ type: "item.started", item: { id: "item_2", type: "command_execution", command: "echo done" } });
    emit({ type: "item.completed", item: { id: "item_2", type: "command_execution", command: "echo done", exit_code: 0, status: "completed", aggregated_output: "done\n" } });
    emit({ type: "item.completed", item: { id: "item_3", type: "agent_message", text: "All tests pass. Done." } });
    emit({ type: "turn.completed", usage: {} });
    return;
  }

  // A command that never finishes: item.started went out, nothing follows.
  if (scenario === "hang-in-command") {
    emit({ type: "thread.started", thread_id: threadId });
    emit({ type: "turn.started" });
    emit({ type: "item.started", item: { id: "item_1", type: "command_execution", command: "sleep 3600 && npm test" } });
    setInterval(() => {}, 1000);
    return;
  }

  if (scenario === "hang") {
    emit({ type: "thread.started", thread_id: threadId });
    await wait(stepMs);
    emit({ type: "turn.started" });
    setInterval(() => {}, 1000);
    return;
  }

  // A worker that edits through the shell and commits on its branch: no
  // file_change item is ever emitted and `git status` ends up clean, which is
  // exactly what a real five-worker batch did.
  if (scenario === "commit-in-worktree") {
    const { execFileSync } = await import("node:child_process");
    const { writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "fake", GIT_AUTHOR_EMAIL: "fake@example.com", GIT_COMMITTER_NAME: "fake", GIT_COMMITTER_EMAIL: "fake@example.com" };
    const run = (cmdArgs) => execFileSync("git", ["-C", workDir, ...cmdArgs], { stdio: "ignore", env: gitEnv });
    const insideRepo = (() => {
      try {
        run(["rev-parse", "--is-inside-work-tree"]);
        return true;
      } catch {
        return false;
      }
    })();
    emit({ type: "thread.started", thread_id: threadId });
    emit({ type: "turn.started" });
    const command = "cat <<'EOF' > committed.txt\nhello\nEOF && git add -A && git commit -m 'worker commit'";
    emit({ type: "item.started", item: { id: "item_1", type: "command_execution", command } });
    // Unique content, so a worker cut from another worker's branch still has
    // something to commit on top of it.
    writeFileSync(join(workDir, "committed.txt"), `hello ${process.pid} ${Date.now()}\n`);
    if (insideRepo) {
      run(["add", "-A"]);
      run(["commit", "-q", "-m", "worker commit"]);
    }
    emit({ type: "item.completed", item: { id: "item_1", type: "command_execution", command, exit_code: 0 } });
    writeFileSync(join(workDir, "uncommitted.txt"), "draft\n");
    emit({ type: "item.completed", item: { id: "item_2", type: "agent_message", text: "committed one file, left one draft" } });
    emit({ type: "turn.completed", usage: {} });
    return;
  }

  emit({ type: "thread.started", thread_id: threadId });
  await wait(stepMs);
  emit({ type: "turn.started" });
  await wait(stepMs);
  emit({ type: "item.started", item: { id: "item_1", type: "command_execution", command: commandText } });
  await wait(stepMs);
  emit({ type: "item.completed", item: { id: "item_1", type: "command_execution", command: commandText, exit_code: 0 } });
  await wait(stepMs);
  emit({
    type: "item.started",
    item: { id: "item_2", type: "file_change", changes: [{ path: "/tmp/fake/one.ts", kind: "add" }] }
  });
  await wait(stepMs);
  emit({
    type: "item.completed",
    item: { id: "item_2", type: "file_change", changes: [{ path: "/tmp/fake/one.ts", kind: "add" }, { path: "/tmp/fake/two.ts", kind: "update" }] }
  });
  await wait(stepMs);
  emit({ type: "item.completed", item: { id: "item_3", type: "agent_message", text: messageText } });
  await wait(stepMs);
  emit({ type: "turn.completed", usage: {} });
  if (lingerMs > 0) await wait(lingerMs);
}

main();
