// Composition root: wires the runner into the layers that may not import it.
// Every process entry imports this before it touches the store.
import { registerRunnerReaders } from "../infra/store/runner-readers.js";
import { extractAgentMessage } from "../runners/codex/event-parser.js";
import { readNativeGoal } from "../runners/codex/goal-store.js";

registerRunnerReaders({ nativeGoal: readNativeGoal, agentMessage: extractAgentMessage });
