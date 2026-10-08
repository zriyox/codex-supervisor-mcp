// Maps the Codex exec JSONL stream onto the work state machine.
//
// Invariant: status is the lifecycle and is only ever assigned queued /
// running / completed / failed / cancelled / lost. Progress details go to
// phase, which is only meaningful while the work is running.

function getEventType(event) {
  return event.type ?? event.event ?? event.msg?.type ?? "unknown";
}

function getItem(event) {
  return event.item ?? event.msg?.item ?? event.data?.item ?? null;
}

function inferCommand(item) {
  return item?.command ?? item?.cmd ?? item?.arguments?.cmd ?? item?.text ?? null;
}

function inferAgentMessage(item) {
  return item?.text ?? item?.message ?? item?.content ?? item?.output_text ?? null;
}

// The stored event stream is raw Codex JSONL, so reading a worker's own report
// back out means walking `item.completed` events whose item is an
// agent_message. The live state machine and the on-demand result reader share
// this one extraction.
export function extractAgentMessage(event) {
  const item = getItem(event);
  const itemType = item?.type ?? item?.kind ?? item?.name ?? null;
  if (itemType !== "agent_message") return null;
  return inferAgentMessage(item);
}

// Codex reports edits as {"changes":[{"path": "...", "kind": "add"}]}. The
// older flat shapes are kept for compatibility with other event producers.
function inferChangedFiles(item) {
  const candidates = [item?.path, item?.file, item?.file_path, item?.filename].filter(Boolean);
  if (Array.isArray(item?.changes)) {
    for (const change of item.changes) {
      const path = change?.path ?? change?.file;
      if (path) candidates.push(path);
    }
  }
  if (Array.isArray(item?.files)) candidates.push(...item.files);
  return candidates;
}

const ITEM_PHASE = new Map([
  ["command_execution", "command"],
  ["file_change", "editing"],
  ["agent_message", "reporting"],
  ["reasoning", "thinking"],
  ["todo_list", "thinking"],
  ["mcp_tool_call", "command"]
]);

// Codex emits informational items as `item.type === "error"` (config warnings,
// "long threads drift" heads-ups). They are not task failures, so they are
// recorded as notices instead of setting the error field.
function appendNotice(task, message) {
  if (!message) return task;
  const existing = task.notices ? task.notices.split("\n") : [];
  if (existing.includes(message)) return task;
  const combined = [...existing, message].join("\n");
  return { ...task, notices: combined.length > 4000 ? combined.slice(-4000) : combined };
}

const GOAL_EVENT_TYPES = new Set(["thread.goal.updated", "thread_goal_updated", "goal.updated"]);

function applyGoalEvent(next, event) {
  const goal = event.goal ?? event.msg?.goal ?? event.data?.goal ?? event;
  if (!goal) return next;
  if (goal.status) next.goal_status = goal.status;
  if (goal.tokens_used ?? goal.tokensUsed) next.goal_tokens_used = goal.tokens_used ?? goal.tokensUsed;
  if (goal.token_budget ?? goal.tokenBudget) next.goal_token_budget = goal.token_budget ?? goal.tokenBudget;
  if (goal.time_used_seconds ?? goal.timeUsedSeconds) {
    next.goal_time_used_seconds = goal.time_used_seconds ?? goal.timeUsedSeconds;
  }
  if (goal.objective) next.goal_objective = goal.objective;
  next.goal_updated_at = new Date().toISOString();
  return next;
}

export function applyCodexEvent(task, event) {
  const now = new Date().toISOString();
  const eventType = getEventType(event);
  const item = getItem(event);
  const itemType = item?.type ?? item?.kind ?? item?.name ?? null;
  let next = {
    ...task,
    last_event_at: now,
    last_event_type: eventType
  };

  if (eventType === "thread.started") {
    next.status = "running";
    next.phase = "starting";
    const threadId = event.thread_id ?? event.threadId ?? event.msg?.thread_id;
    if (threadId) next.thread_id = threadId;
    return next;
  }

  if (eventType === "turn.started") {
    next.status = "running";
    next.phase = "thinking";
    return next;
  }

  if (ITEM_PHASE.has(itemType) && (eventType === "item.started" || eventType === "item.updated")) {
    next.status = "running";
    next.phase = ITEM_PHASE.get(itemType);
    if (itemType === "command_execution") {
      next.current_command = inferCommand(item);
      next.current_action = next.current_command ? `Running ${next.current_command}` : "Running command";
    } else if (itemType === "file_change") {
      next.current_action = "Editing files";
    } else if (itemType !== "reasoning" && itemType !== "todo_list") {
      next.current_action = `Processing ${itemType}`;
    }
    return next;
  }

  if (eventType === "item.completed") {
    if (itemType === "command_execution") {
      const command = inferCommand(item);
      next.phase = "command";
      next.current_command = null;
      const exitCode = item?.exit_code ?? item?.exitCode ?? null;
      const status = item?.status ?? "completed";
      const entry = { command, exit_code: exitCode, status, completed_at: now };
      // The tail of a failing command's output is the one piece of evidence
      // a reviewer needs to tell "the build is broken" from "the network was
      // down". Only failures keep it: the commands column is one row cell.
      if (commandFailed(entry)) {
        const tail = outputTail(item?.aggregated_output ?? item?.output ?? null);
        if (tail) entry.output_tail = tail;
      }
      next.commands = [...(next.commands ?? []), entry];
      return next;
    }
    if (itemType === "file_change") {
      const files = inferChangedFiles(item);
      next.phase = "editing";
      next.changed_files = Array.from(new Set([...(next.changed_files ?? []), ...files]));
      return next;
    }
    if (itemType === "agent_message") {
      const message = inferAgentMessage(item);
      next.phase = "reporting";
      if (message) next.last_message = message;
      return next;
    }
    if (itemType === "error") {
      return appendNotice(next, item?.message ?? item?.text ?? null);
    }
    if (itemType === "reasoning" || itemType === "mcp_tool_call" || itemType === "todo_list") {
      return next;
    }
  }

  if (eventType === "turn.completed") {
    next.status = "completed";
    next.phase = null;
    next.current_action = "Completed";
    next.current_command = null;
    next.completed_at = now;
    return next;
  }

  if (eventType === "turn.failed") {
    next.status = "failed";
    next.phase = null;
    next.current_action = "Failed";
    next.current_command = null;
    next.completed_at = now;
    // Codex writes the error as an object ({ message }). Stored as-is it
    // cannot be bound to the TEXT column, the whole row update is dropped,
    // and a worker that failed cleanly is later reported as lost.
    next.error = errorText(event.error) ?? errorText(event.message) ?? errorText(event.msg?.error) ?? "Codex turn failed";
    return next;
  }

  if (eventType === "error") {
    return appendNotice(next, errorText(event.message) ?? errorText(event.error) ?? "Codex reported an error event");
  }

  if (GOAL_EVENT_TYPES.has(eventType)) {
    return applyGoalEvent(next, event);
  }

  return next;
}

// An error field as a string, whatever shape Codex gave it.
function errorText(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value || null;
  if (typeof value === "object") {
    const inner = value.message ?? value.error ?? value.msg ?? null;
    if (typeof inner === "string" && inner) return inner;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

const OUTPUT_TAIL_BYTES = 300;

function outputTail(output) {
  if (typeof output !== "string" || !output) return null;
  const buf = Buffer.from(output, "utf8");
  if (buf.length <= OUTPUT_TAIL_BYTES) return output.trim() || null;
  // Cut on a character boundary: drop bytes until the slice decodes cleanly.
  let start = buf.length - OUTPUT_TAIL_BYTES;
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start += 1;
  return `…${buf.subarray(start).toString("utf8").trim()}`;
}

// A sandbox-refused command can come back with no exit code at all, only a
// failed status, so both are failure.
export function commandFailed(entry) {
  if (!entry) return false;
  if (entry.status === "failed") return true;
  return entry.exit_code !== null && entry.exit_code !== undefined && entry.exit_code !== 0;
}

function clipText(value, max) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// What the worker actually ran, condensed for a reviewer to hold its report
// against: a worker that says "tests pass" with commands_run 0, or that ends
// on a failing command and calls the work done, is caught here without
// reading the event stream. The commands list accumulates across resumes,
// so runs says how many turns it covers.
export function summarizeVerification(task, { limit = 10, clip = 160 } = {}) {
  const commands = Array.isArray(task?.commands) ? task.commands : [];
  const failed = commands.filter(commandFailed);
  const last = commands[commands.length - 1] ?? null;
  return {
    runs: task?.run_count ?? 0,
    commands_run: commands.length,
    failed_count: failed.length,
    last_exit_code: last ? (last.exit_code ?? null) : null,
    last_command_failed: commandFailed(last),
    failed: failed.slice(-limit).map((entry) => ({
      command: clipText(entry.command, clip),
      exit_code: entry.exit_code ?? null,
      output_tail: entry.output_tail ?? null
    })),
    last: commands.slice(-limit).map((entry) => ({
      command: clipText(entry.command, clip),
      exit_code: entry.exit_code ?? null,
      failed: commandFailed(entry)
    }))
  };
}
