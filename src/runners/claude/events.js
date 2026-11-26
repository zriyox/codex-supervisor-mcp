// Turns Claude Code's stream-json into the supervisor's event vocabulary
// (see ../contract.js). Claude Code prints whole messages: an assistant
// message holds the tool calls it makes, a later user message holds their
// results. A tool call is therefore remembered until its result arrives.
const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const MAX_PENDING = 500;

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (typeof part === "string" ? part : part?.text ?? "")).join("");
}

function usageOf(usage) {
  if (!usage) return undefined;
  return {
    input_tokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
    cached_input_tokens: usage.cache_read_input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0
  };
}

export function createTranslator() {
  const pending = new Map();
  let reported = false;

  function toolCall(part) {
    if (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value);
    if (part.name === "Bash") {
      const command = String(part.input?.command ?? "");
      pending.set(part.id, { type: "command_execution", command });
      return [{ type: "item.started", item: { id: part.id, type: "command_execution", command, aggregated_output: "", exit_code: null, status: "in_progress" } }];
    }
    if (FILE_TOOLS.has(part.name)) {
      const path = part.input?.file_path ?? part.input?.notebook_path ?? null;
      pending.set(part.id, { type: "file_change", path });
      return [];
    }
    // The structured report arrives as a call of this tool; it is the worker's final message.
    if (part.name === "StructuredOutput") {
      reported = true;
      return [{ type: "item.completed", item: { id: part.id, type: "agent_message", text: JSON.stringify(part.input ?? {}) } }];
    }
    pending.set(part.id, { type: "mcp_tool_call", tool: part.name });
    return [{ type: "item.started", item: { id: part.id, type: "mcp_tool_call", tool: part.name, status: "in_progress" } }];
  }

  function toolResult(part, message) {
    const call = pending.get(part.tool_use_id);
    if (!call) return [];
    pending.delete(part.tool_use_id);
    const failed = part.is_error === true;
    if (call.type === "command_execution") {
      const raw = message.tool_use_result;
      const output = raw && typeof raw === "object" ? [raw.stdout, raw.stderr].filter(Boolean).join("\n") : textOf(part.content);
      return [{ type: "item.completed", item: { id: part.tool_use_id, type: "command_execution", command: call.command,
        aggregated_output: output || textOf(part.content), exit_code: failed ? 1 : 0, status: failed ? "failed" : "completed" } }];
    }
    if (call.type === "file_change") {
      // A refused or failed edit changed nothing.
      if (failed || !call.path) return [];
      return [{ type: "item.completed", item: { id: part.tool_use_id, type: "file_change", changes: [{ path: call.path, kind: "update" }], status: "completed" } }];
    }
    return [{ type: "item.completed", item: { id: part.tool_use_id, type: "mcp_tool_call", tool: call.tool, status: failed ? "failed" : "completed" } }];
  }

  function result(message) {
    if (message.is_error || (message.subtype && message.subtype !== "success")) {
      const text = typeof message.result === "string" && message.result ? message.result : `Claude Code ended with ${message.subtype ?? "an error"}`;
      return [{ type: "turn.failed", error: { message: text } }];
    }
    const events = [];
    if (!reported && message.structured_output != null) {
      events.push({ type: "item.completed", item: { id: `result-${message.uuid ?? "final"}`, type: "agent_message", text: JSON.stringify(message.structured_output) } });
    }
    events.push({ type: "turn.completed", usage: usageOf(message.usage) });
    return events;
  }

  return function translate(message) {
    if (message.type === "system" && message.subtype === "init") {
      reported = false;
      return [{ type: "thread.started", thread_id: message.session_id }, { type: "turn.started" }];
    }
    if (message.type === "assistant") {
      const events = [];
      for (const part of message.message?.content ?? []) {
        if (part.type === "text" && part.text?.trim()) events.push({ type: "item.completed", item: { id: `${message.message.id}-text`, type: "agent_message", text: part.text } });
        else if (part.type === "tool_use") events.push(...toolCall(part));
      }
      return events;
    }
    if (message.type === "user") {
      const parts = Array.isArray(message.message?.content) ? message.message.content : [];
      return parts.filter((part) => part?.type === "tool_result").flatMap((part) => toolResult(part, message));
    }
    if (message.type === "result") return result(message);
    return [];
  };
}
