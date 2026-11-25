// Stored stream chunks -> the message parts and the answer text a reader sees.
// Chunks of a turn, assembled into the UIMessage parts the page shows for a
// finished (or interrupted) turn. The page rebuilds history from this.
export function partsFromChunks(chunks) {
  const parts = [];
  const open = new Map(); // id -> part for text / reasoning
  const tools = new Map(); // toolCallId -> part
  for (const c of chunks) {
    switch (c.type) {
      case "text-start":
        open.set(c.id, { type: "text", text: "", state: "streaming" });
        parts.push(open.get(c.id));
        break;
      case "text-delta":
        if (open.has(c.id)) open.get(c.id).text += c.delta ?? "";
        break;
      case "text-end":
        if (open.has(c.id)) open.get(c.id).state = "done";
        break;
      case "reasoning-start":
        open.set(c.id, { type: "reasoning", text: "", state: "streaming" });
        parts.push(open.get(c.id));
        break;
      case "reasoning-delta":
        if (open.has(c.id)) open.get(c.id).text += c.delta ?? "";
        break;
      case "reasoning-end":
        if (open.has(c.id)) open.get(c.id).state = "done";
        break;
      case "tool-input-available": {
        const part = { type: `tool-${c.toolName}`, toolCallId: c.toolCallId, state: "input-available", input: c.input };
        tools.set(c.toolCallId, part);
        parts.push(part);
        break;
      }
      case "tool-output-available":
        if (tools.has(c.toolCallId)) {
          tools.get(c.toolCallId).state = "output-available";
          tools.get(c.toolCallId).output = c.output;
        }
        break;
      case "data-notice":
      case "data-usage":
      case "data-session":
        parts.push({ type: c.type, data: c.data });
        break;
      default:
        break;
    }
  }
  return parts;
}

// The answer of a turn, as the text parts joined; null while nothing has
// been said yet.
export function answerOf(turn) {
  const parts = partsFromChunks(turn.chunks ?? []);
  const text = parts.filter((p) => p.type === "text").map((p) => p.text).join("\n").trim();
  return text || null;
}

export function turnView(turn) {
  return {
    turn_id: turn.id,
    question: turn.question,
    status: turn.status,
    answer: answerOf(turn),
    usage: turn.usage ?? null,
    error: turn.error ?? null,
    started_at: turn.started_at ?? null,
    ended_at: turn.ended_at ?? null
  };
}
