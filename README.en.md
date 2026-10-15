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
| A worker is not only an editor | Three shapes: edit (`ownedPaths` non-empty), read-only verify (`read-only` + `ownedPaths: []`: no writes, no network), research/retrieval (`workspace-write` + `networkAccess: true` + `ownedPaths: []`: fetches, keeps scratch notes, never lands). Reading shared files is never exclusive; writing is |
| A worker says it is done and it is not | Dispatch with `acceptance` commands; the supervisor runs them in the worktree after the worker exits, and `land` refuses while they fail |
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

A global npm install runs `postinstall` when lifecycle scripts are enabled, installing the skill and registering MCP with detected Claude Code/Codex clients. `--ignore-scripts`, disabled lifecycle scripts, and running through npx do not guarantee registration; run `codex-supervisor-setup` and inspect both clients with `mcp get`. Manual registration also works:

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
wait_codex_workers       60 seconds by default, then a snapshot, call again until done
get_worker_result ×3     each worker's report, with the commands it really ran
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
              Put the verify command in acceptance too; the supervisor runs it, the worker's word does not count
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
wait_codex_workers      60 seconds a round, compact: true, call again until done
get_worker_result       what it says it did; verification is what it really ran
get_worker_diff         what it actually did
ask_codex_worker        when the two differ, ask why; read-only, its thread untouched
resume_codex_worker     when it must change something, one follow-up, amended into the same commit; rebaseOnto when main has moved
land_codex_worker       checked, then landed on the integration branch
```

The last block was 25 steps. One main-brain session watched all 25, with nothing in its context but the brief and each worker's report; the workers' output never reached it.

Why one worker does one step: when step 5 is wrong, the worker that did step 5 gets one `resume_codex_worker`, amends its own commit, the main brain checks again, and only then lands it. A worker that did steps 5, 6 and 7 cannot be fixed that way: 6 and 7 already sit on top of 5, so fixing 5 means redoing them too.

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

Twenty-one.

| Tool | Arguments | What it does |
|---|---|---|
| `check_workers` | none | Report newly settled runs and actionable changes; recover a new-format first lost/no_work run once. Unchanged state is quiet. Call from a host-scheduled loop and use a distinct CODEX_SUPERVISOR_OBSERVER_ID for each reconnecting main thread |
| `check_acceptance` | `cwd`, `acceptance`, `baseRef`, `timeoutMs` | Execute supplied checks before dispatch, without creating a worker or proving completion; warns that failure-count greps do not establish an approved failure list or required execution |
| `create_codex_worker` | `task`, `cwd`, **`ownedPaths`**, **`goal`**, `forbid`, `allowedCommands`, `context`, `contracts`, `externalOutputs`, `networkAccess`, `writableRoots`, `maxRunMs`, `maxTotalMs`, `acceptance`, `session_id`, `session_title`, `session_note`, `dependsOn`, `baseRef`, `sandbox`, `model`, `reasoningEffort`, `title`, `skipGitRepoCheck` | Start a worker. `acceptance` lists the commands the supervisor runs in the worktree once the worker exits; exit 0 on every one passes. `baseRef` picks the commit the worktree is cut from (default `HEAD`); pass another worker's `codex/<id>` to build on it |
| `create_codex_followup_worker` | `task_id`, `followup_prompt`, `session_id`, plus the above | A new session seeded with the old worker's prompt, status and recent events |
| `resume_codex_worker` | `task_id`, `prompt`, `rebaseOnto`, `acceptance`, `context` | Continue the same Codex conversation; `thread_id` stays. `rebaseOnto` first moves the worktree onto the project's newer commit (stash, skip integrated patches, replay new commits, unstash); a conflict puts it back and does not start the worker |
| `wait_codex_workers` | `task_ids`, `mode` (any/all), `timeoutMinutes`, `timeoutMs`, `compact`, `includeEvents`, `eventLimit`, `eventMaxChars`, `eventKinds` | Wait for terminal states. 60 seconds by default, then a snapshot while the workers keep running; `compact` returns one line per worker with `idle_seconds` / `command_running`, so a long command and a stuck worker look different |
| `get_orchestration_overview` | `status`, `limit` | Every worker in one table, capped at 7000 bytes. Carries `version` and `update` |
| `get_worker_result` | `task_id`, `limit`, `maxChars`, `includeFiles` | The worker's own report, clipped past 6000 bytes with `truncated` and the size to ask for. `acceptance` is whether the supervisor's own checks passed, `verification` the commands the worker ran with exit codes, `base_behind` how far main has moved (`behind` is `null` with a note when `contains_base` is false, meaning the directory switched lines) |
| `get_worker_diff` | `task_id`, `maxChars`, `paths` | What the worker actually changed: patches from the worktree's start to its working tree, committed or not. `maxChars` bounds the answer; files past it are listed without a patch |
| `ask_codex_worker` | `task_id`, `question`, `timeoutMs`, `maxChars`, `fresh`, `end` | Ask the worker on the side. Its thread is forked into a read-only session with no network and no MCP tools; the worker itself is untouched. A resumed worker gets a new fork by itself, `fresh` forces one, `end` deletes it |
| `land_codex_worker` | `task_id`, `onto`, `commitMessage`, `ignoreAcceptance`, `allowOutsideOwned` | Cherry-pick the worker's `codex/<id>` commits onto the current branch of the dispatch directory: clean target only, a conflict rolls back, a failed acceptance is refused. `commitMessage` first commits its uncommitted edits as one commit; `ignoreAcceptance` lands anyway |
| `get_worker_summary` | `task_id` | One paragraph: goal, status, changes, last command and message |
| `get_codex_worker_status` | `task_id`, `includePrompt`, `promptMaxChars` | One worker in detail |
| `get_codex_worker_events` | `task_id`, `limit`, `maxChars`, `kinds` | The raw event stream |
| `get_worker_goal` | `task_id` | The goal recorded at dispatch plus the native Codex goal (tokens, time) |
| `list_codex_workers` | `status`, `includeHistory`, `includeDetails` | List workers, active ones by default |
| `get_session_works` | `session_id` | Every worker of one session. The way back after a main-thread restart |
| `describe_session` | `session_id`, `title`, `note`, `objective`, `default_acceptance`, `approval_state`, `expected_revision` | Record a title and note for a session |
| `search_works` | `query`, `limit` | Substring search over title / goal / prompt / last_message, newest first |
| `check_for_update` | `force` | Ask the registry for a newer version |
| `cancel_codex_worker` | `task_id` | Stop a worker. Falls back to the pid across processes, after confirming that pid runs codex |

Two are required: `ownedPaths` (checked against every running worker before dispatch, overlap refuses the call, dispatch-time only) and `goal.objective` (the worker turns it into a native Codex goal). Without `session_id` nothing groups the batch; use one value for the whole batch.

`acceptance` runs in Bash with `errexit` and `pipefail`: an unhandled failure stops the check, including a failing test in `npm test | tail`. Handle expected failures explicitly with `if` or `||`; a timeout always fails, even when the command exits 0 after termination. Windows requires Git for Windows Bash and reports an error when it is missing. Displayed output is clipped without changing the exit code.

Acceptance commands receive `CODEX_SUPERVISOR_TASK_ID`, `CODEX_SUPERVISOR_BASE_COMMIT` and `CODEX_SUPERVISOR_RUN`: the current task, run base and run number, refreshed after rebase/resume.

Structured acceptance entries use `{command, reportPath, baseline}`. The baseline contains `identity.base_commit`, `failures` (test_id/kind/signature), and `required`; the report contains complete, identity, failures, executed, skipped, and the current `CODEX_SUPERVISOR_CHECK_ID`. Missing/skipped required tests, reused evidence, and changed failures reject acceptance while preserving the shell exit code. reportPath must remain inside the working directory; write reports to an ignored temporary directory so they are not landed.

Landing checks the real diff against ownedPaths before committing drafts; only use allowOutsideOwned for an explicitly approved exception.

Session default_acceptance is prepended to local checks; resume uses the latest policy. describe_session returns policy_revision and expected_revision prevents stale edits. waiting_user blocks dispatch/resume until approved. host_goal_sync returns a current-policy /goal command. Replace an active native goal through /goal, or propose the same condition through ProposeGoal for host approval when available. The condition reads the latest session revision and approved scope; MCP does not silently modify or disable the host Stop hook.

Wait defaults to 60 seconds and compact rows; includeEvents selects details unless compact is explicit. Clients supplying a progress token receive notifications every 30 seconds. MCP SDK and real Claude 2.1.299 are verified: a 65-second wait succeeds with a 35-second idle timeout after three progress notifications. Native /loop scheduling is also verified.

Each run injects the shipped PreToolUse guard: apply_patch checks every target including renames and symlinks; forbid rejects red lines. Shell allows simple reads and explicitly declared allowedCommands/acceptance. Declared validation scripts run with dispatcher privileges and may have side effects; this is not a filesystem sandbox for arbitrary programs. Resume/follow-up inherit the policy without changing global hooks. Empty write runs use current output and command evidence and surface no_work; read-only tasks are not empty merely for having no diff.

A model with no separate `apply_patch` tool (measured with Codex 0.162 + DeepSeek/cc-switch) sends the patch as a shell call: `apply_patch <<'EOF' ... EOF`. The guard accepts that shape and judges every target path with the same ownedPaths rule, so such a model can still edit; an unquoted heredoc, or one followed by `&&`/`;`, is refused.

An `allowedCommands` entry ending in `*` is a prefix match (so `go test ./internal/*` covers `go test ./internal/service -run TestX`), valid only for a single command without shell metacharacters. An editor worker may also read with grep/sed (without `-i`)/find (without `-exec`/`-delete`)/jq (without `-i`)/awk, the git read subcommands and pure read pipes such as `cmd | head|tail|wc|sort|uniq`; `tee`, redirects and `env` stay refused. The guard is not a filesystem sandbox: a miss only writes inside the worker's own worktree, and land refuses it.

The guard relaxes by worker shape: an editor with non-empty `ownedPaths` gets only declared commands and simple reads; a `read-only` worker, or one with `ownedPaths: []`, has no landable write boundary left, so the shell is no longer restricted command by command (forbid red lines still apply) and retrieval, review, `curl`, `gh` and `python` work. Measured with Codex 0.162: the read-only sandbox cannot write even `/tmp` and has no DNS, so a fetching worker runs `workspace-write` + `networkAccess: true` + `ownedPaths: []` and its output never merges.

After reconciliation, check_workers atomically resumes a dead first lost/no_work/invalid_report run once and returns recovery receipts (an invalid report only re-asks for the bare JSON; it does not redo the work). A second failure remains actionable; approval, authentication, permission and quota waits are not retried. Final reports use JSON result/verification/not_done; structured_report exposes validation independently of command history and acceptance. Invalid JSON is failed/invalid_report and cannot land. Existing history is labelled legacy_text.

context declares up to 20 absolute file paths with optional sha256, within a combined 6000-character budget with contracts; each file is at most 5 MB. Dispatch pins actual hashes and resume refuses drift unless new context is explicitly supplied. Handoffs are limited to 1800 characters/16 lines with a truncation marker; complete contracts and refs remain separate, and inputs grant no write permission.

Declare externalOutputs:[{path,sha256?}] and acceptance for shared writes. Targets are absolute file paths, at most 1 MB each. Current-run before/after hashes and bounded content appear in result/diff as shared_file_already_written_not_cherry_pick; land cannot integrate external files. Targets participate in ownership conflict checks and hook policy; the dispatcher is responsible for validation script side effects.

workspace-write defaults to networkAccess:false; explicitly enable it for ssh/network checks. Resume/follow-up inherit the setting. maxRunMs bounds one run and maxTotalMs bounds wall time since dispatch; exceeding either stops the worker and preserves actionable partial results without automatic retry. A wait budget does not change these quotas.

Besides the worktree and the temp directory the sandbox writes the OS cache directory only (macOS `~/Library/Caches`, Linux `~/.cache`, Windows `%LOCALAPPDATA%`). Toolchains that cache there, Go's build cache among them, need no per-language variable and no patch when a new language shows up. Codex refuses a writable root with a symlink component, and such a root fails every command in the worker, so both the cache directory and every declared `writableRoots` entry are resolved through realpath first and a root that cannot be resolved to a symlink-free path is dropped. A toolchain that caches elsewhere (`~/.m2`, `~/.gradle`, a vendored mirror) passes `writableRoots:[absolute paths]`: existing directories, at most 20, workspace-write only, inherited by resume/follow-up. Read-only reuse needs nothing.

Dispatch checks required hooks/output-schema support (Codex 0.162+); unsupported capability returns settled start_failed. get_worker_goal.native_goal_read distinguishes missing_goal, missing_database, locked and read_error; a read failure is not evidence that no goal exists. Native budget/usage limits need attention. Cleanup preserves ignored artifacts, shared evidence and unresolved attention.

Ownership reservation and task insertion are atomic across MCP dispatch/resume processes; ownership remains reserved during acceptance or exit settlement. Failure to create an isolated Git checkout is explicit and never falls back to executing in the project directory.

Cleanup previews by default: `npm run cleanup -- --dry-run`. `--apply` removes only integrated, clean completed worktrees with no active dependents and verified Git registration/ownership. Dirty, unlanded, lost/failed or unproven work is preserved with a reason.

## How this differs from Claude Code subagents

File isolation is not the difference: a subagent can open a worktree too. The difference is the model and the process.

| | Claude Code subagent | codex-supervisor worker |
|---|---|---|
| Model | Claude only | `model` passed to the Codex CLI; DeepSeek works |
| Who does the work | Claude Code itself | A separate `codex exec` process |
| Two writers on one file | Worktrees keep them apart, no path declaration | `ownedPaths` overlap is refused before dispatch |
| Main-thread process dies | The main window cannot collect results | An independent run process records worker output and acceptance; a new window reads the same session_id |
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
| `lost` | Worker killed by an outside signal, run process disappeared, or a row whose process never started. `resume_codex_worker` picks it up |

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

GUI clients (Claude Desktop, Cursor, Windsurf) are not automatic registration targets of this installer: add this to their MCP config file, and since their `PATH` often lacks `codex`, give `CODEX_BIN` explicitly:

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

When the install fails (a global directory that needs sudo) the `update` field says why and `npm install -g codex-supervisor-mcp@latest` by hand still works. Versions up to 0.6.1 only notify; upgrade by hand once and it is automatic from then on. After changing Node versions/install prefixes, setup repairs old package-generated paths and verifies command/args through client read-back. Custom, disabled and project registrations are preserved with a repair warning. To run the setup again: `codex-supervisor-setup` (`--skill-only` / `--mcp-only` / `--dry-run`). Manual registration failures exit nonzero; automatic installs warn without failing npm. A skill write failure does not prevent MCP registration. Set `CLAUDE_BIN` / `CODEX_BIN` for off-PATH CLIs. Skill locations follow `CLAUDE_CONFIG_DIR` / `CODEX_HOME`.

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
| Worker `lost` | The worker or independent run process was interrupted | Inspect events, then `resume_codex_worker` |
| Worker reports `git add` failing with `index.lock: Operation not permitted` | The default sandbox keeps `.git` read-only | `land_codex_worker` with `commitMessage`, or dispatch with `danger-full-access` |
| `ownedPaths overlap with active worker(s)` | Two workers claimed the same paths | Split differently, or cancel the one holding them |
| The board is empty | The board and the MCP use different `SUPERVISOR_HOME`s | Start it inside the project with the `.mcp.json`, or pass the same `SUPERVISOR_HOME` |
| `port 7877 ... is already in use` | A board is already running | Open it, or start another with `SUPERVISOR_WEB_PORT=8080` |

## Known limitations

- Each run has an independent process that drains worker output, records its exit, and runs acceptance before exiting. These continue after the dispatching MCP is killed; a new window uses `get_session_works` to collect results. If the run process is also killed, inspect lost/interrupted evidence before resuming the preserved worktree and thread_id.
- In the default `workspace-write` sandbox a worker cannot commit (Codex keeps `.git` read-only). Either `land_codex_worker` with `commitMessage` commits for it, or dispatch with `danger-full-access`.
- The worktree is cut from a commit; uncommitted work in your checkout is not in it.
- Only the working directory is isolated. Temp directories, databases and ports are shared.
- `ownedPaths` is checked at dispatch only; it does not stop a worker from creating files outside its list. Read the diff.
- Acceptance checks exactly what `acceptance` says. Anything not written there is not checked; `verification` is only what the worker ran itself, and the rest is the main thread reading the diff.
- One `wait_codex_workers` cannot wait to the end; the client's MCP tool timeout is a hard wall. Call it again.
- `search_works` is substring matching, fine for hundreds of works.

## Roadmap

Done: `CODEX_BIN` / `SUPERVISOR_HOME` / `GIT_BIN`; `status` and `phase` split; `ownedPaths` / `goal` / `dependsOn`; `thread_id` on disk + `resume_codex_worker`; concurrency and multi-process writes; `session_id`, `search_works`, native goals; Windows; the web board; `baseRef`; collecting work with `get_worker_diff` / `ask_codex_worker` / `land_codex_worker`; background auto-update.

Run lifetime is independent of MCP; each run process exits after settlement without a global resident daemon.

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
