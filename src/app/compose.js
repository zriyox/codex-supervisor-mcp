// Composition root: wires the runners into the layers that may not import them.
// Every process entry imports this before it touches the store.
import { registerRunnerReaders } from "../infra/store/runner-readers.js";
import { extractAgentMessage } from "../runners/codex/event-parser.js";
import { DEFAULT_RUNNER, runnerNames, getRunner } from "../runners/registry.js";

// A row names its runner. One whose runner is not loaded in this process, or
// has no native goal, simply has none to show.
function nativeGoal(threadId, runnerName = DEFAULT_RUNNER) {
  const name = runnerName ?? DEFAULT_RUNNER;
  if (!runnerNames().includes(name)) return null;
  const runner = getRunner(name);
  return runner.capabilities.native_goal ? runner.nativeGoal(threadId) : null;
}

// Stored events are in the supervisor's vocabulary whatever CLI produced them.
registerRunnerReaders({ nativeGoal, agentMessage: extractAgentMessage });
