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

function inferChangedFiles(item) {
  const candidates = [
    item?.path,
    item?.file,
    item?.file_path,
    item?.filename
  ].filter(Boolean);
  if (Array.isArray(item?.files)) candidates.push(...item.files);
  return candidates;
}

export function applyCodexEvent(task, event) {
  const now = new Date().toISOString();
  const eventType = getEventType(event);
  const item = getItem(event);
  const itemType = item?.type ?? item?.kind ?? item?.name ?? null;
  const next = {
    ...task,
    last_event_at: now,
    last_event_type: eventType
  };

  if (eventType === "thread.started") {
    next.status = "running";
    next.phase = "starting";
  }

  if (eventType === "turn.started") {
    next.status = "running";
    next.phase = "thinking";
  }

  if (eventType === "item.started" || eventType === "item.updated") {
    next.status = "running";
    if (itemType === "command_execution") {
      next.phase = "command";
      next.current_command = inferCommand(item);
      next.current_action = next.current_command ? `Running ${next.current_command}` : "Running command";
    } else if (itemType === "file_change") {
      next.phase = "editing";
      next.current_action = "Editing files";
    } else if (itemType) {
      next.phase = itemType;
      next.current_action = `Processing ${itemType}`;
    }
  }

  if (eventType === "item.completed") {
    if (itemType === "command_execution") {
      const command = inferCommand(item);
      next.phase = "command_completed";
      next.current_command = null;
      next.commands = [
        ...(next.commands ?? []),
        {
          command,
          exit_code: item?.exit_code ?? item?.exitCode ?? null,
          status: item?.status ?? "completed",
          completed_at: now
        }
      ];
    } else if (itemType === "file_change") {
      const files = inferChangedFiles(item);
      next.phase = "editing";
      next.changed_files = Array.from(new Set([...(next.changed_files ?? []), ...files]));
    } else if (itemType === "agent_message") {
      const message = inferAgentMessage(item);
      next.phase = "reporting";
      if (message) next.last_message = message;
    }
  }

  if (eventType === "turn.completed") {
    next.status = "completed";
    next.phase = "completed";
    next.current_action = "Completed";
    next.current_command = null;
    next.completed_at = now;
  }

  if (eventType === "turn.failed") {
    next.status = "failed";
    next.phase = "failed";
    next.current_action = "Failed";
    next.current_command = null;
    next.completed_at = now;
    next.error = event.error ?? event.message ?? event.msg?.error ?? "Codex turn failed";
  }

  return next;
}
