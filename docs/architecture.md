# Architecture

The source is five layers plus the run host. A layer may import the layers below it and never the ones above. ESLint enforces every rule on this page, so a violation fails `npm run lint` and CI.

```
src/interface/   entry points: the MCP tools, the CLIs, the board's HTTP API
src/run-host/    the detached process that owns one run
src/app/         use cases: dispatch, resume, land, cleanup, acceptance, side chat
src/runners/     one directory per CLI; the only code that knows a CLI's flags and events
src/infra/       the outside world: the store, git, processes, the filesystem, updates
src/domain/      rules with no IO: statuses, ownership, reports, prompts, truncation
```

## Who may import whom

| Layer | May import | May not import |
|---|---|---|
| `interface` | app, runners, infra, domain | run-host |
| `run-host` | app, runners, infra, domain | interface |
| `app` | runners, infra, domain | interface, run-host |
| `runners` | infra, domain | interface, run-host, app |
| `infra` | domain | everything above |
| `domain` | nothing in the project | everything, and no `node:fs`, `node:sqlite`, `node:http`, `node:net` |

Two more rules sit on top of the table:

- `node:child_process` is imported in exactly two files, `infra/git.js` and `infra/process.js`. Everything else asks them for a process.
- In `src/`, a file is at most 400 lines, a function at most 80, a line at most 160 characters (string literals excepted), and an empty `catch` carries a comment saying why the error can be ignored.

## What each layer holds

**interface.** `mcp/server.js` creates the server and registers the tools in a fixed order; that order is what `tools/list` returns. Each tool lives in `mcp/tools/` as `[name, config, handler]`. A handler validates input, calls a use case and shapes the reply; `mcp/views/` builds the reply rows. `bin/` holds the CLIs, `web/` the board's read-only API. `src/mcp-server.js` is a four-line entry kept at that path because client registrations store it as an absolute path.

**run-host.** `entry.js` is started detached by `app/start-run.js`, one process per run. It spawns the worker, stores its events, decides the terminal status, runs acceptance and writes the final row, and it keeps going after the MCP server that started it exits. `track.js` wires it together; `launch.js`, `live-run.js`, `streams.js` and `finalize.js` are the four stages.

**app.** One module per use case. `dispatch.js` creates a worker, `resume.js` continues one, `followup.js` starts a successor, `landing.js` and `land-chain.js` bring commits onto the integration branch, `rebase.js` moves a worktree to a newer base, `cleanup-plan.js` decides which worktrees may go, `acceptance.js` runs the dispatcher's checks, `side-chat.js` answers questions on a fork of the worker's thread. `compose.js` is the composition root: it registers the runner with the layers that may not import it, and every entry point imports it first.

**runners.** `runners/codex/` is the Codex CLI: `adapter.js` (arguments, spawning, cancelling), `event-parser.js` (its JSON events to row changes), `goal-store.js` (its native goal database), `tool-guard.js` (the PreToolUse hook installed in each worker), `chat-chunks.js` and `mcp-config.js`.

**infra.** `store/` is SQLite: `schema.js`, `db.js` (connection and migrations), then one module per record: `tasks`, `events`, `sessions`, `facts`, `records` (artifacts, reviews, cleanup plans) and `reconcile`. `git.js` is the single git runner. `process.js` is the single door to child processes. `worktree.js` reads what a worker changed.

**domain.** Functions from plain values to plain values: the status machine, ownership overlap, the worker report schema, the acceptance contract, prompt framing, overview deltas, truncation. They can be tested without a temp directory.

## One dispatch, start to finish

1. `interface/mcp/tools/dispatch.js` receives `create_codex_worker` and calls `createCodexWorker`.
2. `app/dispatch.js` validates the input, claims a workspace (`infra/workspace-kind.js`), checks path ownership (`app/ownership.js`), reads the session policy (`infra/store/sessions.js`), cuts the worktree (`app/worktree-setup.js` through `infra/git.js`), builds the guard and runtime contract (`domain/worker-preflight.js`) and reserves the paths with the task row in one transaction (`infra/store/tasks.js`).
3. `app/start-run.js` compiles the worker's context (`app/context-compiler.js`) and starts `run-host/entry.js` detached. The IPC channel carries only the startup handshake.
4. `run-host/track.js` asks the runner how to launch (`run-host/launch.js`, `runners/codex/adapter.js`), spawns the worker, and writes the running row.
5. `run-host/streams.js` turns each stdout line into a stored event (`infra/store/events.js`) and a row change (`runners/codex/event-parser.js`).
6. When the worker closes, `run-host/finalize.js` picks the terminal status, records what changed (`infra/worktree.js`), runs acceptance (`app/acceptance.js`) and writes the final row and facts.
7. The main thread reads it back through `get_worker_result` and `get_worker_diff`, then `land_codex_worker` calls `app/land-chain.js` and `app/landing.js`.

## Tests

| Layer | How it is tested |
|---|---|
| domain | direct calls, no fixtures |
| app, interface, run-host | `test/edge/*.test.js` drive the real MCP server with `test/fixtures/fake-codex.js` standing in for the CLI and a temp `SUPERVISOR_HOME` |
| the installed package | `test/e2e/real-flow.mjs` against a real CLI; not part of `npm test` |
