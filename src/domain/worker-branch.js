// The branch a worker's commits live on. Workers dispatched before 1.0 used
// codex/<id>; their rows carry no branch name, so that is the fallback, and
// they can still be resumed, landed and restored.
export const newWorkerBranch = (taskId) => `worker/${taskId}`;

export const branchOf = (task) => task.workspace_metadata?.branch ?? `codex/${task.id}`;
