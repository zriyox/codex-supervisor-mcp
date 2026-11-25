// Reads the worker's output: stdout lines become stored events and move the
// task row forward, stderr keeps a tail on the row.
import { splitLines } from "../app/worktree-setup.js";
import { appendTaskEvents } from "../infra/store/events.js";
import { codexRunner } from "../runners/codex/adapter.js";
import { persist } from "./live-run.js";

const STDERR_KEEP = 64 * 1024;

async function handleLines(run, lines) {
  const events = [];
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      run.logStream.write(`${JSON.stringify(event)}\n`);
      events.push(event);
    } catch (error) {
      run.logStream.write(`${JSON.stringify({ type: "supervisor.parse_error", line, error: error.message })}\n`);
    }
  }
  if (events.length === 0) return;
  const storedEvents = await appendTaskEvents(run.record.id, events, { runId: run.runId, actor: "codex" });
  let next = run.live;
  for (const [index, event] of events.entries()) {
    if (event.type === "item.completed" && event.item?.type === "agent_message") {
      run.rawReport = event.item.text;
      run.rawReportEventId = storedEvents[index].id;
    }
    if (["turn.completed", "turn.failed"].includes(event.type)) run.terminalEvent = true;
    next = codexRunner.parseEvent(next, event);
  }
  await persist(run, next);
}

// Lines that arrive in one tick are stored and applied as one batch.
export function queueEventLines(run, lines) {
  run.pendingLines.push(...lines);
  if (run.eventFlushPending) return;
  run.eventFlushPending = true;
  run.eventChain = run.eventChain.then(async () => {
    await new Promise((resolveFlush) => setImmediate(resolveFlush));
    const batch = run.pendingLines;
    run.pendingLines = [];
    run.eventFlushPending = false;
    await handleLines(run, batch);
  }).catch((error) => {
    process.stderr.write(`[codex-supervisor] event handling failed for ${run.record.id}: ${error.message}\n`);
  });
}

export function attachStreams(run, earlyOutput) {
  const { child } = run;
  const handleStdoutChunk = (chunk) => {
    const split = splitLines(run.stdoutRest, chunk.toString("utf8"));
    run.stdoutRest = split.rest;
    const lines = split.lines.filter((line) => line.trim());
    if (lines.length) queueEventLines(run, lines);
  };
  earlyOutput.capture = false;
  for (const chunk of earlyOutput.stdout) handleStdoutChunk(chunk);
  child.stdout.on("data", handleStdoutChunk);
  child.stdout.on("error", () => {});

  run.stderr = earlyOutput.stderr.map((chunk) => chunk.toString("utf8")).join("").slice(-STDERR_KEEP);
  child.stderr.on("data", (chunk) => {
    // Only the tail is ever used, so only the tail is kept: a worker that
    // logs for hours must not grow this process without bound.
    run.stderr = (run.stderr + chunk.toString("utf8")).slice(-STDERR_KEEP);
    persist(run, { ...run.live, stderr_tail: run.stderr.slice(-4000), updated_at: new Date().toISOString() });
  });
  child.stderr.on("error", () => {});

  child.on("error", (error) => {
    persist(run, {
      ...run.live,
      error: run.live.error ?? `codex process error: ${error.message}`,
      updated_at: new Date().toISOString()
    });
  });
}
