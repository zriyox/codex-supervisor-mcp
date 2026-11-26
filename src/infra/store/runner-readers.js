// The store hydrates a task with two facts only a runner can read: the CLI's
// native goal for a thread, and the agent message inside a stored event. The
// store may not import a runner, so the composition root registers the readers.
const missing = (name) => () => {
  throw new Error(`store reader "${name}" is not registered; import app/compose.js before using the store`);
};

const readers = { nativeGoal: missing("nativeGoal"), agentMessage: missing("agentMessage") };

export function registerRunnerReaders({ nativeGoal, agentMessage }) {
  readers.nativeGoal = nativeGoal;
  readers.agentMessage = agentMessage;
}

export const readNativeGoal = (threadId, runnerName) => readers.nativeGoal(threadId, runnerName);
export const extractAgentMessage = (event) => readers.agentMessage(event);
