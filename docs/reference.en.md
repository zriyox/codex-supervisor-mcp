# Reference

The [README](../README.en.md) covers getting started. Every tool argument, where the guard and acceptance draw their lines, which directories the sandbox opens, and the full list of environment variables are here.

## Tools

Fourteen by default; three more are registered only with `AGENT_SUPERVISOR_TOOLS=all`. Every argument is snake_case, and an unknown or misspelled argument is refused rather than ignored. A failed call sets MCP `isError` and carries a stable `error` code.

| Tool | Arguments | What it does |
|---|---|---|
| `preflight_worker` | `cwd`, `probe_commands`, `acceptance`, `owned_paths`, `title`, `model`, `reasoning_effort`, `workspace`, `sandbox`, `context`, `limits` | With `probe_commands`: starts a short probe under the target worker's workspace, sandbox and guard and returns its id. With only `acceptance`: runs those commands in `cwd` now and returns the results; no worker is created |
| `create_worker` | `task`, `cwd`, **`owned_paths`**, **`goal`**, `title`, `followup_of`, `depends_on`, `preflight_id`, `model`, `reasoning_effort`, `session`, `workspace`, `sandbox`, `context`, `acceptance`, `limits` | Dispatches one worker. With `followup_of` it continues that worker from its branch and inherits what is not given; `cwd`, `owned_paths` and `goal` may then be left out |
| `resume_worker` | `task_id`, `prompt`, `rebase_onto`, `context_files`, `acceptance` | Continues the same session. `rebase_onto` first moves the worktree onto a newer commit; a conflict is returned and no worker starts |
| `cancel_worker` | `task_id` | Stops a worker or its running acceptance. The worktree and its changes stay |
| `poll_workers` | `cursor`, `status`, `limit` | Without `cursor`: the status table of every worker (capped at 7000 bytes) and a `next_cursor`; a plain read. With `cursor`: only what changed since, and it also recovers a dead first run once and removes worktrees that are safe to remove |
| `wait_workers` | `task_ids`, `mode`, `timeout_ms`, `allow_long_wait`, `emit_progress`, `compact`, `include_events`, `event_limit`, `poll_ms` | Waits until workers settle, 60 seconds at most per call. Returns `timeout_capped` and `termination_reason` |
| `get_worker` | `task_id`, `include`, `max_chars`, `event_limit`, `event_kinds`, `result_limit`, `include_files` | Reads one worker. `include` takes `status` / `result` / `goal` / `events` / `evidence` / `context` / `preflight` / `prompt`; none gives a one-paragraph summary, one gives that part, several give an object keyed by part |
| `get_worker_diff` | `task_id`, `file`, `hunk`, `page_size`, `cursor`, `max_chars`, `paths` | What the worker actually changed. The file index with hunk counts by default; a file's patch paged by `file` + `hunk` / `cursor` |
| `ask_worker` | `task_id`, `question`, `timeout_ms`, `max_chars`, `fresh`, `end` | A side question. The thread is forked into a read-only session with no network and no MCP tools; the worker is untouched |
| `land_worker` | `task_id`, `commit_message`, `onto`, `include_followup_parents`, `commit_messages`, `ignore_acceptance`, `allow_outside_owned` | Cherry-picks the worker's commits onto the branch checked out where it was dispatched. `commit_message` first commits its uncommitted edits as one commit |
| `verify_push` | `task_id`, `remote`, `branch` | Fetches a remote branch and proves the landed commit is reachable. It verifies; it never pushes |
| `cleanup` | `action`, `task_ids`, `project_root`, `plan_id`, `item_ids`, `limit` | `plan`: each worktree's verdict and reason; `apply`: remove the selected SAFE items now; `history`: what was removed |
| `find_works` | `session_id`, `query`, `limit` | Every worker of a session, or a substring search over titles, goals, prompts and last messages |
| `describe_session` | `session_id`, `title`, `note`, `objective`, `default_acceptance`, `approval_state`, `expected_revision` | Records a batch's title, objective, default acceptance and approval state |
| `facts` (opt-in) | `action`, `task_id`, `fact_id`, `query`, `limit`, `cursor`, `scope`, `watched_paths`, `expires_at`, `reason` | `search` / `get` read verified facts; `promote` turns a candidate into a verified fact; `revoke` withdraws one |
| `review` (opt-in) | `action`, `task_id`, `verifier_task_id`, `title`, `verdict`, `reason`, `resolution` | `start` dispatches a read-only, offline verifier; `record` / `resolve` / `get` store the verdict, store how it was closed, read the trail |
| `get_artifact` (opt-in) | `artifact_id`, `max_chars` | Reads one stored evidence artifact |

The grouped arguments:

| Group | Fields |
|---|---|
| `workspace` | `kind` (`git_worktree` default / `read_only_in_place` / `scratch` / `in_place_write`), `base_ref`, `setup` (`links`, `submodules`, `commands`), `in_place_authorization`, `skip_git_repo_check`, `external_outputs` |
| `sandbox` | `mode` (`workspace-write` default / `read-only` / `danger-full-access`), `network_access`, `writable_roots`, `allowed_commands`, `forbid` |
| `context` | `files` (`[{path, sha256?}]`, 20 at most), `contracts` |
| `acceptance` | `commands` (a string, or a list of strings and `{command, report_path, baseline}` objects), `timeout_ms` |
| `limits` | `max_run_ms`, `max_total_ms` |
| `session` | `id`, `title`, `note` |
| `goal` | `objective`, `token_budget` |

Without `followup_of`, `cwd`, `owned_paths` and `goal.objective` are required. A writer must also pass preflight: run `preflight_worker` with `probe_commands` and the same arguments, then give its id as `preflight_id`. `owned_paths` conflicts are reserved at dispatch, the runtime guard checks direct writes, and landing checks the whole diff again.

`acceptance` runs in Bash with `errexit` and `pipefail`: an unhandled failure stops the check, including a failing test in `npm test | tail`. Workers run `node "$AGENT_SUPERVISOR_ACCEPTANCE_CLI"` for the exact supervisor contract instead of retyping checks in an interactive zsh. The self-check opens the supervisor database read-only, so it needs no write access to the state directory. Handle expected failures explicitly with `if` or `||`; a timeout always fails, even when the command exits 0 after termination. Windows requires Git for Windows Bash and reports an error when it is missing. Displayed output is clipped without changing the exit code.

In a repository with `package.json`, acceptance that uses local JavaScript tooling such as `npm`, `pnpm`, `vitest`, `vue-tsc`, `eslint` or `nuxi` is rejected with `workspace_setup_required` unless `workspace.setup` was provided. Dependency preparation is now a runtime gate, not a reminder for the model.

The standard frontend worktree setup is:

```json
{
  "workspace.setup": {
    "links": [{ "path": "node_modules", "source": "node_modules" }],
    "submodules": true,
    "commands": ["npx nuxi prepare"]
  }
}
```

Pass the same setup to `preflight_worker` and the target `create_worker`; otherwise the runtime contracts do not match.

`workspace.setup.links.source` resolves against the dispatch `cwd` and may also be absolute; `path` is always a relative destination inside the worktree. The source must already exist.

`create_worker` with `followup_of` starts from the current parent `worker/<parent>` checkpoint while the parent is unlanded, or the current target HEAD after it has landed; an explicit `workspace.base_ref` takes precedence. Uncommitted parent edits stay with that task, and a missing checkpoint returns `followup_checkpoint_missing`. Review each task's acceptance and diff before calling `land_worker({include_followup_parents: true})` to cherry-pick the chain root first; a failure preserves earlier landings, and the operation can be repeated after fixing the failing task.

When both the worker and run host have exited, the current run's durable `turn.completed` can recover completed status and exit settlement independently of the acceptance verdict. Missing acceptance is marked interrupted and must be rerun before landing; recovery neither removes worktrees nor reruns the worker automatically.

Plain-text reports from schema-free resumes remain candidate facts even after acceptance passes; synthesized empty arrays are not promoted as verified claims.

Chain landing skips commits proven present on the target and ancestors with no changes; `ignore_acceptance` and `allow_outside_owned` apply only to the named leaf, not to its ancestors.

When dispatch omits `goal.token_budget`, the worker must omit `token_budget` entirely. The runtime guard rejects `0`, `1`, `null` and any invented value. If a budget is supplied explicitly, the worker must use that exact positive integer.

Acceptance commands receive `AGENT_SUPERVISOR_TASK_ID`, `AGENT_SUPERVISOR_BASE_COMMIT` and `AGENT_SUPERVISOR_RUN`: the current task, run base and run number, refreshed after rebase/resume.

Structured acceptance entries use `{command, report_path, baseline}`. The baseline contains `identity.base_commit`, `failures` (test_id/kind/signature), and `required`; the report contains complete, identity, failures, executed, skipped, and the current `AGENT_SUPERVISOR_CHECK_ID`. Missing/skipped required tests, reused evidence, and changed failures reject acceptance while preserving the shell exit code. report_path must remain inside the working directory; write reports to an ignored temporary directory so they are not landed.

Landing checks the real diff against owned_paths before committing drafts; only use allow_outside_owned for an explicitly approved exception.

Worker acceptance runs before the dispatcher commits draft edits, so it should validate functionality and tests. Check clean Git status, commit counts and messages after landing. Inspect the failing check and its run before claiming a verdict is stale; a newer report, external test run or manual commit does not replace supervisor acceptance. Route conflicting requirements to the integration owner for revision and fresh acceptance instead of bypassing the gate with a manual cherry-pick.

Session default_acceptance is prepended to local checks; resume uses the latest policy. describe_session returns policy_revision and expected_revision prevents stale edits. waiting_user blocks dispatch/resume until approved. host_goal_sync returns a current-policy /goal command. Replace an active native goal through /goal, or propose the same condition through ProposeGoal for host approval when available. The condition reads the latest session revision and approved scope; MCP does not silently modify or disable the host Stop hook.

Wait defaults to 60 seconds and compact rows; longer requests are capped unless `allow_long_wait: true` explicitly opts in. `requested_timeout_ms`, `timeout_ms` and `timeout_capped` expose the applied budget. Progress requires both `emit_progress` and a client progress token; it does not extend a host's hard timeout. Reattach an existing background wait instead of creating duplicates, and schedule `poll_workers` for long monitoring.

Each run injects the shipped PreToolUse guard: apply_patch checks every target including renames and symlinks; forbid rejects red lines. Shell allows simple reads and explicitly declared sandbox.allowed_commands/acceptance. Declared validation scripts run with dispatcher privileges and may have side effects; this is not a filesystem sandbox for arbitrary programs. Resume/follow-up inherit the policy without changing global hooks. Empty write runs use current output and command evidence and surface no_work; read-only tasks are not empty merely for having no diff.

Workers are not dispatchers. A worker starts with the codex-supervisor MCP server disabled, so it cannot dispatch, resume, cancel or edit another session. Business MCP servers remain available. Side-chat forks disable every MCP server.

A model with no separate `apply_patch` tool (measured with Codex 0.162 + DeepSeek/cc-switch) sends the patch as a shell call: `apply_patch <<'EOF' ... EOF`. The guard accepts that shape and judges every target path with the same owned_paths rule, so such a model can still edit; an unquoted heredoc, or one followed by `&&`/`;`, is refused.

An `sandbox.allowed_commands` entry ending in `*` is a prefix match (so `go test ./internal/*` covers `go test ./internal/service -run TestX`), valid only for a single command without shell metacharacters. An editor worker may also read with grep/sed (without `-i`)/find (without `-exec`/`-delete`)/jq (without `-i`)/awk, the git read subcommands and pure read pipes such as `cmd | head|tail|wc|sort|uniq`; `tee`, redirects and `env` stay refused. The guard is not a filesystem sandbox: a miss only writes inside the worker's own worktree, and land refuses it.

The guard relaxes by workspace shape: a `git_worktree` editor with non-empty `owned_paths` gets only declared commands and simple reads; `read_only_in_place` cannot write or use network; networked research uses `scratch` under `SUPERVISOR_HOME`, never the source directory; `in_place_write` requires explicit authorization, owned paths and acceptance with before/after manifests. A non-Git `workspace-write` request without `workspace.kind` is refused. A worker capsule names its branch and acceptance source without embedding acceptance commands. Repository facts cross checkouts only when canonical `origin`, repository-relative watched paths and base SHA all match; an unrecognized origin leaves them work-scoped. A fact is append-only expired and excluded from a future worker capsule when its base SHA no longer covers the task, a watched path changed, its declared context content hash changed, or its in-place manifest drifted; explicit dependencies provide only delivery summaries.

After reconciliation, poll_workers atomically resumes a dead first lost/no_work/invalid_report run once and returns recovery receipts (an invalid report only re-asks for the bare JSON; it does not redo the work). If the current run has a durable `turn.completed` and only its run host failed to record the exit code, the task is recovered as completed with report and attention evidence preserved instead of being marked lost. Two consecutive no-output/no-command runs with the same fingerprint become `two_stall` and `needs_attention`, never another blind retry; approval, authentication, permission and quota waits are not retried. Final reports use JSON result/verification/not_done. Parsing safely normalizes a single string field into string[] and one missing closing `]`/`}`; fabricated shapes still fail. The report is a summary: invalid_report preserves the completed lifecycle and attention, does not override the same run's acceptance or reviewed diff, and an explicit landing remains possible. Existing history is labelled legacy_text.

context declares up to 20 absolute file paths with optional sha256, within a combined 6000-character budget with contracts; each file is at most 5 MB. Dispatch pins actual hashes and resume refuses drift unless new context is explicitly supplied. Handoffs are limited to 1800 characters/16 lines with a truncation marker; complete contracts and refs remain separate, and inputs grant no write permission.

Declare workspace.external_outputs:[{path,sha256?}] and acceptance for shared writes. Targets are absolute file paths, at most 1 MB each. Current-run before/after hashes and bounded content appear in result/diff as shared_file_already_written_not_cherry_pick; land cannot integrate external files. Targets participate in ownership conflict checks and hook policy; the dispatcher is responsible for validation script side effects.

workspace-write defaults to sandbox.network_access:false; explicitly enable it for ssh/network checks. Resume/follow-up inherit the setting. limits.max_run_ms bounds one run and limits.max_total_ms bounds wall time since dispatch; exceeding either stops the worker and preserves actionable partial results without automatic retry. A wait budget does not change these quotas.

Besides the worktree and the temp directory the sandbox writes the OS cache directory (macOS `~/Library/Caches`, Linux `~/.cache`, Windows `%LOCALAPPDATA%`), the toolchain cache directories that exist under the home directory (`.cargo`, `.npm`, `.yarn`, `.pnpm-store`, `.bun`, `.m2`, `.gradle`, `.nuget`, `.ivy2`, `.bundle`, `.composer`, `.pub-cache`, `.mix`, `.hex`, `.stack`, `.cpanm`, `.deno`, `.conda`, `go/pkg`) Credential directories (`.ssh`, `.gnupg`, `.config`, `.aws`, `.docker`, `.kube`, `.netrc`, `.git-credentials`, `~/Library/Keychains`) are never granted automatically: a dispatch that needs ssh, kubectl, a private registry or a signed commit names the directory in `sandbox.writable_roots` for that run. `SUPERVISOR_NO_AUTO_CACHE_ROOTS=1` turns every automatic cache root off; an explicit `sandbox.writable_roots` still applies. Toolchains that cache there, Go's build cache among them, need no per-language variable and no patch when a new language shows up. Codex refuses a writable root with a symlink component, and such a root fails every command in the worker, so both the cache directory and every declared `sandbox.writable_roots` entry are resolved through realpath first and a root that cannot be resolved to a symlink-free path is dropped. A toolchain that caches elsewhere (`~/.m2`, `~/.gradle`, a vendored mirror) passes `sandbox.writable_roots:[absolute paths]`: existing directories, at most 20, workspace-write only, inherited by resume/follow-up. Read-only reuse needs nothing.

Dispatch checks required hooks/output-schema support (Codex 0.162+); unsupported capability returns settled start_failed. get_worker.native_goal_read distinguishes missing_goal, missing_database, locked and read_error; a read failure is not evidence that no goal exists. Native budget/usage limits need attention. Cleanup preserves ignored artifacts, shared evidence and unresolved attention.

Ownership reservation and task insertion are atomic across MCP dispatch/resume processes; ownership remains reserved during acceptance or exit settlement. Failure to create an isolated Git checkout is explicit and never falls back to executing in the project directory.

Cleanup runs by itself. `poll_workers` with a `cursor` sweeps at most once every 10 minutes, remove the SAFE worktrees and list them under `cleaned`. The rules:

| Situation | Verdict |
|---|---|
| The worker or its acceptance is running, or an active worker depends on it | BLOCKED |
| Landed, the commit still on the target branch, worktree clean | SAFE |
| Finished without changing anything (failed, cancelled, timed out, an empty run) | SAFE |
| Unlanded commits or uncommitted edits | REVIEW during the hold period, SAFE after it |
| The path, branch or Git registration does not match | REVIEW, never handled automatically |

The hold period is 7 days from the moment the worker finished; `AGENT_SUPERVISOR_CLEANUP_HOLD_DAYS` changes it. Before a worktree with uncommitted edits is removed, the edits are committed to `worker/<id>`. Paths linked in by `workspace.setup` and gitignored build output are not edits and are not saved. Branches, tasks, events, JSONL and artifacts are always kept.

After a worktree is gone, `resume_worker`, `land_worker`, `ask_worker` and `get_worker_diff` cut it again from the branch and redo `workspace.setup`, so cleanup never strands unfinished work.

By hand: `cleanup` shows the verdicts and reasons, `cleanup` removes SAFE items at once; from a shell, `codex-supervisor-cleanup --dry-run` and `codex-supervisor-cleanup --apply --plan <plan_id> --item <item_id>`. `AGENT_SUPERVISOR_NO_AUTO_CLEANUP=1` turns the automatic sweep off. A research worker's scratch directory goes after the same hold period.

## What the board shows

| Where | What |
|---|---|
| Left column | One row per session: title, worker count, how many running, last activity. Version and update notice at the bottom |
| Session page | Counts (total / running / done / failed / timed out / lost); while workers run, the command each one is on |
| Worker table | One row per worker: status, title, current command or last report line, duration, files changed, commands run |
| Worker drawer | Seven tabs: overview, report, changes, commands, events, task, side chat |
| Side chat | Ask the worker a question, the way Codex's `/btw` works: its thread is forked into a read-only side session, the running work is untouched. Multi-turn, stoppable, and a page that leaves picks up where it was |

Light and dark follow the system. No external resources.

## The state machine

| `status` | Meaning |
|---|---|
| `queued` | Dispatched, not started |
| `running` | Running. `phase`: `starting → thinking → command → editing → reporting` |
| `completed` | Done |
| `failed` | Non-zero exit, `turn.failed`, spawn failure. `failure.source` / `failure.code` / `failure.retryable` give the cause; a non-zero exit is attributed from stderr to `auth`, `provider`, `runner_config` or `worker_process`, and `failure.detail` is its last stderr line |
| `cancelled` | Stopped by `cancel_worker` |
| `lost` | Worker killed by an outside signal, run process disappeared, or a row whose process never started. `resume_worker` picks it up |
| `timed_out` | `limits.max_run_ms` or `limits.max_total_ms` ran out and the supervisor stopped the worker. Never retried automatically. After a per-run limit, `resume_worker` starts a fresh run clock; after the total limit, continue with `create_worker` and `followup_of`, giving new `limits` |

A terminal state lands in two steps: `turn.completed` sets `completed`, the process exit writes `exit_code`; `wait_workers` returns only after the exit code is in. Windows has no signals, so an outside kill reports as `failed` with an exit code. Native Codex goals: `paused` / `blocked` count as `running` and go to `needs_attention`, `usageLimited` / `budgetLimited` as `failed`.

## Where state lives

`~/.codex-supervisor/` by default:

| File | Content |
|---|---|
| `data/supervisor.sqlite` | `tasks` (one row per work), `task_events`, `sessions`, `side_sessions` / `side_turns` (side chat) |
| `data/crash.log` | Uncaught errors of the MCP server, a run host or the board, one JSON line each. Read it first when every tool call suddenly answers `Connection closed` |
| `data/runs/<taskId>.jsonl` | Raw `codex --json` output. An event over 2 KB (mostly command output) is whole only here, with a clipped copy in `task_events`; `get_worker` with `events` and no `max_chars` reads the full body back from this file, and returns the clipped copy marked `body.missing` when the file is gone |
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
| `AGENT_SUPERVISOR_NO_UPDATE_CHECK` | unset | `1` disables the update check |
| `AGENT_SUPERVISOR_REGISTRY` | `https://registry.npmjs.org` | Registry for the update check and the auto-update |
| `AGENT_SUPERVISOR_UPDATE_TIMEOUT_MS` | `4000` | How long to wait for the registry |
| `AGENT_SUPERVISOR_NO_AUTO_UPDATE` | unset | `1` turns off background updates and only notifies |
| `AGENT_SUPERVISOR_NO_AUTO_CLEANUP` | unset | `1` turns off automatic worktree cleanup; `cleanup` still works |
| `AGENT_SUPERVISOR_CLEANUP_HOLD_DAYS` | `7` | Days unlanded work is kept after its worker finished; `0` keeps nothing |
| `AGENT_SUPERVISOR_SKIP_SKILL_SYNC` | unset | `1` turns the skill sync at server start off |
| `AGENT_SUPERVISOR_SKIP_SETUP` | unset | `1` skips the `postinstall` setup |
| `AGENT_SUPERVISOR_NPM` | unset | npm for the auto-update; default is the one shipped with the running node |
| `AGENT_SUPERVISOR_HANDOFF_TOKEN_THRESHOLD` | `300000` | Native-goal token count that marks a worker `handoff_recommended`; `0` disables the warning |

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

## Windows

- The npm-installed CLI is `codex.cmd`, which Node refuses to spawn directly. The runner steps over it to `node_modules/@openai/codex/bin/codex.js` and runs that with `node`; no `shell: true`, which would leave only the shell killable on cancel.
- Cross-process cancel uses `taskkill /PID <pid> /T /F` for the whole tree, after confirming that pid runs codex.
- Besides `PATH`, `%APPDATA%\npm`, `%LOCALAPPDATA%\pnpm`, `%LOCALAPPDATA%\Volta\bin` and `%ProgramFiles%\nodejs` are probed.


## Updating

Nothing to do by hand. At start the server asks the registry in the background; a newer version is installed by a detached `npm i -g` into the same global path, the running session is untouched and the next session starts on it. Only a copy that `npm i -g` installed is touched; a git checkout or an `npx` copy is left alone. The skill does the same: every start copies it into the existing skill directories, backing up an edited file as `SKILL.md.bak-<timestamp>`.

When the install fails (a global directory that needs sudo) the `update` field says why and `npm install -g codex-supervisor-mcp@latest` by hand still works. Versions up to 0.6.1 only notify; upgrade by hand once and it is automatic from then on. After changing Node versions/install prefixes, setup repairs old package-generated paths and verifies command/args through client read-back. Custom, disabled and project registrations are preserved with a repair warning. To run the setup again: `codex-supervisor-setup` (`--skill-only` / `--mcp-only` / `--dry-run`). Manual registration failures exit nonzero; automatic installs warn without failing npm. A skill write failure does not prevent MCP registration. Set `CLAUDE_BIN` / `CODEX_BIN` for off-PATH CLIs. Skill locations follow `CLAUDE_CONFIG_DIR` / `CODEX_HOME`.
