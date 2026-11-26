// What a runner is. A runner is the only code that knows one CLI: its
// arguments, its output, how it is stopped. The core asks for these members
// and nothing else, and reads `capabilities` before using an optional one.
//
// Events. Whatever the CLI prints, `toEvents(line)` returns events in the
// supervisor's vocabulary, which is what is stored and what every reader
// understands:
//
//   { type: "thread.started", thread_id }
//   { type: "turn.started" }
//   { type: "item.started" | "item.completed", item: { id, type, ... } }
//       item.type "agent_message"      { text }
//       item.type "command_execution"  { command, aggregated_output, exit_code, status }
//       item.type "file_change"        { changes: [{ path, kind }] }
//   { type: "turn.completed", usage? }
//   { type: "turn.failed", error: { message } }
//
// docs/runner.md walks through writing one.
export const CAPABILITIES = ["os_sandbox", "resume", "side_chat", "tool_guard", "structured_report", "native_goal"];

const REQUIRED = ["resolveTarget", "capabilityPreflight", "startArgs", "launchArgs", "toEvents", "parseEvent", "cancelChild", "cancelPid", "ownsPid"];
// Members a runner must have once it declares the capability.
const BY_CAPABILITY = { resume: ["resumeArgs"], side_chat: ["sideChat", "start"], native_goal: ["nativeGoal", "nativeGoalState"] };

// Throws with every problem at once, so a runner author fixes them in one pass.
export function assertRunner(runner, source = "runner") {
  const problems = [];
  if (!runner || typeof runner !== "object") throw new Error(`${source} does not export a runner object`);
  if (typeof runner.name !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(runner.name)) problems.push("name must be a short lowercase identifier");
  const capabilities = runner.capabilities ?? {};
  for (const key of CAPABILITIES) if (typeof capabilities[key] !== "boolean") problems.push(`capabilities.${key} must be true or false`);
  for (const key of Object.keys(capabilities)) if (!CAPABILITIES.includes(key)) problems.push(`capabilities.${key} is not a known capability`);
  for (const member of REQUIRED) if (typeof runner[member] !== "function") problems.push(`${member}() is missing`);
  for (const [capability, members] of Object.entries(BY_CAPABILITY)) {
    if (capabilities[capability] !== true) continue;
    for (const member of members) if (runner[member] == null) problems.push(`${member} is required by capabilities.${capability}`);
  }
  if (problems.length > 0) throw new Error(`${source} is not a valid runner: ${problems.join("; ")}`);
  return runner;
}

// The error a caller gets for asking a runner for something it cannot do.
export function unsupported(runner, capability, what) {
  return Object.assign(new Error(`${what} is not supported by the ${runner.name} runner (no ${capability})`), { code: "unsupported", capability, runner: runner.name });
}

// Without an OS sandbox nothing but the worktree confines what a worker
// writes, so such a runner gets a worktree or a read-only run and nothing else.
export function assertWorkspaceAllowed(runnerName, confined, workspaceKind) {
  if (confined !== false || ["git_worktree", "read_only_in_place"].includes(workspaceKind)) return;
  throw Object.assign(new Error(`the ${runnerName} runner has no OS sandbox, so it can only run in a git_worktree or read_only_in_place workspace, not ${workspaceKind}`),
    { code: "unsupported", capability: "os_sandbox", runner: runnerName });
}
