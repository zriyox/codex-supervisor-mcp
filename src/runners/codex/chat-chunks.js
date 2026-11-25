// Codex events -> the UI message stream chunks the board's side chat renders.

const OUTPUT_CLIP = 4000;

function clip(text, max = OUTPUT_CLIP) {
  if (typeof text !== "string") return text ?? null;
  return text.length <= max ? text : `${text.slice(0, max)}\n…(${text.length - max} more characters)`;
}

function completedItemChunks(item, state) {
  const out = [];
  switch (item.type) {
    case "reasoning": {
      const id = `r-${item.id}`;
      out.push({ type: "reasoning-start", id }, { type: "reasoning-delta", id, delta: item.text ?? "" }, { type: "reasoning-end", id });
      break;
    }
    case "agent_message": {
      const id = `t-${item.id}`;
      out.push({ type: "text-start", id }, { type: "text-delta", id, delta: item.text ?? "" }, { type: "text-end", id });
      break;
    }
    case "command_execution":
      if (!state.toolsSeen.has(item.id)) {
        state.toolsSeen.add(item.id);
        out.push({ type: "tool-input-available", toolCallId: item.id, toolName: "shell", input: { command: item.command ?? "" } });
      }
      out.push({
        type: "tool-output-available",
        toolCallId: item.id,
        output: { exit_code: item.exit_code ?? null, status: item.status ?? null, output: clip(item.aggregated_output ?? "") }
      });
      break;
    case "file_change":
      out.push(
        { type: "tool-input-available", toolCallId: item.id, toolName: "edit", input: { changes: item.changes ?? [] } },
        { type: "tool-output-available", toolCallId: item.id, output: { status: item.status ?? "completed" } }
      );
      break;
    case "web_search":
    case "mcp_tool_call":
      out.push(
        { type: "tool-input-available", toolCallId: item.id, toolName: item.type, input: { ...item, id: undefined, type: undefined } },
        { type: "tool-output-available", toolCallId: item.id, output: { status: item.status ?? "completed" } }
      );
      break;
    case "error":
      // Startup notices (unknown config keys, missing model metadata) come
      // through as error items. They are not the answer failing.
      out.push({ type: "data-notice", data: { message: item.message ?? item.text ?? "" } });
      break;
    default:
      break;
  }
  return out;
}

export function chunksFor(event, state) {
  const item = event.item ?? {};
  const out = [];
  switch (event.type) {
    case "thread.started":
      if (event.thread_id) out.push({ type: "data-session", data: { fork_thread_id: event.thread_id } });
      break;
    case "turn.started":
      out.push({ type: "start-step" });
      break;
    case "item.started":
    case "item.updated":
      if (item.type === "command_execution" && !state.toolsSeen.has(item.id)) {
        state.toolsSeen.add(item.id);
        out.push({ type: "tool-input-available", toolCallId: item.id, toolName: "shell", input: { command: item.command ?? "" } });
      }
      break;
    case "item.completed":
      out.push(...completedItemChunks(item, state));
      break;
    case "turn.completed":
      out.push({ type: "finish-step" });
      if (event.usage) {
        out.push({ type: "data-usage", data: event.usage });
        state.usage = event.usage;
      }
      state.completed = true;
      break;
    case "turn.failed":
      out.push({ type: "error", errorText: event.error?.message ?? event.error ?? event.message ?? "Codex turn failed" });
      state.failed = true;
      break;
    case "error":
      out.push({ type: "data-notice", data: { message: event.message ?? event.error ?? "" } });
      break;
    default:
      break;
  }
  return out;
}
