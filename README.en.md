# codex-supervisor-mcp

English | [中文](README.md)

[![npm version](https://img.shields.io/npm/v/codex-supervisor-mcp.svg)](https://www.npmjs.com/package/codex-supervisor-mcp)
[![npm downloads](https://img.shields.io/npm/dm/codex-supervisor-mcp.svg)](https://www.npmjs.com/package/codex-supervisor-mcp)
[![license](https://img.shields.io/npm/l/codex-supervisor-mcp.svg)](LICENSE)
[![CI](https://github.com/zriyox/codex-supervisor-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/zriyox/codex-supervisor-mcp/actions/workflows/ci.yml)
[![node](https://img.shields.io/badge/node-%3E%3D22.13.0-339933.svg)](package.json)

Website [codex-supervisor.zriyo.com](https://codex-supervisor.zriyo.com) · for models [llms.txt](https://codex-supervisor.zriyo.com/llms.txt)

Point several agents at one repository and they overwrite each other, nobody can say who changed what, and the main thread's context fills up with worker output.

**codex-supervisor-mcp** is a Codex MCP server that takes dispatch and bookkeeping out of the model's context and puts them on disk: one main thread (Claude Code, Codex, or any MCP client) runs several Codex CLI workers at once, one Git worktree per worker, state in SQLite, a web board on top.

![Demo: one Claude Code main thread dispatches three Codex workers into separate worktrees, waits, and merges the result](https://raw.githubusercontent.com/zriyox/codex-supervisor-mcp/main/assets/demo.gif)

*30 seconds, recorded live: `create_codex_worker` ×3, three workers in their own worktrees in parallel, the main thread collects three diffs and makes one commit.*

## What it solves

| Problem | What it does |
|---|---|
| Workers trample each other's files | One Git worktree per worker, `ownedPaths` checked for overlap before dispatch |
| Worker output floods the main thread | Events go to `data/runs/<taskId>.jsonl`; reads are gated by `limit` / `maxChars` / `kinds` |
| One status read fills the context | `get_orchestration_overview` fits every worker into 7000 bytes |
| Nobody knows who is still running after a restart | `supervisor.sqlite`, one row per work, with `thread_id` |
| A new session cannot pick up an old worker | `resume_codex_worker` runs `codex exec resume <thread_id>`: the same Codex conversation |
| "Failed" and "process gone" look alike | The state machine keeps `failed` and `lost` apart |
| No view of where a batch is | `codex-supervisor-web`, a board that shows every worker by session |

Workers run `codex exec` with `model` passed through: the main thread stays on Claude, workers can run DeepSeek or any model Codex has a provider for, and the bills stay separate.

## Five minutes to a running batch

Prerequisites: Node.js 22.13.0 or newer, `codex` on `PATH`. macOS, Linux and Windows.

### 1. Install

```bash
npm install -g codex-supervisor-mcp
```

`postinstall` installs the skill and registers the MCP. If `claude mcp list` does not show it (`npx`, pnpm and `--ignore-scripts` skip `postinstall`), add it by hand:

```bash
claude mcp add -s user codex-supervisor -- npx -y codex-supervisor-mcp
codex mcp add codex-supervisor -- npx -y codex-supervisor-mcp
```

Restart Claude Code / Codex. Updates take care of themselves from here; see "Updating". For the skill alone: `npx skills add zriyox/codex-supervisor-mcp`.

### 2. Dispatch a batch

Say it in plain words in Claude Code; the skill makes it follow the right steps:

> Fill in the unit tests for these three modules, three codex-supervisor workers in parallel, session "unit tests".

What the main thread does underneath (you can call the tools yourself):

```
create_codex_worker ×3   each with session_id, session_title, ownedPaths, goal
wait_codex_workers       two minutes by default, then a snapshot, call again until done
get_worker_result ×3     each worker's full report and changed files
```

Each worker's changes sit on its own `codex/<taskId>` branch; whether and how to merge is the main thread's call.

### 3. Open the board

```bash
codex-supervisor-web
# without a global install:
npx -p codex-supervisor-mcp codex-supervisor-web
```

Open `http://127.0.0.1:7877`. The state directory is `SUPERVISOR_HOME`, else the nearest `.mcp.json`, else `~/.codex-supervisor`; `SUPERVISOR_WEB_PORT` changes the port. The board only shows; it never dispatches or cancels.

## How I use it

Anything that speaks MCP can be the main thread; this is just my way. I run two Claude Code sessions, one for documents and one for dispatch: a session that writes the design and watches the workers fills its context in two hours.

| Who | Where | Does what |
|---|---|---|
| Me | | Decide what to build, make the calls, read the reports |
| Planning session | The requirements and docs repository | Talk through the requirement, write the design, write one brief per block of work with a paragraph for the main brain at the end |
| Main-brain session | A worktree of the code repository | Read the brief, dispatch Codex workers, check every worker's diff, write results back into the brief, report to me. Writes no business code |
| Codex workers | Their own worktrees | One worker per step, one commit per step, build and verify on a remote machine. No push, no merge |

One block of text passes between the two sessions, pasted into the main-brain session and handed over with `/goal`. Its shape is fixed:

```text
[Role]        You are the main brain: read docs and code, dispatch workers, check results, update docs, report to me. You write no business code.
              Dispatch and track with the codex-supervisor skill; load it before starting.
[Background]  Why this block exists, what the previous one left behind
[Read first]  Which sections of which documents. Which one wins when they disagree
[Repos]       Where the worktrees are, which commit each branch is on, which branches are read-only
[Do]          Follow the table in section N of the brief. One commit per step; verify a step before starting the next. Nothing outside the table
[Dispatch]    search_works first, do not dispatch twice
              One session_id for the whole batch
              Serial when steps touch the same files, parallel only when ownedPaths do not overlap
              One worker per step. Write the task in full: background, where in the docs, files to change, verify command, output format
              Read the diff when a worker returns. Its word is not enough; what you see is
[Build/test]  Everything on the remote machine, nothing locally
[Red lines]   What not to change, push or read
[Stop and ask me when]
[Report]      Tables first, these items, then stop and wait for me
```

What the main brain calls in one round:

```
search_works            has this batch been dispatched before
create_codex_worker     one worker per step, same session_id, ownedPaths disjoint
wait_codex_workers      two minutes a round, compact: true, call again until done
get_worker_result       what it says it did
get_worker_diff         what it actually did
ask_codex_worker        when the two differ, ask why; read-only, its thread untouched
resume_codex_worker     when it must change something, one follow-up, amended into the same commit
land_codex_worker       checked, then landed on the integration branch
```

The last block was 25 steps; the main-brain session ran it end to end with nothing in its context but the brief and each worker's report. One worker per step came from trying it the other way: when a step is wrong, one `resume_codex_worker` asks for `--amend` into the same commit and the main brain checks again before landing; a worker that did three steps cannot be fixed that way, since steps 6 and 7 already sit on top of a wrong step 5.

## What the board shows

| Where | What |
|---|---|
| Left column | One row per session: title, worker count, how many running, last activity. Version and update notice at the bottom |
| Session page | Counts (total / running / done / failed / lost); while workers run, the command each one is on |
| Worker table | One row per worker: status, title, current command or last report line, duration, files changed, commands run |
| Worker drawer | Seven tabs: overview, report, changes, commands, events, task, side chat |
| Side chat | Ask the worker a question, the way Codex's `/btw` works: its thread is forked into a read-only side session, the running work is untouched. Multi-turn, stoppable, and a page that leaves picks up where it was |

Light and dark follow the system. No external resources.

## Tools

Nineteen.

| Tool | Arguments | What it does |
|---|---|---|
| `create_codex_worker` | `task`, `cwd`, **`ownedPaths`**, **`goal`**, `session_id`, `session_title`, `session_note`, `dependsOn`, `baseRef`, `sandbox`, `model`, `reasoningEffort`, `title`, `skipGitRepoCheck` | Start a worker. `baseRef` picks the commit the worktree is cut from (default `HEAD`); pass another worker's `codex/<id>` to build on it |
| `create_codex_followup_worker` | `task_id`, `followup_prompt`, `session_id`, plus the above | A new session seeded with the old worker's prompt, status and recent events |
| `resume_codex_worker` | `task_id`, `prompt` | Continue the same Codex conversation; `thread_id` stays |
| `wait_codex_workers` | `task_ids`, `mode` (any/all), `timeoutMinutes`, `timeoutMs`, `compact`, `includeEvents`, `eventLimit`, `eventMaxChars`, `eventKinds` | Wait for terminal states. Two minutes by default, then a snapshot while the workers keep running; `compact` returns one line per worker |
| `get_orchestration_overview` | `status`, `limit` | Every worker in one table, capped at 7000 bytes. Carries `version` and `update` |
| `get_worker_result` | `task_id`, `limit`, `maxChars` | The worker's own full report plus `status` / `exit_code` / `changed_files` |
| `get_worker_diff` | `task_id`, `maxChars`, `paths` | What the worker actually changed: patches from the worktree's start to its working tree, committed or not. `maxChars` bounds the answer; files past it are listed without a patch |
| `ask_codex_worker` | `task_id`, `question`, `timeoutMs`, `maxChars`, `fresh`, `end` | Ask the worker on the side. Its thread is forked into a read-only session with no network and no MCP tools; the worker itself is untouched. A resumed worker gets a new fork by itself, `fresh` forces one, `end` deletes it |
| `land_codex_worker` | `task_id`, `onto`, `commitMessage` | Cherry-pick the worker's `codex/<id>` commits onto the current branch of the directory it was dispatched from. Clean target only, a conflict rolls back. `commitMessage` first commits the worker's uncommitted edits as one commit |
| `get_worker_summary` | `task_id` | One paragraph: goal, status, changes, last command and message |
| `get_codex_worker_status` | `task_id`, `includePrompt`, `promptMaxChars` | One worker in detail |
| `get_codex_worker_events` | `task_id`, `limit`, `maxChars`, `kinds` | The raw event stream |
| `get_worker_goal` | `task_id` | The goal recorded at dispatch plus the native Codex goal (tokens, time) |
| `list_codex_workers` | `status`, `includeHistory`, `includeDetails` | List workers, active ones by default |
| `get_session_works` | `session_id` | Every worker of one session. The way back after a main-thread restart |
| `describe_session` | `session_id`, `title`, `note` | Record a title and note for a session |
| `search_works` | `query`, `limit` | Substring search over title / goal / prompt / last_message, newest first |
| `check_for_update` | `force` | Ask the registry for a newer version |
| `cancel_codex_worker` | `task_id` | Stop a worker. Falls back to the pid across processes, after confirming that pid runs codex |

Two are required: `ownedPaths` (checked against every running worker before dispatch, overlap refuses the call, dispatch-time only) and `goal.objective` (the worker turns it into a native Codex goal). Without `session_id` nothing groups the batch; use one value for the whole batch.

## How this differs from Claude Code subagents

File isolation is not the difference: a subagent can open a worktree too. The difference is the model and the process.

| | Claude Code subagent | codex-supervisor worker |
|---|---|---|
| Model | Claude only | `model` passed to the Codex CLI; DeepSeek works |
| Who does the work | Claude Code itself | A separate `codex exec` process |
| Two writers on one file | Worktrees keep them apart, no path declaration | `ownedPaths` overlap is refused before dispatch |
| Main-thread process dies | Workers die with it | `thread_id` is in sqlite; `resume_codex_worker` picks the same conversation up |
| Who can drive it | Claude Code only | Any MCP client |
| Seeing the process | Only the returned conclusion | Raw JSONL and the web board |

## The state machine

| `status` | Meaning |
|---|---|
| `queued` | Dispatched, not started |
| `running` | Running. `phase`: `starting → thinking → command → editing → reporting` |
| `completed` | Done |
| `failed` | Non-zero exit, `turn.failed`, spawn failure |
| `cancelled` | Stopped by `cancel_codex_worker` |
| `lost` | Killed by an outside signal, MCP process gone, or a row whose process never started. `resume_codex_worker` picks it up |

A terminal state lands in two steps: `turn.completed` sets `completed`, the process exit writes `exit_code`; `wait_codex_workers` returns only after the exit code is in. Windows has no signals, so an outside kill reports as `failed` with an exit code. Native Codex goals: `paused` / `blocked` count as `running` and go to `needs_attention`, `usageLimited` / `budgetLimited` as `failed`.

## Where state lives

`~/.codex-supervisor/` by default:

| File | Content |
|---|---|
| `data/supervisor.sqlite` | `tasks` (one row per work), `task_events`, `sessions`, `side_sessions` / `side_turns` (side chat) |
| `data/runs/<taskId>.jsonl` | Raw `codex --json` output |
| `data/update-check.json`, `auto-update.json` | Update check and background update records |
| `worktrees/<taskId>/` | The worker's Git worktree |

`changed_files` is the worktree's real diff, so shell edits and the worker's own commits are both visible. Non-ASCII file names come back as written. Databases from older versions migrate on first open.

## Environment variables

| Variable | Default | Effect |
|---|---|---|
| `SUPERVISOR_HOME` | `~/.codex-supervisor` | State root. The MCP and the board must point at the same one |
| `CODEX_HOME` | `~/.codex` | Read-only: the native `goals_1.sqlite` and the MCP config |
| `CODEX_BIN` | `codex` | Path to the Codex CLI. The Windows `.cmd` shim is bypassed |
| `GIT_BIN` | `git` | Path to git |
| `SUPERVISOR_WEB_PORT` / `SUPERVISOR_WEB_HOST` | `7877` / `127.0.0.1` | Board address |
| `CODEX_SUPERVISOR_NO_UPDATE_CHECK` | unset | `1` disables the update check |
| `CODEX_SUPERVISOR_REGISTRY` | `https://registry.npmjs.org` | Registry for the update check and the auto-update |
| `CODEX_SUPERVISOR_UPDATE_TIMEOUT_MS` | `4000` | How long to wait for the registry |
| `CODEX_SUPERVISOR_NO_AUTO_UPDATE` | unset | `1` turns the background auto-update off (notify only) |
| `CODEX_SUPERVISOR_SKIP_SKILL_SYNC` | unset | `1` turns the skill sync at server start off |
| `CODEX_SUPERVISOR_SKIP_SETUP` | unset | `1` skips the `postinstall` setup |
| `CODEX_SUPERVISOR_NPM` | unset | npm for the auto-update; default is the one shipped with the running node |

GUI clients (Claude Desktop, Cursor, Windsurf) do not run `postinstall`: add this to their MCP config file, and since their `PATH` often lacks `codex`, give `CODEX_BIN` explicitly:

```json
{
  "mcpServers": {
    "codex-supervisor": {
      "command": "npx",
      "args": ["-y", "codex-supervisor-mcp"],
      "env": { "CODEX_BIN": "/usr/local/bin/codex" }
    }
  }
}
```

## Updating

Nothing to do by hand. At start the server asks the registry in the background; a newer version is installed by a detached `npm i -g` into the same global path, the running session is untouched and the next session starts on it. Only a copy that `npm i -g` installed is touched; a git checkout or an `npx` copy is left alone. The skill does the same: every start copies it into the existing skill directories, backing up an edited file as `SKILL.md.bak-<timestamp>`.

When the install fails (a global directory that needs sudo) the `update` field says why and `npm install -g codex-supervisor-mcp@latest` by hand still works. Versions up to 0.6.1 only notify; upgrade by hand once and it is automatic from then on. A Node version switch breaks the registered path: `claude mcp remove -s user codex-supervisor`, `codex mcp remove codex-supervisor`, reinstall. To run the setup again: `codex-supervisor-setup` (`--skill-only` / `--mcp-only` / `--dry-run`).

Uninstall:

```bash
npm uninstall -g codex-supervisor-mcp
claude mcp remove -s user codex-supervisor
codex mcp remove codex-supervisor
rm -rf ~/.claude/skills/codex-supervisor ~/.agents/skills/codex-supervisor ~/.codex/skills/codex-supervisor ~/.codex-supervisor
```

## Windows

- The npm-installed CLI is `codex.cmd`, which Node refuses to spawn directly. The runner steps over it to `node_modules/@openai/codex/bin/codex.js` and runs that with `node`; no `shell: true`, which would leave only the shell killable on cancel.
- Cross-process cancel uses `taskkill /PID <pid> /T /F` for the whole tree, after confirming that pid runs codex.
- Besides `PATH`, `%APPDATA%\npm`, `%LOCALAPPDATA%\pnpm`, `%LOCALAPPDATA%\Volta\bin` and `%ProgramFiles%\nodejs` are probed.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Not in `claude mcp list` | The install method skipped `postinstall` | `codex-supervisor-setup`, or `claude mcp add` by hand |
| Dispatch says `codex only resolved to a shell shim` | Windows found only the `.cmd`; the package entry behind it is gone | Reinstall `@openai/codex`, or point `CODEX_BIN` at `codex.js` |
| Worker `failed` at once with `spawn codex ENOENT` | No codex on the process `PATH` | Set `CODEX_BIN` in the config |
| `Cannot find module 'node:sqlite'` | Node older than 22.13.0 | Upgrade Node |
| Worker `lost` | The MCP process was killed and took the worker with it | `resume_codex_worker` |
| Worker reports `git add` failing with `index.lock: Operation not permitted` | The default sandbox keeps `.git` read-only | `land_codex_worker` with `commitMessage`, or dispatch with `danger-full-access` |
| `ownedPaths overlap with active worker(s)` | Two workers claimed the same paths | Split differently, or cancel the one holding them |
| The board is empty | The board and the MCP use different `SUPERVISOR_HOME`s | Start it inside the project with the `.mcp.json`, or pass the same `SUPERVISOR_HOME` |
| `port 7877 ... is already in use` | A board is already running | Open it, or start another with `SUPERVISOR_WEB_PORT=8080` |

## Known limitations

- A worker is a child of the MCP process. Kill the MCP and the worker goes with it, settled as `lost`; its worktree and `thread_id` survive and `resume_codex_worker` picks it up. Keeping it alive across that takes a resident daemon; see the Roadmap.
- In the default `workspace-write` sandbox a worker cannot commit (Codex keeps `.git` read-only). Either `land_codex_worker` with `commitMessage` commits for it, or dispatch with `danger-full-access`.
- The worktree is cut from a commit; uncommitted work in your checkout is not in it.
- Only the working directory is isolated. Temp directories, databases and ports are shared.
- `ownedPaths` is checked at dispatch only; it does not stop a worker from creating files outside its list. Read the diff.
- It knows "finished", not "correct". Acceptance is the main thread's job.
- One `wait_codex_workers` cannot wait to the end; the client's MCP tool timeout is a hard wall. Call it again.
- `search_works` is substring matching, fine for hundreds of works.

## Roadmap

Done: `CODEX_BIN` / `SUPERVISOR_HOME` / `GIT_BIN`; `status` and `phase` split; `ownedPaths` / `goal` / `dependsOn`; `thread_id` on disk + `resume_codex_worker`; concurrency and multi-process writes; `session_id`, `search_works`, native goals; Windows; the web board; `baseRef`; collecting work with `get_worker_diff` / `ask_codex_worker` / `land_codex_worker`; background auto-update.

Next: a resident daemon, moving dispatch and process lifetime out of the MCP process.

Not planned: vector search (substring matching is faster at this scale and costs nothing to maintain), `usage_count` ordering (2 of 80 real works were ever referenced again).

## Development

```bash
npm install
npm test               # fake-codex replay, fast and deterministic
npm run test:edge      # test/edge only
npm run test:real      # end to end against the real codex CLI
npm run web:dev        # board development, /api proxied to 7877
npm run web:build      # bundle to web/dist, runs before npm publish
```

CI runs Ubuntu / macOS / Windows, plus a Node 22.13.0 job that pins the `engines` floor.

## Contributing

See [CONTRIBUTING.en.md](CONTRIBUTING.en.md). Security issues go through the [private advisory form](https://github.com/zriyox/codex-supervisor-mcp/security/advisories/new); see [SECURITY.md](SECURITY.md).

## License

MIT
