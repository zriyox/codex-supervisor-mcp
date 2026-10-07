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
  if (scenario === "exit-immediately") process.exit(3);
  // Output is driven by the stdin "end" handler above.
  if (scenario === "echo-prompt") return;

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

  if (scenario === "hang") {
    emit({ type: "thread.started", thread_id: threadId });
    await wait(stepMs);
    emit({ type: "turn.started" });
    setInterval(() => {}, 1000);
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
}

main();
