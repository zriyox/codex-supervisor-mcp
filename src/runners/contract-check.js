// The checks every runner has to pass, built in or not. It needs no test
// framework: give it the runner and a transcript (lines the CLI printed for
// one finished run) and it returns the problems it found, none when the
// runner is sound. docs/runner.md shows it inside a test.
import { assertRunner, CAPABILITIES } from "./contract.js";

const EVENT_TYPES = new Set(["thread.started", "turn.started", "turn.completed", "turn.failed", "item.started", "item.updated", "item.completed", "error"]);
const isStrings = (value) => Array.isArray(value) && value.every((entry) => typeof entry === "string");

function checkArgs(runner, problems) {
  const start = runner.startArgs({ cwd: process.cwd(), sandbox: "workspace-write", model: null, reasoningEffort: "high", skipGitRepoCheck: true });
  if (!isStrings(start)) problems.push("startArgs() must return an array of strings");
  const record = { id: "contract-1", cwd: process.cwd(), sandbox: "workspace-write", guard_policy: {} };
  for (const outputSchema of [true, false]) {
    const launch = runner.launchArgs({ args: isStrings(start) ? start : [], record, outputSchema, writableRoots: [] });
    if (!isStrings(launch)) problems.push(`launchArgs({ outputSchema: ${outputSchema} }) must return an array of strings`);
  }
  if (runner.capabilities.resume) {
    const resume = runner.resumeArgs({ ...record, thread_id: "thread-1", model: null, reasoning_effort: "high" });
    if (!isStrings(resume)) problems.push("resumeArgs() must return an array of strings");
    else if (!resume.includes("thread-1")) problems.push("resumeArgs() must pass the stored thread_id to the CLI");
  }
}

function checkTranscript(runner, transcript, problems) {
  const events = [];
  for (const line of transcript) {
    let produced;
    try {
      produced = runner.toEvents(line);
    } catch (error) {
      problems.push(`toEvents() threw on a transcript line: ${error.message}`);
      continue;
    }
    if (!Array.isArray(produced)) problems.push("toEvents() must return an array");
    else events.push(...produced);
  }
  for (const event of events) {
    if (!EVENT_TYPES.has(event?.type)) problems.push(`toEvents() produced an event outside the vocabulary: ${JSON.stringify(event).slice(0, 120)}`);
  }
  const started = events.find((event) => event.type === "thread.started");
  if (!started?.thread_id) problems.push("the transcript must yield thread.started with a thread_id");
  if (!["turn.completed", "turn.failed"].includes(events.at(-1)?.type)) problems.push("the transcript must end in turn.completed or turn.failed");
  if (!events.some((event) => event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string")) {
    problems.push("the transcript must yield the worker's final message as an agent_message item");
  }
  let task = { id: "contract-1", status: "queued", commands: [], changed_files: [] };
  try {
    for (const event of events) task = runner.parseEvent(task, event);
    if (started?.thread_id && task.thread_id !== started.thread_id) problems.push("parseEvent() must record the thread_id");
    if (events.at(-1)?.type === "turn.completed" && task.status !== "completed") problems.push("parseEvent() must end a completed turn in status completed");
  } catch (error) {
    problems.push(`parseEvent() threw: ${error.message}`);
  }
}

export function checkRunner(runner, { transcript = [] } = {}) {
  try {
    assertRunner(runner);
  } catch (error) {
    return [error.message];
  }
  const problems = [];
  try {
    checkArgs(runner, problems);
  } catch (error) {
    problems.push(`building arguments threw: ${error.message}`);
  }
  let threw = false;
  try {
    runner.toEvents("this is not what the CLI prints {");
  } catch {
    threw = true;
  }
  // A line that is not an event is reported by the core; swallowing it would hide a broken CLI.
  if (!threw) problems.push("toEvents() must throw on a line it cannot read");
  if (transcript.length > 0) checkTranscript(runner, transcript, problems);
  else problems.push("give a transcript: the lines the CLI printed for one finished run");
  return problems;
}

export { CAPABILITIES };
