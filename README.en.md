# codex-supervisor-mcp

English | [中文](README.md)

[![npm version](https://img.shields.io/npm/v/codex-supervisor-mcp.svg)](https://www.npmjs.com/package/codex-supervisor-mcp)
[![npm downloads](https://img.shields.io/npm/dm/codex-supervisor-mcp.svg)](https://www.npmjs.com/package/codex-supervisor-mcp)
[![license](https://img.shields.io/npm/l/codex-supervisor-mcp.svg)](LICENSE)
[![CI](https://github.com/zriyox/codex-supervisor-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/zriyox/codex-supervisor-mcp/actions/workflows/ci.yml)
[![node](https://img.shields.io/badge/node-%3E%3D22.13.0-339933.svg)](package.json)

Let one main thread (Claude Code, Codex, or any MCP client) run several Codex workers at once. One Git worktree per worker, every state change on disk, and a web board to watch the batch.

![Demo: one Claude Code main thread dispatches three Codex workers into separate worktrees, waits, and merges the result](https://raw.githubusercontent.com/zriyox/codex-supervisor-mcp/main/assets/demo.gif)

*30 seconds, recorded live: the main thread calls `create_codex_worker` three times, the workers run in parallel in their own worktrees, the main thread collects three diffs and makes one commit.*

## What it is

Point several agents at one repository and they overwrite each other, and nobody can say afterwards who changed what. This MCP takes dispatching and bookkeeping out of the model's context and puts them on disk:

| Problem | What happens here |
|---|---|
| Workers step on each other's files | One Git worktree per worker; `ownedPaths` is checked for overlap before anything starts |
| A worker's output floods the main thread | Events go to `data/runs/<taskId>.jsonl`; reads have `limit` / `maxChars` / `kinds` gates |
| One status read fills the context | `get_orchestration_overview` fits every worker into 7000 bytes |
| Nobody knows who is still running after a restart | `supervisor.sqlite` has one row per work, with the `thread_id` |
| A new session cannot pick up an old worker | `resume_codex_worker` runs `codex exec resume <thread_id>`, the same Codex conversation |
| "It failed" and "the process vanished" look alike | The state machine keeps `failed` and `lost` apart |
| You cannot see where a batch is | `codex-supervisor-web` opens a board, one session at a time, one line per worker |

Workers are `codex exec` processes and `model` is passed straight through. The main thread stays on Claude for judgement; the workers can run DeepSeek or whatever Codex has a provider for, on a separate bill.

## Five minutes to a running batch

Requirements: Node.js 22.13.0 or newer, and the `codex` CLI on `PATH`. macOS, Linux and Windows.

### 1. Install

```bash
npm install -g codex-supervisor-mcp
```

A global install's `postinstall` does two things: it copies the bundled skill into `~/.claude/skills/`, `~/.agents/skills/` and `~/.codex/skills/`, and it registers the MCP with `claude mcp add -s user` and `codex mcp add`. Check:

```bash
claude mcp list | grep codex-supervisor
codex mcp list  | grep codex-supervisor
```

If it is missing (`npx`, `--ignore-scripts` and pnpm installs skip `postinstall`), add it by hand:

```bash
claude mcp add -s user codex-supervisor -- npx -y codex-supervisor-mcp
codex mcp add codex-supervisor -- npx -y codex-supervisor-mcp
```

Restart Claude Code / Codex so the MCP process is the new one.

### 2. Dispatch a batch

In Claude Code, say it in plain words; the skill makes it follow the right sequence:

> Fill in the unit tests for these three modules. Use codex-supervisor, three workers in parallel, session title "unit tests".

What the main thread does underneath (you can call the tools yourself):

```
create_codex_worker ×3   each with session_id, session_title, ownedPaths, goal
wait_codex_workers       two-minute budget by default; returns a snapshot, call again if still running
get_worker_result ×3     the full report and change list per worker
```

Each worker's changes sit on its own `codex/<taskId>` branch. Whether and how to merge is the main thread's call.

### 3. Open the board

```bash
codex-supervisor-web
# without a global install:
npx -p codex-supervisor-mcp codex-supervisor-web
```

Open `http://127.0.0.1:7877`. The left column lists sessions with the title given at dispatch and how many workers are still running; a session opens into its worker ledger; a worker opens a drawer with its full report, change list, commands, event stream, task text and token usage. It refreshes every 2.5 seconds while something runs, every 8 seconds otherwise.

Which store it opens: `SUPERVISOR_HOME` from the environment if set; otherwise the nearest `.mcp.json` above the current directory, if its `codex-supervisor` entry sets `SUPERVISOR_HOME`; otherwise the default `~/.codex-supervisor`. The startup line says which one and where it came from, so running it inside the project directory is enough.

`SUPERVISOR_WEB_PORT` changes the port. A taken port (usually a board that is already running) is reported in one line and the process exits. The board reads. It does not dispatch or cancel.

## What the board shows

| Where | What |
|---|---|
| Left column | One line per session: title (the `session_title` from dispatch, or a line built from the workers' goals when none was given), worker count, how many are running, last activity. The current version and any update notice sit at the bottom |
| Session page | Title, note, first dispatch and last activity; a count line (total / running / completed / failed / lost); while workers run, the command each one is executing; when idle, the last report |
| Worker ledger | One row per worker: status, title, the running command or the last line reported, time taken, files changed (the worktree's real diff, committed work included), commands run, last update. Hovering the title shows the full goal, the owned paths and the branch |
| Worker drawer | Duration / exit code / run count; model, tokens, sandbox, thread, session; branch, base commit, worktree path; Codex startup notices folded away; five tabs: report (rendered markdown), changes, commands, events (virtualized), task text |

Light and dark follow the system. System fonts only, nothing fetched from the network.

## Tools

Sixteen.

| Tool | Arguments | What it does |
|---|---|---|
| `create_codex_worker` | `task`, `cwd`, **`ownedPaths`**, **`goal`**, `session_id`, `session_title`, `session_note`, `dependsOn`, `baseRef`, `sandbox`, `model`, `reasoningEffort`, `title`, `skipGitRepoCheck` | Start a worker. `session_title` / `session_note` say what the batch is for; `baseRef` picks the commit the worktree is cut from (default: the repository's `HEAD`), pass another worker's `codex/<id>` branch to build on work not yet on the main line |
| `create_codex_followup_worker` | `task_id`, `followup_prompt`, `session_id`, plus the above | A new session seeded with the old worker's prompt, status and recent events |
| `resume_codex_worker` | `task_id`, `prompt` | Continue the same Codex conversation; `thread_id` stays |
| `wait_codex_workers` | `task_ids`, `mode` (any/all), `timeoutMinutes`, `timeoutMs`, `includeEvents`, `eventLimit`, `eventMaxChars`, `eventKinds` | Wait for terminal states. Two minutes by default, then a snapshot; `still_running: true` means call again with the same ids. Events off by default |
| `get_orchestration_overview` | `status`, `limit` | Every worker in one table, capped at 7000 bytes. Carries `version` and `update` |
| `get_worker_result` | `task_id`, `limit`, `maxChars` | The worker's own full report plus `status` / `exit_code` / `changed_files`. The door for conclusions |
| `get_worker_summary` | `task_id` | One paragraph: goal, status, changes, last command and message |
| `get_codex_worker_status` | `task_id`, `includePrompt`, `promptMaxChars` | One worker in detail; the prompt is clipped to 300 characters unless asked for |
| `get_codex_worker_events` | `task_id`, `limit`, `maxChars`, `kinds` | The raw event stream |
| `get_worker_goal` | `task_id` | The goal recorded at dispatch plus the native Codex goal (tokens, time) |
| `list_codex_workers` | `status`, `includeHistory`, `includeDetails` | List workers, active ones by default |
| `get_session_works` | `session_id` | Every worker of one session, with its title and note. The way back after a main-thread restart |
| `describe_session` | `session_id`, `title`, `note` | Record a title and note; fields left out keep their value |
| `search_works` | `query`, `limit` | Substring search over title / goal / prompt / last_message, newest first |
| `check_for_update` | `force` | Ask the registry for a newer version and whether the installed files match the published tarball |
| `cancel_codex_worker` | `task_id` | Stop a worker. Falls back to the pid when the handle is in another process, after confirming that pid runs codex |

### The three things to always pass

- `ownedPaths`: the paths this worker may write. Checked against every running worker before dispatch; an overlap refuses the call with the conflicting `task_id` and no worktree is created. It is a dispatch-time check, not a runtime sandbox.
- `goal.objective`: one line on what the worker is for. The worker creates a native Codex goal from it and marks it complete when done.
- `session_id`: not required by the schema, but without it nothing groups the batch and neither the board nor `get_session_works` can find it again. Same value for the whole batch, and `session_title` on the first dispatch.

### Reading results without filling the context

| Want | Use | Cost |
|---|---|---|
| Status of every worker | `get_orchestration_overview` | 7000 bytes, hard cap |
| One worker's conclusion | `get_worker_result` | The full report, tens of thousands of characters for a big job |
| Alive or finished | `get_worker_summary` | A paragraph |
| What it did | `get_codex_worker_events` | Filter with `kinds`, bound with `limit`, clip with `maxChars` |

The dispatch receipt is small and does not echo the task text. `wait_codex_workers` clips `last_message` to 400 characters and `current_action` to 300; the full text is behind `get_worker_result` and `get_codex_worker_events`. That clipping is what takes a five-worker wait from tens of KB to a few KB, which matters when a client backgrounds a timed-out call and replays the result as a notification.

## How this differs from Claude Code subagents

File isolation is not the difference: subagents can open their own worktree (`isolation: worktree`). The difference is the model and the process.

| | Claude Code subagent | codex-supervisor worker |
|---|---|---|
| Models | Claude only | `model` goes to the Codex CLI; DeepSeek works |
| Who does the work | Claude Code itself | A separate `codex exec` process |
| Two workers, one file | Separate worktrees, no path declaration | `ownedPaths` intersection before dispatch; overlap is refused |
| Main thread dies | Workers die with it | `thread_id` is in SQLite; `resume_codex_worker` picks the conversation back up |
| Who can drive it | Claude Code only | Any MCP client |
| Watching the work | Only the returned conclusion | Raw JSONL and the web board |

## The state machine

`status` is the lifecycle, one value per work:

| Value | Meaning |
|---|---|
| `queued` | Dispatched, not started |
| `running` | Running |
| `completed` | Finished with exit code 0 |
| `failed` | Non-zero exit, `turn.failed`, or spawn failure |
| `cancelled` | Stopped by `cancel_codex_worker` |
| `lost` | Killed by an outside signal, the MCP process vanished, or the row was written and no process ever started |

`phase` has a value only while `running`: `starting → thinking → command → editing → reporting`.

`failed` sends you to the logs; `lost` means run it again. A terminal state lands in two steps: `turn.completed` sets `completed`, the process exit writes `exit_code`. `wait_codex_workers` waits for the second step; a direct status read that sees `completed` with `exit_code: null` is in the gap, read again.

Windows has no signals. An outside kill and the process calling `exit(1)` look the same to the parent, so there it reports `failed` with the exit code.

Native Codex goal states map like this: `active` / `paused` / `blocked` are `running` (the last two land in `needs_attention`), `usageLimited` / `budgetLimited` are `failed`, `complete` is `completed`.

## Where state lives

`~/.codex-supervisor/` by default:

| File | Content |
|---|---|
| `data/supervisor.sqlite` | `tasks` (one row per work), `task_events` (structured events), `sessions` (titles and notes) |
| `data/runs/<taskId>.jsonl` | The raw `codex --json` output |
| `data/update-check.json` | Cache for the update check |
| `worktrees/<taskId>/` | That worker's Git worktree |

`changed_files` has three sources: Codex's `file_change` events; `git status --porcelain` in the worktree (uncommitted); `git diff --name-only <base_commit> HEAD` (committed). The last two exist because a worker editing through the shell emits no `file_change` event, and once it commits `git status` is clean again. A real batch of five did exactly that and every read came back empty. `base_commit` is recorded at dispatch; older rows fall back to the oldest reflog entry of the branch. Every git read passes `core.quotePath=false`, so non-ASCII file names come back as written instead of octal-escaped.

A 0.1.x database migrates itself the first time it is opened, without losing a row.

## Update check

When the MCP process starts it asks the npm registry which version is `latest` and what that tarball's integrity is, then compares two things with the install:

- The version. If it is behind, `get_orchestration_overview`, the dispatch receipt and the `wait_codex_workers` response gain an `update` field with `latest_version` and `npm i -g codex-supervisor-mcp@latest`. The skill tells the main thread to pass that on.
- The files. A global install records the unpacked tarball's integrity in `node_modules/.package-lock.json`; if it differs from the registry's value for that version, the files on disk are not the published build and the notice says to reinstall. A git checkout has no such value and reports its commit.

Cached an hour, re-checked every six while running. An unreachable registry is not an error; the result says `source: "offline"`. The board shows the same result in the lower left. `CODEX_SUPERVISOR_NO_UPDATE_CHECK=1` turns it off, `CODEX_SUPERVISOR_REGISTRY` points at a private registry.

## Environment variables

| Variable | Default | Effect |
|---|---|---|
| `SUPERVISOR_HOME` | `~/.codex-supervisor` | State root. The MCP and the board must use the same one |
| `CODEX_HOME` | `~/.codex` | Read-only, for Codex's native `goals_1.sqlite` |
| `CODEX_BIN` | `codex` | Path to the Codex CLI. The Windows `.cmd` shim is bypassed; a `.js` target is started with `node` |
| `GIT_BIN` | `git` | Path to git |
| `SUPERVISOR_WEB_PORT` / `SUPERVISOR_WEB_HOST` | `7877` / `127.0.0.1` | Where the board listens |
| `CODEX_SUPERVISOR_NO_UPDATE_CHECK` | unset | `1` disables the update check |
| `CODEX_SUPERVISOR_REGISTRY` | `https://registry.npmjs.org` | Registry for the update check |
| `CODEX_SUPERVISOR_UPDATE_TIMEOUT_MS` | `4000` | How long to wait for the registry |
| `CODEX_SUPERVISOR_SKIP_SETUP` | unset | `1` skips the `postinstall` setup |

A process started by a GUI client often has no `codex` on `PATH`; set `CODEX_BIN` in the config:

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

## Install details

### GUI clients

GUI clients do not run `postinstall`; add the JSON above to the config file:

| Client | macOS | Windows | Linux |
|---|---|---|---|
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` | `%APPDATA%\Claude\claude_desktop_config.json` | `~/.config/Claude/claude_desktop_config.json` |
| Cursor | `~/.cursor/mcp.json` | `%APPDATA%\Cursor\mcp.json` | `~/.config/cursor/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `%APPDATA%\Codeium\windsurf\mcp_config.json` | `~/.config/.codeium/windsurf/mcp_config.json` |

### Running the setup again

```bash
codex-supervisor-setup                      # detect clients, install the skill, register the MCP
codex-supervisor-setup --target claude,codex
codex-supervisor-setup --skill-only
codex-supervisor-setup --mcp-only
codex-supervisor-setup --dry-run            # print the plan only
```

An existing skill with different content is backed up to `SKILL.md.bak-<timestamp>` before it is overwritten.

### Upgrading

```bash
npm install -g codex-supervisor-mcp@latest
npm ls -g --depth=0 | grep codex-supervisor
```

Then restart Claude Code / Codex. Three things to know:

- The registry takes a few minutes to move `latest` after a publish. If the version did not change, wait, or pin the version.
- `npm link` installs a symlink: `src/` changes apply at once, the skill does not sync by itself; run `codex-supervisor-setup`.
- Switching Node versions breaks the registered absolute path. Run `claude mcp remove -s user codex-supervisor` and `codex mcp remove codex-supervisor` first, then install.

### Uninstall

```bash
npm uninstall -g codex-supervisor-mcp
claude mcp remove -s user codex-supervisor
codex mcp remove codex-supervisor
rm -rf ~/.claude/skills/codex-supervisor ~/.agents/skills/codex-supervisor ~/.codex/skills/codex-supervisor
rm -rf ~/.codex-supervisor
```

### Windows

- The npm-installed CLI is `codex.cmd`, and Node refuses to spawn it directly since 18.20 / 20.12 (the behaviour after CVE-2024-27980). `shell: true` is not used, because cancelling would then only kill the shell. Instead the package's own entry, `node_modules/@openai/codex/bin/codex.js`, is started with `node`.
- Cross-process cancel runs `taskkill /PID <pid> /T /F` on the whole tree, after `Get-CimInstance Win32_Process` confirms the pid runs codex.
- Beyond `PATH` it probes `%APPDATA%\npm`, `%LOCALAPPDATA%\pnpm`, `%LOCALAPPDATA%\Volta\bin` and `%ProgramFiles%\nodejs`.

### Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Not in `claude mcp list` | The install method skipped `postinstall` | `codex-supervisor-setup`, or `claude mcp add` by hand |
| Dispatch says `codex only resolved to a shell shim` | Windows found only the `.cmd`; the package entry behind it is gone | Reinstall `@openai/codex`, or point `CODEX_BIN` at `codex.js` |
| Worker is `failed` at once with `spawn codex ENOENT` | No `codex` on the process's `PATH` | Set `CODEX_BIN` in the config |
| `Cannot find module 'node:sqlite'` | Node older than 22.13.0 | Upgrade Node |
| Worker stuck in `lost` | The MCP process was killed and the worker orphaned | `resume_codex_worker`, or dispatch again |
| `ownedPaths overlap with active worker(s)` | Two workers claimed the same paths | Split differently, or cancel the one holding them |
| The board is empty | The board and the MCP use different `SUPERVISOR_HOME`s | Start it inside a project with a `.mcp.json`, or pass the same `SUPERVISOR_HOME`; the second startup line names the store in use |
| `port 7877 ... is already in use` | A board is already running | Open `http://127.0.0.1:7877`, or start a second one with `SUPERVISOR_WEB_PORT=8080` |

## Known limitations

- A worker's lifetime is tied to the MCP process. Kill the MCP and the worker is left behind, settled as `lost` on the next read. The fix is a resident daemon; see the Roadmap.
- The worktree is cut from a commit, so uncommitted work in your checkout is not in it. Give the task absolute paths, or commit first.
- Only the working directory is isolated. Temp directories, databases and ports are shared; workers that would hit the same dev server need to be kept apart in the task.
- `ownedPaths` is checked at dispatch only; it does not stop a worker from creating a file it never listed. Review the diff.
- It reports "finished", not "correct". `exit_code: 0` means it did not crash; acceptance is the main thread's job.
- Do not expect one `wait_codex_workers` call to cover a long job. The client's MCP tool timeout is a hard wall; the default returns a snapshot after two minutes, loop instead.
- Nothing is written to Codex's native goal store; `goals_1.sqlite` is read-only here. The worker creates its own goal and sometimes skips it, in which case `native_goal` is `null` and the state machine is unaffected.
- `search_works` is substring matching. Fine at hundreds of rows; revisit at tens of thousands.

## Roadmap

1. ~~`CODEX_BIN` / `SUPERVISOR_HOME` / `GIT_BIN`~~ ✅
2. ~~`status` and `phase` split, `lost` added~~ ✅
3. ~~`ownedPaths` / `goal` / `dependsOn`, event gates~~ ✅
4. ~~`thread_id` on disk + `resume_codex_worker`~~ ✅
5. ~~Concurrency: crash points, ownership conflicts, multi-process writes~~ ✅
6. ~~`session_id` + `get_session_works`~~ ✅
7. ~~`search_works`~~ ✅
8. ~~Native worker goals~~ ✅
9. ~~Windows~~ ✅
10. ~~Web board~~ ✅
11. ~~Session titles, update check, `baseRef`, committed changes visible~~ ✅
12. Resident daemon: move dispatch and process lifetime out of the MCP process

Not planned: vector search (substring matching is faster at this scale and costs nothing to maintain), `usage_count` ordering (2 of 80 real works were ever referenced again), a layered memory index (not enough data to need one).

## Development

```bash
npm install
npm test               # truncation, state machine, migration, setup, Windows routing, 23 regression cases, 40 edge cases
npm run test:edge      # test/edge only: update check against a fake registry, session titles, baseRef, non-ASCII paths, ghost rows, board API
npm run test:real      # end to end with the real codex CLI
npm run smoke:mcp      # MCP protocol smoke test
npm run monitor        # Ink terminal board
npm run web:install    # board dependencies
npm run web:dev        # board with hot reload, /api proxied to 7877
npm run web:build      # bundle into web/dist; runs before publish
```

`npm test` replays fixed Codex event streams through `src/test-fixtures/fake-codex.js`, fast and deterministic; `npm run test:real` is the evidence of compatibility with the current Codex. CI runs Ubuntu / macOS / Windows plus one Node 22.13.0 job that pins the `engines` floor.

## License

MIT
