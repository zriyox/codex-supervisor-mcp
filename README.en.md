# codex-supervisor-mcp

English | [中文](README.md)

[![npm version](https://img.shields.io/npm/v/codex-supervisor-mcp.svg)](https://www.npmjs.com/package/codex-supervisor-mcp)
[![npm downloads](https://img.shields.io/npm/dm/codex-supervisor-mcp.svg)](https://www.npmjs.com/package/codex-supervisor-mcp)
[![license](https://img.shields.io/npm/l/codex-supervisor-mcp.svg)](LICENSE)
[![CI](https://github.com/zriyox/codex-supervisor-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/zriyox/codex-supervisor-mcp/actions/workflows/ci.yml)
[![node](https://img.shields.io/badge/node-%3E%3D22.13.0-339933.svg)](package.json)

Let one main thread (Claude Code, Codex, any MCP client) run several Codex workers at once.

![Demo: one Claude Code main thread dispatches 3 Codex workers, each in its own worktree, and merges the result into a single commit](https://raw.githubusercontent.com/zriyox/codex-supervisor-mcp/main/assets/demo.gif)

*30 seconds, recorded live rather than staged: the Claude Code main thread calls `create_codex_worker` three times, the workers run in parallel in their own worktrees, then the main thread collects three diffs and merges them into one commit.*

One worker per Git worktree, one worker per native Codex goal, every state written to disk. The main thread dispatches, waits, reads results back, reconnects after a crash, and cancels.

## What this solves

Point several agents at one repo and they overwrite each other, and afterwards nobody can tell who changed what. This MCP moves dispatch and bookkeeping out of the model context and onto disk:

| Problem | How it's handled |
|---|---|
| Workers stepping on each other's files | One Git worktree per worker; `ownedPaths` conflicts are checked before dispatch |
| The main thread can't hold every worker's output | Events go to `data/runs/<taskId>.jsonl`; reading them has three gates: `limit`, `maxChars`, `kinds` |
| One read blows up the main thread's context | `get_orchestration_overview` squeezes every worker under 2k tokens |
| After a restart you don't know what's still running | One row per work in `supervisor.sqlite`, `thread_id` included |
| A new session can't pick up an old worker | `resume_codex_worker` runs `codex exec resume <thread_id>`, which reattaches the same Codex session |
| "It failed" and "the process is gone" look alike | The state machine keeps `failed` and `lost` apart |

## How is this different from Claude Code subagents?

One thing that used to be a difference is not one anymore: a Claude Code subagent can run in its own worktree (`isolation: worktree`; see "Isolate subagents with worktrees" in the [official worktrees docs](https://docs.claude.com/en/docs/claude-code/worktrees)). File isolation is built in now, so don't install this plugin for that.

The real gap is the model. A subagent's `model` field takes a Claude alias or a full Claude model ID (`sonnet` / `opus` / `haiku` / `inherit`); a non-Claude model like DeepSeek has no way in, and every token is billed at Anthropic's rates. Dispatch three and you pay for three.

What gets dispatched here is a `codex exec` subprocess, and the `model` argument is passed straight through to the Codex CLI (`src/codex-runner.js:336`). A worker's model has nothing to do with the main thread's. Keep the main thread on Claude for judgment, put the workers on DeepSeek, and configure the provider in Codex's `config.toml`. The token-heavy work lands on the workers. The main thread reads the `get_orchestration_overview` table, and pulls a diff from the worker's worktree when it wants one.

| | Claude Code subagent | codex-supervisor worker |
|---|---|---|
| Models it can run | Claude only: an alias or a full Claude model ID | `model` goes to the Codex CLI, so DeepSeek works |
| What does the work | Claude Code itself | A separate `codex exec` process |
| Working directory | Shared with the main thread by default, or `isolation: worktree` | One Git worktree per worker |
| Two workers writing the same file | Separated by worktrees, with no declared paths and no conflict check | `ownedPaths` is intersected before dispatch; on overlap no worktree is created and you get `ownership_conflict` |
| Main thread context | Subagent results come back into it | Events go to `data/runs/<taskId>.jsonl`; the overview runs on a hard 7000-byte budget (`src/mcp-server.js:32`) |
| Main thread process dies | Workers die with it | `thread_id` is in sqlite; `resume_codex_worker` reattaches the same session |
| What can drive it | Claude Code only | Any MCP client |
| Watching a worker work | Only the conclusion it returns | Raw JSONL, read through `kinds` / `limit` / `maxChars` |

## Architecture

```
MCP client (Claude Code / Codex / ...)
   │  stdio (MCP)
   ▼
codex-supervisor-mcp
   │  spawn: codex exec --json
   ▼
Codex worker  ──►  data/runs/<taskId>.jsonl      raw JSONL event stream
              ──►  supervisor.sqlite             tasks + task_events
              ──►  worktrees/<taskId>/           the worker's own Git worktree
```

## Install

Requirements: **Node.js >= 22.13.0** (`node:sqlite` had no unflagged build before that) and the `codex` CLI on `PATH`. macOS, Linux, and Windows are all supported.

### Quick start

```bash
# 1. install
npm install -g codex-supervisor-mcp

# 2. confirm it registered
claude mcp list | grep codex-supervisor
codex mcp list  | grep codex-supervisor
```

A global install runs `postinstall`, which does two things with **no manual configuration**:

1. Copies the bundled skill into whichever client directories it finds: `~/.claude/skills/`, `~/.agents/skills/`, `~/.codex/skills/`.
2. Registers the MCP server through the client's own CLI: `claude mcp add -s user` / `codex mcp add`, pointing at `node <absolute path inside the package>`.

If a skill already exists with different content, it writes `SKILL.md.bak-<timestamp>` first and then overwrites. A failure in either step does not fail the install.

### Registering by hand

When `postinstall` doesn't run (`--ignore-scripts`, `npx`, pnpm, and similar), add the line yourself:

| Client | Command |
|---|---|
| Claude Code | `claude mcp add -s user codex-supervisor -- npx -y codex-supervisor-mcp` |
| Codex | `codex mcp add codex-supervisor -- npx -y codex-supervisor-mcp` |

To re-run it, repair it, target one client only, or just see what it plans to do:

```bash
codex-supervisor-setup                      # detect clients, install skill + register MCP
codex-supervisor-setup --target claude,codex
codex-supervisor-setup --skill-only         # skill only, leave MCP config alone
codex-supervisor-setup --mcp-only           # register MCP only, no skill
codex-supervisor-setup --dry-run            # print the plan, change nothing
```

### GUI clients

Write the config file yourself and add this block. GUI clients never run `postinstall`:

```json
{
  "mcpServers": {
    "codex-supervisor": {
      "command": "npx",
      "args": ["-y", "codex-supervisor-mcp"]
    }
  }
}
```

| Client | macOS | Windows | Linux |
|---|---|---|---|
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` | `%APPDATA%\Claude\claude_desktop_config.json` | `~/.config/Claude/claude_desktop_config.json` |
| Cursor | `~/.cursor/mcp.json` | `%APPDATA%\Cursor\mcp.json` | `~/.config/cursor/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `%APPDATA%\Codeium\windsurf\mcp_config.json` | `~/.config/.codeium/windsurf/mcp_config.json` |

### The npx gotcha

`npx` does not run `postinstall`, so **the skill is not installed and the MCP server is not registered**. Only the server itself will start. If you want the bundled skill, either `npm install -g` or run `codex-supervisor-setup` once by hand.

### Upgrading

```bash
npm install -g codex-supervisor-mcp@latest
npm ls -g --depth=0 | grep codex-supervisor    # confirm the version actually changed
```

`postinstall` runs again: it compares the skill by content, backs up to `SKILL.md.bak-<timestamp>` when it differs, and skips clients that already have the MCP registered.

Three known traps:

- **A freshly published version lags a few minutes behind the registry's `latest`.** If the version number didn't move, wait and reinstall, or pin it: `npm install -g codex-supervisor-mcp@0.5.3`.
- **`npm link` / `npm i -g .` produce a symlink.** Editing `src/` takes effect immediately, but editing `skills/SKILL.md` does not sync on its own; run `codex-supervisor-setup` once. To go back to a normal install, `npm install -g codex-supervisor-mcp@latest` overwrites the symlink.
- **Switching Node versions breaks the registration.** What gets registered is an absolute path (`~/.nvm/versions/node/<version>/lib/node_modules/...`), and `postinstall` sees "already registered" and skips, so the path is never rewritten. Remove it first, then install:

```bash
claude mcp remove -s user codex-supervisor
codex mcp remove codex-supervisor
npm install -g codex-supervisor-mcp@latest
```

To re-run the installer without upgrading, use `codex-supervisor-setup`.

### Uninstall

```bash
npm uninstall -g codex-supervisor-mcp
claude mcp remove -s user codex-supervisor
codex mcp remove codex-supervisor
rm -rf ~/.claude/skills/codex-supervisor ~/.agents/skills/codex-supervisor ~/.codex/skills/codex-supervisor
rm -rf ~/.codex-supervisor      # state directory: sqlite, event streams, worktrees
```

### Windows

- An npm-installed CLI on Windows is `codex.cmd`, not an executable, and Node refuses to `spawn` it directly since 18.20 / 20.12 (the behavior after CVE-2024-27980, reported as `EINVAL`). This package does not fall back to `shell: true` — that turns the shell into a child process, so cancelling kills the shell while the real Codex keeps running and the state machine sticks on `running`. Instead it goes around the shim to the npm package's own entry point (`node_modules/@openai/codex/bin/codex.js`) and starts it with `node`. The same path is taken when `CODEX_BIN` points at a `.js` file.
- Cross-process cancel uses `taskkill /PID <pid> /T /F` to take down the whole tree. Confirming that pid is still Codex reads its command line through PowerShell's `Get-CimInstance Win32_Process`, falling back to `tasklist`. `ps` is only used on macOS and Linux.
- Besides `PATH`, it probes `%APPDATA%\npm`, `%LOCALAPPDATA%\pnpm`, `%LOCALAPPDATA%\Volta\bin`, and `%ProgramFiles%\nodejs`.

Auto-install only happens on a **global install**. `npx`, `--ignore-scripts`, and being installed as someone else's dependency all skip it. Set `CODEX_SUPERVISOR_SKIP_SETUP=1` to opt out.

### Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `claude mcp list` has no `codex-supervisor` | `npx` / `--ignore-scripts` installs don't run `postinstall` | Run `codex-supervisor-setup`, or register by hand above |
| Dispatch fails with `codex only resolved to a shell shim` | On Windows only the `.cmd` was found and the npm package entry point behind it is gone | Reinstall `@openai/codex`, or point `CODEX_BIN` at the real executable / `codex.js` |
| A worker goes `failed` immediately with `spawn codex ENOENT` | The process started by a GUI client has no `codex` on `PATH` | Set `CODEX_BIN` explicitly in the client config |
| `Cannot find module 'node:sqlite'` | Node < 22.13.0 | Upgrade Node |
| A worker is stuck in `lost` | The MCP process was killed and the worker was orphaned | Let `list_codex_workers` settle it, or pick it back up with `resume_codex_worker` |
| `ownedPaths overlap with active worker(s)` | Two workers claimed the same path | Change the path, or `cancel_codex_worker` whichever is holding it |

## Tools

Sixteen of them.

| Tool | Arguments | What it does |
|---|---|---|
| `create_codex_worker` | `task`, `cwd`, **`ownedPaths`**, **`goal`**, `session_id`, `session_title`, `session_note`, `dependsOn`, `baseRef`, `sandbox`, `model`, `reasoningEffort`, `title`, `skipGitRepoCheck` | Start a worker. `session_title` / `session_note` record what the batch is for, so the board and `get_session_works` show that instead of a bare id. `baseRef` picks the commit the worktree is cut from (default: the repository's `HEAD`); pass another worker's `codex/<id>` branch to build on work that isn't on the main line yet |
| `create_codex_followup_worker` | `task_id`, `followup_prompt`, `session_id`, plus the same arguments | Start a **new session**, seeded with the old worker's prompt, status, and recent events |
| `resume_codex_worker` | `task_id`, `prompt` | Continue the **same** Codex session |
| `list_codex_workers` | `status`, `includeHistory`, `includeDetails` | List workers; running ones only by default |
| `get_orchestration_overview` | `status`, `limit` | A compact status table for every worker, meant for the main thread |
| `wait_codex_workers` | `task_ids`, `mode`(any/all), `timeoutMinutes`, `timeoutMs`, `includeEvents`, `eventLimit`, `eventMaxChars`, `eventKinds` | Wait for a terminal state, then return summaries. The default wait is 2 minutes: when it runs out you get a progress snapshot and the workers keep going, so call it again. Events are **off** by default (`includeEvents: false`) |
| `get_codex_worker_status` | `task_id`, `includePrompt`, `promptMaxChars` | Status for one worker: lifecycle, phase, current action, changed files, goal, recent commands, with the prompt clipped. Pass `includePrompt: true` for the full prompt |
| `get_codex_worker_events` | `task_id`, `limit`, `maxChars`, `kinds` | Read the raw event stream |
| `get_worker_goal` | `task_id` | Read a worker's goal (supervisor side and native Codex side) |
| `get_worker_summary` | `task_id` | One paragraph about a worker; what the main thread reads when wrapping up |
| `get_worker_result` | `task_id`, `limit`, `maxChars` | A worker's own final report, in full. The overview and `wait_codex_workers` clip the last message to 400 characters and keep only the head; read this for the conclusion |
| `get_session_works` | `session_id` | Every worker dispatched under one session, oldest first. This is how a dead main thread finds its batch again |
| `search_works` | `query`, `limit` | Substring match over title / goal / prompt / last_message, newest first |
| `describe_session` | `session_id`, `title`, `note` | Record a title and a note for a session; fields you leave out keep their value. For when the first dispatch forgot |
| `check_for_update` | `force` | Ask the npm registry whether a newer version is published and whether the installed files match the published tarball. The same check runs at startup; this forces a fresh one |
| `cancel_codex_worker` | `task_id` | Stop a worker; falls back to the pid when the process handle isn't in this process |

### Why `ownedPaths` and `goal` are required

- `ownedPaths`: the paths this worker is allowed to write, relative to `cwd` or absolute. Before dispatch it is intersected against every running worker; on overlap the dispatch is refused and the conflicting `task_id` comes back. No worktree gets created and then thrown away.
- `goal`: `{ objective, tokenBudget? }`. This anchors the main thread's L1 summary and decides when the work should stop.

`dependsOn` records the dependency edges between workers. It's stored, so the main thread can see who is waiting on whom.

### Three gates on reading events

`get_codex_worker_events` keeps the cost of a read under control with three arguments:

| Argument | Effect |
|---|---|
| `limit` | At most this many events |
| `maxChars` | Long strings inside a single event are truncated in the middle, keeping head and tail |
| `kinds` | Only these event types; the filter runs before `limit` is applied |

The truncation rule copies Codex's own `TruncationPolicy::Bytes`: cut the middle, keep both ends, and prefix with

```
Warning: truncated output (original token count: N)
Total output lines: M
```

`get_orchestration_overview` has the same kind of hard guarantee. Field limits tighten step by step until the whole JSON payload fits in 7000 bytes (about 1750 tokens). The `approx_tokens` it returns is its own real cost.

## The work state machine

`status` is the lifecycle. One value per work, never overwritten by progress:

| Value | Meaning |
|---|---|
| `queued` | Dispatched, not started |
| `running` | Running |
| `completed` | Succeeded |
| `failed` | Failed (non-zero exit code, `turn.failed`, spawn failure) |
| `cancelled` | Interrupted by `cancel_codex_worker` |
| `lost` | Killed by an external signal, or the MCP process vanished without writing a terminal event |

`phase` only has a value while `running`, and goes back to `null` at a terminal state:

```
starting → thinking → command → editing → reporting
```

Keeping `failed` and `lost` apart is useful: the first sends you to the logs, the second means just run it again.

Windows has no signals, so only one of the two is decidable there. libuv kills a process with `TerminateProcess(handle, 1)`, and an external kill looks exactly like the process calling `exit(1)` from the parent's point of view: `exit_code=1`, `signal=null` in both cases. In that situation it reports the one it can prove, `failed` plus an exit code, rather than inventing a signal name the platform never delivered. `lost` still happens on Windows, through the MCP process disappearing and orphans being settled on the next start.

### Goal states mapped to work states

A native Codex goal has six states. They map onto work status like this:

| Goal state | Work status | Note |
|---|---|---|
| `active` | `running` | Progressing normally |
| `paused` | `running` | Paused, waiting on a person |
| `blocked` | `running` | Stuck, needs the main thread to step in |
| `usageLimited` / `usage_limited` | `failed` | Quota exhausted |
| `budgetLimited` / `budget_limited` | `failed` | Budget exhausted |
| `complete` | `completed` | Done |

`paused` and `blocked` are not endings. They mean someone needs to look. `get_orchestration_overview` lists both under `needs_attention`, so you don't have to guess with a timeout.

## Where state lives

By default under `~/.codex-supervisor/`:

| File | Contents |
|---|---|
| `data/supervisor.sqlite` | `tasks` (one row per work) and `task_events` (structured events with a `seq`) |
| `data/runs/<taskId>.jsonl` | Codex `--json` raw output, one event per line |
| `worktrees/<taskId>/` | That worker's own Git worktree |

A database from 0.1.x migrates automatically the first time it's opened. Process values that used to live in `status` (`editing`, `command`, `command_completed`, `reporting`) move into `phase`, and `status` becomes `running`. Nothing is dropped. The migration runs inside one `BEGIN IMMEDIATE` transaction, so if several processes start at once only one of them actually migrates.

`changed_files` has three sources: Codex's `file_change` events, `git status --porcelain` in the worker's own worktree (the uncommitted part), and `git diff --name-only <base_commit> HEAD` (the committed part). The last two exist because a worker that edits files through a shell command (`printf > file`) never emits a `file_change` event, and once it commits on its branch `git status` is clean again - a real batch of five workers did exactly that and every read came back empty. `base_commit` is recorded on the row at dispatch; rows older than that column fall back to the oldest reflog entry of the `codex/<taskId>` branch, which is where the branch was created.

## The board

The package ships a read-only web view over the same SQLite file:

```bash
codex-supervisor-web                               # after a global install
npx -p codex-supervisor-mcp codex-supervisor-web   # without installing
```

It listens on `http://127.0.0.1:7877`; `SUPERVISOR_WEB_PORT` / `SUPERVISOR_WEB_HOST` move it, `SUPERVISOR_HOME` points it at another state directory.

The left column lists sessions by the `session_title` recorded at dispatch (or, failing that, a line built from the workers' goals) and how many of their workers are still running. A session opens into its worker ledger: status, title, the command being run or the last line reported, time taken, files changed (the worktree's real diff, committed work included), commands run. A worker opens a drawer with the full report rendered from markdown, the change list, commands, the raw event stream, the task text, token usage and the native Codex goal. It refreshes every 2.5 seconds while something is running, every 8 seconds otherwise.

It reads. It does not dispatch or cancel; that stays with the MCP.

## Update check

When the MCP process starts it asks the npm registry which version is `latest` and what that tarball's integrity is, then compares two things:

- The installed version. If it is behind `latest`, `get_orchestration_overview`, the dispatch receipt and the `wait_codex_workers` response gain an `update` field with `latest_version` and the command to run (`npm i -g codex-supervisor-mcp@latest`). The skill tells the main thread to pass that on to the user.
- The installed files. A global install records the integrity of the unpacked tarball in `node_modules/.package-lock.json`; if it differs from what the registry publishes for that version, the files on disk are not the published build, and the notice says to reinstall. A git checkout has no such value and reports its commit instead.

The answer is cached for an hour and refreshed every six hours while the process runs. An unreachable registry is not an error: the result says `source: "offline"` and nothing nags. `CODEX_SUPERVISOR_NO_UPDATE_CHECK=1` turns the check off; `CODEX_SUPERVISOR_REGISTRY` points it at a private registry. The board shows the same result in its lower left corner.

## Environment variables

| Variable | Default | Effect |
|---|---|---|
| `SUPERVISOR_HOME` | `~/.codex-supervisor` | State root. sqlite, event streams, and worktrees all live under it |
| `CODEX_HOME` | `~/.codex` | Read-only. Used to read Codex's own `goals_1.sqlite` |
| `CODEX_BIN` | `codex` (via `PATH`) | Path to the Codex CLI. On Windows a bare name is expanded through `PATHEXT` and the `.cmd` shim is stepped over automatically; a `.js` / `.cjs` / `.mjs` target is started with `node` |
| `GIT_BIN` | `git` (via `PATH`) | Path to the Git executable |
| `SUPERVISOR_WEB_PORT` / `SUPERVISOR_WEB_HOST` | `7877` / `127.0.0.1` | Where the board listens |
| `CODEX_SUPERVISOR_NO_UPDATE_CHECK` | unset | Set to `1` to disable the update check |
| `CODEX_SUPERVISOR_REGISTRY` | `https://registry.npmjs.org` | Registry the update check asks |
| `CODEX_SUPERVISOR_UPDATE_TIMEOUT_MS` | `4000` | How long the update check waits for the registry |

When the MCP client starts without `codex` on `PATH`, which is common for GUI-launched apps, set `CODEX_BIN` explicitly:

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

## Known limitations

- **A worker's lifetime is tied to the MCP process.** `codex` is a child of the MCP process, so killing the MCP process leaves workers behind. They get settled as `lost` on the next `list_codex_workers` / `get_orchestration_overview`. The real fix is a resident daemon, see the Roadmap.
- **The worktree is created from a commit, so uncommitted work isn't in it.** The default is the repository's `HEAD`; `baseRef` accepts any branch, tag or sha (one that doesn't resolve refuses the dispatch with `invalid_base_ref` instead of quietly falling back to `HEAD`). Modified and untracked files sitting in the main thread's checkout don't exist inside the worker's worktree. Give the task absolute paths, or commit first. The worker's own changes land on the `codex/<taskId>` branch and never touch the main checkout.
- **Only the working directory is isolated.** Temp directories (`TMPDIR`), databases, and ports are process-level resources and stay shared, so two workers writing the same temp file still collide. Give each one its own paths, database name, and port in the task if you need that.
- **`ownedPaths` is a pre-dispatch conflict check, not a runtime sandbox.** It stops two workers from registering the same file; it does not stop a worker from creating a file it never listed, because the sandbox is `workspace-write` and any path inside its own worktree is writable. Verify the output from the diff.
- **It reports "it finished", not "it's correct".** Terminal states come from Codex's `turn.completed` and the process exit code; `exit_code: 0` only means it didn't crash. Judging the output is the main thread's job: run the checks, spot-read the content.
- **A terminal state lands in two steps, and wait only returns once both have.** `turn.completed` flips `status` to `completed` first; `exit_code` is written when the process exits. `wait_codex_workers` counts a worker as finished only once `exit_code` is recorded (or nobody is left to record it), so the snapshot it returns matches the next `get_codex_worker_status` read. A direct status read can still land between the two steps: `completed` with `exit_code: null` is that gap, read again a moment later.
- **Don't expect one `wait_codex_workers` call to cover a long job.** Your client's MCP tool timeout is a hard wall (the `timeout` field in `.mcp.json`, or `MCP_TOOL_TIMEOUT`), and hitting it kills the call. The default wait returns after 2 minutes with a progress snapshot; loop instead of waiting once.
- **Long text comes back clipped by default.** `current_action` is cut at 300 characters, the prompt inside `get_codex_worker_status` is cut at 300 (`includePrompt: true` lifts that), and `last_message` is cut at 400 in the overview and the wait response (4000 in the status response). Nothing is lost: the full command stream is in `get_codex_worker_events` and the full report is in `get_worker_result`. This is what takes one `wait_codex_workers` round trip from tens of KB down to a few KB - which matters because a client that backgrounds a timed-out call replays the whole result as a notification.
- **Nothing is written to Codex's native goal store.** `goals_1.sqlite` belongs to Codex and this MCP only reads it. Once a worker starts, it calls Codex's own `create_goal`; this MCP only splices that instruction into the prompt at dispatch time.
- **Native goals depend on the model complying.** `codex exec` does not create a goal on its own; the instruction at dispatch time is what makes the worker create one. The model occasionally skips it, in which case `native_goal` is `null` and `get_worker_goal` falls back to the copy recorded at dispatch. The state machine is unaffected.
- **`search_works` is substring matching, not a full-text index.** At a few hundred works, a `LIKE` scan is fast enough and costs nothing to maintain. Talk about something else at tens of thousands.
- **Cross-process cancel goes through the pid.** When the process handle isn't in this process, it first confirms the pid's command line contains `codex` (`ps` on macOS and Linux, CIM on Windows, `tasklist` as a fallback), then sends `SIGTERM` (`taskkill /T /F` on Windows), so a recycled pid doesn't get killed by mistake.
- **`create_codex_followup_worker` and `resume_codex_worker` are not the same thing.** The first opens a new session and restates the context in prose; the second reattaches the same session. Use the second when details matter.
- **`session_id` comes from the dispatcher; this MCP doesn't generate it.** Pass the same value for a batch of work and `get_session_works` can group it afterwards. Without it the column is `NULL` and the batch is unrecoverable by session.

## Roadmap

1. ~~De-personalize: `CODEX_BIN` / `SUPERVISOR_HOME` / `GIT_BIN` environment variables~~ ✅
2. ~~Work state machine: split `status` and `phase`, add `lost`~~ ✅
3. ~~Tool surface: `ownedPaths` / `goal` / `dependsOn`, four new tools, event gates~~ ✅
4. ~~Cross-session continuation: persist `thread_id` + `resume_codex_worker`~~ ✅
5. ~~Concurrency stability: two crash points, ownership conflicts, multi-process writes~~ ✅
6. ~~Session dimension: persist `session_id` + `get_session_works` for reconnects~~
7. ~~Find past work by keyword: `search_works`~~
8. ~~Worker-native goals: inject a `create_goal` instruction at dispatch~~
9. ~~Windows support: `.cmd` shim bypass, `taskkill` process tree, cross-platform `PATH` / `PATHEXT`~~ ✅
10. Resident daemon: move dispatch and process lifetime out of the MCP process
11. ~~A live React board~~ ✅
12. ~~Session titles and notes, update check~~ ✅

Rejected, with the reasoning, so nobody brings them up again:

| Idea | Why not |
|---|---|
| Vector search | `search_works` substring matching is faster and needs zero maintenance at a few hundred works. Both vendors' official memory systems (Codex `memories`, Claude auto-memory) are file search too, not vectors |
| Sorting by `usage_count` | Measured: of 80 works, only 2 were ever referenced again. Every counter sat at 0 or 1, so sorting did nothing |
| Reusing Codex's `usage_count` | That number counts how often a memory entry was cited, which is a different question from how often the main thread looked it up |
| A three-layer memory index | The current data volume can't justify one layer. `get_worker_summary` is enough |

## Using the bundled skill

The repo ships `skills/codex-supervisor/SKILL.md`. After installing, drop it into the main thread's skill directory so it knows when to dispatch:

```bash
# Claude Code
mkdir -p ~/.claude/skills/codex-supervisor
cp "$(npm root -g)/codex-supervisor-mcp/skills/codex-supervisor/SKILL.md" ~/.claude/skills/codex-supervisor/

# Codex / any client that reads ~/.agents/skills
mkdir -p ~/.agents/skills/codex-supervisor
cp "$(npm root -g)/codex-supervisor-mcp/skills/codex-supervisor/SKILL.md" ~/.agents/skills/codex-supervisor/
```

The skill covers the dispatch flow, the order to read results in, how to tell `failed` from `lost`, and how to reconnect after a crash.

## Development

```bash
npm install
npm test               # deterministic: truncation, state machine, v1→v2 migration, setup, Windows routing, 23 regression cases, 40 edge cases
npm run test:edge      # test/edge only: update check against a fake registry, session titles, baseRef, non-ASCII paths, ghost rows, board API
npm run test:real      # end-to-end against the real codex CLI (includes cross-process resume and worktree isolation)
npm run smoke          # basic smoke test (real codex)
npm run smoke:mcp      # MCP protocol smoke test
npm run monitor        # Ink terminal board
npm run web:install    # board dependencies (web/)
npm run web:build      # bundle the board into web/dist; runs before publish
npm run web:dev        # board with hot reload, /api proxied to 7877
```

`npm test` replays a fixed Codex event stream through `src/test-fixtures/fake-codex.js`, so it's fast and deterministic. `npm run test:real` actually invokes `codex exec`. It's slower, but it's the evidence that this still works against the current Codex.

CI runs on Ubuntu, macOS, and Windows, plus a separate Node 22.13.0 job that pins the lower bound declared in `engines`, since `node:sqlite` had no unflagged build before it. The four `setup-windows-test.js` cases use a real filesystem to simulate the `.cmd` shim under `%APPDATA%\npm`, verifying that automatic MCP registration genuinely works rather than just passing a parser unit test.

## License

MIT
