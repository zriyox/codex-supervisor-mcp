#!/usr/bin/env node
// Stands in for `claude -p --output-format stream-json`. It prints the message
// shapes Claude Code 2.1 prints, runs one shell command and writes one file,
// so the runner's translation and the supervisor's bookkeeping are exercised
// without a model. Shapes were recorded from a real run.
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("Usage: claude [options]\n  -p, --print\n  --output-format <format>\n  --json-schema <schema>\n  --settings <file-or-json>\n  -r, --resume [value]");
  process.exit(0);
}
if (process.env.FAKE_CLAUDE_ARGS_LOG) appendFileSync(process.env.FAKE_CLAUDE_ARGS_LOG, `${JSON.stringify(args)}\n`);
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;

const resumeAt = args.indexOf("--resume");
const sessionId = resumeAt >= 0 ? args[resumeAt + 1] : (process.env.FAKE_CLAUDE_SESSION_ID ?? "5f0a1b2c-0000-4000-8000-000000000001");
const print = (message) => console.log(JSON.stringify({ ...message, session_id: sessionId }));
const assistant = (id, content) => print({ type: "assistant", message: { id, type: "message", role: "assistant", content: [content] }, parent_tool_use_id: null });
const toolResult = (id, content, extra = {}) => print({ type: "user", message: { role: "user", content: [{ tool_use_id: id, type: "tool_result", content, is_error: false }] }, ...extra });

print({ type: "system", subtype: "init", cwd: process.cwd(), model: "fake", permissionMode: "bypassPermissions" });
assistant("msg_1", { type: "thinking", thinking: "" });
assistant("msg_1", { type: "tool_use", id: "call_1", name: "Bash", input: { command: "echo fake-claude" } });
toolResult("call_1", "fake-claude", { tool_use_result: { stdout: "fake-claude", stderr: "", interrupted: false } });

const file = process.env.FAKE_CLAUDE_WRITE;
if (file) {
  const path = join(process.cwd(), file);
  writeFileSync(path, `written by fake claude${resumeAt >= 0 ? " (resumed)" : ""}\n`);
  assistant("msg_2", { type: "tool_use", id: "call_2", name: "Write", input: { file_path: path, content: "written by fake claude\n" } });
  toolResult("call_2", `File created successfully at: ${path}`);
}

assistant("msg_3", { type: "text", text: resumeAt >= 0 ? "resumed" : "working" });
if (process.env.FAKE_CLAUDE_SCENARIO === "error") {
  print({ type: "result", subtype: "error_during_execution", is_error: true, result: "API Error: 529 overloaded", usage: {} });
  process.exit(1);
}
const report = { result: resumeAt >= 0 ? "resumed and finished" : "finished", verification: ["echo fake-claude"], not_done: [] };
if (args.includes("--json-schema")) {
  assistant("msg_4", { type: "tool_use", id: "call_3", name: "StructuredOutput", input: report });
  toolResult("call_3", "Structured output provided successfully");
}
print({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(report), structured_output: args.includes("--json-schema") ? report : null,
  usage: { input_tokens: 100, cache_read_input_tokens: 20, cache_creation_input_tokens: 0, output_tokens: 7 }, num_turns: 3, prompt_bytes: prompt.length });
