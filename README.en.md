# agent-supervisor-mcp

English | [中文](README.md)

[![npm version](https://img.shields.io/npm/v/agent-supervisor-mcp.svg)](https://www.npmjs.com/package/agent-supervisor-mcp)
[![npm downloads](https://img.shields.io/npm/dm/agent-supervisor-mcp.svg)](https://www.npmjs.com/package/agent-supervisor-mcp)
[![license](https://img.shields.io/npm/l/agent-supervisor-mcp.svg)](LICENSE)
[![CI](https://github.com/zriyox/agent-supervisor-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/zriyox/agent-supervisor-mcp/actions/workflows/ci.yml)
[![node](https://img.shields.io/badge/node-%3E%3D22.13.0-339933.svg)](package.json)
[![agent-supervisor-mcp on Glama](https://glama.ai/mcp/servers/zriyox/agent-supervisor-mcp/badges/score.svg)](https://glama.ai/mcp/servers/zriyox/agent-supervisor-mcp)

Website [agent-supervisor.zriyo.com](https://agent-supervisor.zriyo.com) · for models [llms.txt](https://agent-supervisor.zriyo.com/llms.txt) · [reference](docs/reference.en.md)

Point several agents at one repository and they overwrite each other, nobody can say who changed what, and the main thread's context fills up with worker output.

agent-supervisor-mcp is an MCP server. A main thread (Claude Code, Codex, or any MCP client) uses it to run several Codex CLI workers at once: one Git worktree per worker, state in SQLite, and a web board to watch them. Dispatch and bookkeeping live on disk, not in the model's context.

![Demo: one Claude Code main thread dispatches three Codex workers into separate worktrees, waits, and merges the result](https://raw.githubusercontent.com/zriyox/agent-supervisor-mcp/main/assets/demo.gif)

*30 seconds, recorded live: three workers in their own worktrees in parallel, then the main thread collects three diffs and makes one commit.*

> **This package used to be codex-supervisor-mcp.** It was renamed because a worker is no longer only Codex. A machine with the old package is brought over by its last release: this package is installed, the MCP registration and the skill become `agent-supervisor`, and the state directory stays where it is. The command line tools change prefix from `codex-supervisor-` to `agent-supervisor-`.
>
> **Upgrading from 0.x to 1.x**: 39 tools became 14, with new names and arguments and no aliases for the old ones. Finish the workers in flight first, then reopen the session after upgrading so the new skill loads. The tool table is in the [reference](docs/reference.en.md); what changed is in the [1.0.0 release](https://github.com/zriyox/agent-supervisor-mcp/releases/tag/v1.0.0).

## What it solves

| Problem | What it does |
|---|---|
| Workers step on each other's files | One worktree per worker; `owned_paths` is checked for conflicts before dispatch |
| Worker output floods the main thread | Events go to JSONL; the main thread reads a compressed overview (every worker in under 7000 bytes) |
| A restart or a new session loses the workers | One SQLite row per work, with its `thread_id`; `resume_worker` rejoins the same Codex session |
| A failed run looks the same as a dead process | The state machine keeps `failed` and `lost` apart, and a failure carries its source and code |
| A worker says it is done and is not | Dispatch with `acceptance` commands; the supervisor runs them itself after the worker exits and refuses to land on failure |
| Changes sit on a local branch | `land_worker` merges into the integration branch; `verify_push` proves the commit is on the remote |
| Worktrees pile up | Landed or unchanged ones are removed during polling. Unlanded work is kept for 7 days, and its uncommitted edits are committed to its branch before the worktree goes. Branches and evidence stay |

A worker is a `codex exec` process by default and `model` is passed straight through. Keep the main thread on Claude, put the workers on DeepSeek or another provider, and the bills stay separate.

A worker can also be Claude Code: pass `runner: "claude"` to `create_worker`. It has no OS sandbox, so it runs only in a git worktree or read-only, and it has no side chat (`ask_worker`); dispatch, acceptance, resume, landing and cleanup are the same. To add another CLI, see [docs/runner.md](docs/runner.md).

## Five minutes to a running batch

You need Node.js 22.13.0 or newer and the `codex` CLI on `PATH`. macOS, Linux and Windows all work.

```bash
npm install -g agent-supervisor-mcp
```

The install script puts the skill into every Claude Code and Codex it finds and registers the MCP server. Restart them afterwards. If nothing got registered (`--ignore-scripts`, for instance), run `agent-supervisor-setup`, or add it by hand:

```bash
claude mcp add -s user agent-supervisor -- npx -y agent-supervisor-mcp
codex mcp add agent-supervisor -- npx -y agent-supervisor-mcp
```

GUI clients such as Claude Desktop, Cursor and Windsurf need their MCP config edited by hand; the snippet is in the [reference](docs/reference.en.md#environment-variables). For the skill without the server: `npx skills add zriyox/agent-supervisor-mcp`.

Then say it in plain words in Claude Code:

> Fill in the unit tests for these three modules. Use agent-supervisor, three workers in parallel, call the session "unit tests".

The skill walks the main thread through this:

```
preflight_worker     run a probe in the same environment first
create_worker ×3     each with session, owned_paths, goal
wait_workers         60 seconds at most per call; call again until done
get_worker ×3        each worker's report, with the commands it ran and their exit codes
get_worker_diff ×3   what it actually changed
land_worker ×3       reviewed; commit on its behalf and land
```

Workers never commit. Their changes stay on `worker/<taskId>` until the main thread has read the diff.

To watch them work, open the board:

```bash
agent-supervisor-web     # or: npx -p agent-supervisor-mcp agent-supervisor-web
```

Open `http://127.0.0.1:7877`. It shows each session's workers: status, the command running right now, changes and events. You can also ask a worker a question on the side; the answer comes from a read-only fork of its thread, so the work in progress is not interrupted. The board is read-only. It does not dispatch or cancel.

## How I use it

Anything that speaks MCP can be the main thread; this is just my way. I run two Claude Code sessions, one for documents and one for dispatch. A single session that writes the design and also watches the workers fills its context in two hours.

| Who | Where | Does what |
|---|---|---|
| Me | | Decide what to build, make the calls, read the reports |
| Planning session | The requirements and docs repository | Talk through the requirement, write the design, write one brief per block of work |
| Main-brain session | A worktree of the code repository | Read the brief, dispatch workers, check diffs, report to me. Writes no business code |
| Codex workers | Their own worktrees | One worker per independently verifiable feature package. No commit, no push |

One block of text passes between the two sessions, pasted into the main-brain session and handed over with `/goal`:

```text
[Role]        You are the main brain: dispatch workers, check results, update docs, report to me.
              You write no business code. Load the agent-supervisor skill first.
[Background]  Why this block exists, what the previous one left behind
[Read first]  Which sections of which documents, and which one wins when they disagree
[Do]          Follow the table in section N of the brief. Nothing outside the table
[Dispatch]    find_works first so nothing is dispatched twice; one session.id for the batch;
              parallel only when write sets are disjoint; the verify command goes in acceptance too;
              a worker's word is not enough, the diff you read is
[Red lines]   What not to change, push or read
[Report]      Tables first, then stop and wait for me
```

## Tools

Fourteen by default. Arguments and edge cases are in the [reference](docs/reference.en.md#tools).

| Stage | Tool | What it does |
|---|---|---|
| Before dispatch | `preflight_worker` | Starts a short probe in the target worker's environment, or runs the acceptance commands for real first |
| Dispatch | `create_worker` | Dispatches one worker. With `followup_of` it builds on another worker's work |
| | `resume_worker` | Continues the same session, optionally rebased onto the new head first |
| | `cancel_worker` | Stops a worker |
| Tracking | `poll_workers` | Without a cursor, the whole table; with one, only what changed since, and it recovers a dead first run and removes worktrees that are safe to remove |
| | `wait_workers` | Waits for a result, 60 seconds at most per call |
| Collecting | `get_worker` | Reads one worker: summary, report, status, events, goal, whichever parts you ask for |
| | `get_worker_diff` | The actual changes, paged by file and hunk |
| | `ask_worker` | Asks the worker a side question. Read-only; its thread is untouched |
| Delivery | `land_worker` | Commits on the worker's behalf and cherry-picks onto the integration branch; refuses if acceptance failed |
| | `verify_push` | Proves the landed commit is on the remote. It verifies; it never pushes for you |
| | `cleanup` | Shows why a worktree is still there, or removes it now. Normally cleanup is automatic |
| Batches | `find_works` | Finds a batch again, or searches history by substring |
| | `describe_session` | Records a batch's title, objective, default acceptance and approval state |

Three more are registered only with `AGENT_SUPERVISOR_TOOLS=all`: `facts` (the ledger of verified facts), `review` (an independent read-only verifier) and `get_artifact` (stored evidence). A normal batch never needs them, and leaving them out saves context in every session.

## How this differs from Claude Code subagents

A subagent can open its own worktree too, so file isolation is not the difference. The model and the process are.

| | Claude Code subagent | agent-supervisor worker |
|---|---|---|
| Which models | Claude only | Anything the Codex CLI has a provider for |
| Who does the work | Claude Code itself | A separate `codex exec` process |
| Two workers writing one file | No path declaration | `owned_paths` overlap is checked before dispatch and rejected |
| The main thread dies | The work cannot be collected | Workers and acceptance run to the end; a new window finds them again with `find_works` |
| Who can drive it | Claude Code only | Any MCP client |
| Seeing the process | Only the conclusion it returns | Raw JSONL and the web board |

## Configuration and state

Everything lives under `~/.agent-supervisor` (a machine upgraded from codex-supervisor-mcp that already has `~/.codex-supervisor` keeps using it): `data/supervisor.sqlite` is the ledger, `data/runs/<taskId>.jsonl` is Codex's raw output, and `worktrees/<taskId>/` holds each worker's checkout.

| Variable | Default | What it does |
|---|---|---|
| `SUPERVISOR_HOME` | `~/.agent-supervisor` | State root. The MCP server and the board must point at the same one |
| `CODEX_BIN` | `codex` | Path to the Codex CLI. GUI clients often lack it on `PATH` |
| `SUPERVISOR_WEB_PORT` | `7877` | Board port |
| `AGENT_SUPERVISOR_NO_AUTO_UPDATE` | unset | `1` turns off background updates and only notifies |

The remaining variables, the six worker states and the cache directories the sandbox opens by default are in the [reference](docs/reference.en.md).

Updates take care of themselves. At start the server asks the registry in the background and, if there is a newer version, a detached process runs `npm i -g`. The running session is untouched and the next one starts on the new version. This only applies to a global install.

Uninstall:

```bash
npm uninstall -g agent-supervisor-mcp
claude mcp remove -s user agent-supervisor
codex mcp remove agent-supervisor
rm -rf ~/.claude/skills/agent-supervisor ~/.agents/skills/agent-supervisor ~/.codex/skills/agent-supervisor ~/.agent-supervisor
```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Missing from `claude mcp list` | The install did not run `postinstall` | `agent-supervisor-setup` |
| Worker `failed` at once, `spawn codex ENOENT` | No codex on the process `PATH` | Set `CODEX_BIN` |
| `codex only resolved to a shell shim` | Windows found only the `.cmd`; the package entry is gone | Reinstall `@openai/codex`, or point `CODEX_BIN` at `codex.js` |
| `Cannot find module 'node:sqlite'` | Node older than 22.13.0 | Upgrade Node |
| Worker is `lost` | The worker or its run process was killed | Read the events, then `resume_worker` |
| Worker is `timed_out` | Its time budget ran out and it was stopped | Read what it left; `resume_worker` after a per-run limit, `followup_of` with new `limits` after the total one |
| `git add` fails with `index.lock: Operation not permitted` | The sandbox makes `.git` read-only. That is the intended boundary | Let `land_worker` commit with `commit_message` |
| `owned_paths overlap with active worker(s)` | Two workers claimed the same paths | Split the work differently, or cancel the one holding them |
| The board is empty | The board and the MCP server use different `SUPERVISOR_HOME` | Point both at the same directory |
| `port 7877 ... is already in use` | A board is already running | Open that one, or change `SUPERVISOR_WEB_PORT` |

## Known limitations

- A worktree is cut from a commit. Uncommitted changes in your checkout are not in it.
- Only the working directory is isolated. Temp directories, databases and ports are shared.
- The guard blocks direct file writes, but it is not a filesystem sandbox. A script you allowed can have side effects outside its declared paths; the diff check before landing is what catches them.
- Acceptance checks what you wrote in `acceptance` and nothing else. The rest is the main thread reading the diff.
- The client's MCP tool timeout is a hard wall, so one `wait_workers` call cannot wait to the end. Call it again.
- `find_works` is substring matching, which is enough for a few hundred works. Vector search is not planned.

## Development

```bash
npm install
npm test               # fake-codex replay, under a minute
npm run test:real      # real codex CLI end to end; needs a logged-in codex
npm run web:dev        # board development, /api proxied to 7877
```

CI runs on Ubuntu, macOS and Windows, plus a Node 22.13.0 job that pins the lower bound of `engines`.

To contribute, read [CONTRIBUTING.en.md](CONTRIBUTING.en.md). Security reports go through the [private channel](https://github.com/zriyox/agent-supervisor-mcp/security/advisories/new); see [SECURITY.md](SECURITY.md).

## License

MIT
