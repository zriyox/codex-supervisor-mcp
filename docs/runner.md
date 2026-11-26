# Writing a runner

A runner is the one piece of code that knows a CLI. The supervisor asks it how to start and resume the CLI, what its output means and how to stop it, and does everything else itself: worktrees, the state machine, acceptance, landing, cleanup.

Two are built in, `codex` and `claude`. A worker picks one with `create_worker`'s `runner` argument; the name is stored on the worker and every later step uses the same runner.

## What a runner declares

`capabilities` is six booleans. The core reads one before using the feature, and a caller that asks for something a runner lacks gets `error: "unsupported"` naming the capability.

| Capability | Means | Without it |
|---|---|---|
| `os_sandbox` | The CLI confines writes itself (Codex's Seatbelt or Landlock sandbox) | Only `git_worktree` and `read_only_in_place` workspaces; the guard hook is the whole confinement |
| `resume` | A finished session can be continued by id | `resume_worker` is unsupported, and a dead first run is not recovered |
| `side_chat` | A read-only fork of the session can answer a question | `ask_worker` is unsupported |
| `tool_guard` | A hook can refuse a tool call before it runs | `owned_paths` is enforced only at landing |
| `structured_report` | The CLI can be held to a JSON Schema for its final answer | The final message is read as prose |
| `native_goal` | The CLI has its own goal with a token budget | `get_worker`'s `goal` part shows only the supervisor's |

| | `codex` | `claude` |
|---|---|---|
| `os_sandbox` | yes | no |
| `resume` | yes | yes |
| `side_chat` | yes | no |
| `tool_guard` | yes | yes |
| `structured_report` | yes | yes |
| `native_goal` | yes | no |

## The interface

A runner is an object. `src/runners/contract.js` validates it when it is loaded and lists every problem at once.

| Member | Purpose |
|---|---|
| `name` | Lowercase identifier. Also the prefix of the worker's id |
| `capabilities` | The six booleans above |
| `resolveTarget()` | Finds the CLI: `{ cmd, prefixArgs }`, or `{ error }` |
| `capabilityPreflight()` | Checks the installed CLI has what the runner needs: `{ ok, target }` or `{ ok: false, error }` |
| `startArgs({ cwd, sandbox, model, reasoningEffort })` | Arguments for a new session. The prompt arrives on stdin; the process's working directory is the worktree |
| `resumeArgs(task)` | Arguments to continue `task.thread_id`. Required with `resume` |
| `launchArgs({ args, record, outputSchema, writableRoots })` | Adds what installs the guard hook and the report schema. The guard reads its policy from `AGENT_SUPERVISOR_GUARD_POLICY` |
| `toEvents(line)` | One line of the CLI's stdout to zero or more events in the supervisor's vocabulary. Throws on a line it cannot read |
| `parseEvent(task, event)` | Applies one event to the worker's row |
| `cancelChild(child)`, `cancelPid(pid)` | Stops the worker and, on Windows, its process tree |
| `ownsPid(pid, describeProcess)` | Whether a pid still looks like this CLI, checked before a stored pid is signalled |
| `sideChat` | Required with `side_chat` |
| `nativeGoal(threadId)`, `nativeGoalState(threadId)` | Required with `native_goal` |

## Events

Whatever the CLI prints, what is stored is one vocabulary, so the state machine, `get_worker` and the board read every runner the same way.

```
{ "type": "thread.started", "thread_id": "..." }
{ "type": "turn.started" }
{ "type": "item.started" | "item.completed", "item": { "id": "...", "type": "...", ... } }
    agent_message      { "text": "..." }
    command_execution  { "command": "...", "aggregated_output": "...", "exit_code": 0, "status": "completed" }
    file_change        { "changes": [{ "path": "...", "kind": "update" }] }
{ "type": "turn.completed", "usage": { "input_tokens": 0, "cached_input_tokens": 0, "output_tokens": 0 } }
{ "type": "turn.failed", "error": { "message": "..." } }
```

Codex prints this already, so its `toEvents` is `JSON.parse`. Claude Code prints whole assistant and user messages; `src/runners/claude/events.js` remembers each tool call until its result arrives and emits the pair as `item.started` and `item.completed`. The last `agent_message` of a run is the worker's report.

A runner whose events are in this vocabulary can use the shared reducer for `parseEvent`, as the Claude runner does.

## Loading a runner that is not built in

By package name: install `agent-supervisor-runner-<name>` where the supervisor can import it, and pass `runner: "<name>"`.

By file, for one under development: set `AGENT_SUPERVISOR_RUNNER_<NAME>` to its path.

Either way the module exports the object as `runner` or as its default export, and its `name` must be the name it was asked for by.

## Checking one

`checkRunner` runs the checks the built-in runners pass in CI. Give it the runner and a transcript, the lines your CLI printed for one finished run.

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkRunner } from "codex-supervisor-mcp/src/runners/contract-check.js";
import { runner } from "./index.js";

test("meets the runner contract", () => {
  const transcript = readFileSync("fixtures/run.jsonl", "utf8").trim().split("\n");
  assert.deepEqual(checkRunner(runner, { transcript }), []);
});
```

It returns the problems as strings, none when the runner is sound.

Then run a real worker: `E2E_RUNNER=<name> node test/e2e/real-flow.mjs` drives the installed package through preflight, two parallel workers, acceptance, landing, cleanup, a time budget and a killed run host.

## What a runner without an OS sandbox owes

The guard hook is all that stands between the worker and the rest of the disk. The Claude runner's guard (`src/runners/claude/tool-guard.js`) allows a file tool only inside `owned_paths`, or inside the worktree when the worker owns nothing, and allows the shell only read commands and the commands the dispatcher declared in `sandbox.allowed_commands`. A declared command is trusted as written.
