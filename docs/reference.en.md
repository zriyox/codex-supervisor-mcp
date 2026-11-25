# Reference

The [README](../README.en.md) covers getting started. Every tool argument, where the guard and acceptance draw their lines, which directories the sandbox opens, and the full list of environment variables are here.

## Tools

Thirty-nine.

| Tool | Arguments | What it does |
|---|---|---|
| `check_workers` | none | Report newly settled runs, actionable failures and active-thread handoff reminders once per run; never cancel or replace a live worker for its token count. Recover a new-format first `lost`, `no_work` or `invalid_report` run once; unchanged state is quiet and a host-scheduled loop with a distinct observer ID supports reconnecting |
| `overview_delta` | `cursor` | Main-thread incremental view: counters, changed summaries, short attention reason / next action and next_cursor; no prompt, diff, event or capsule history |
| `check_acceptance` | `cwd`, `acceptance`, `baseRef`, `timeoutMs` | Execute supplied checks before dispatch, without creating a worker or proving completion; warns that failure-count greps do not establish an approved failure list or required execution |
| `preflight_codex_worker` | `cwd`, `workspaceKind`, `inPlaceAuthorization`, `workspaceSetup`, `ownedPaths`, `probeCommands`, `baseRef`, `sandbox`, `allowedCommands`, `context`, `contracts`, `networkAccess`, `writableRoots` | Run a short probe worker under the exact workspace/base/sandbox/guard contract intended for the later worker; wait for `get_worker_preflight` to report passed before dispatch |
| `get_worker_preflight` | `task_id` | Read probe command evidence and the immutable runtime contract hash |
| `create_codex_worker` | `task`, `cwd`, `workspaceKind`, `inPlaceAuthorization`, `workspaceSetup`, **`ownedPaths`**, **`goal`**, `preflight_id`, `forbid`, `allowedCommands`, `context`, `contracts`, `externalOutputs`, `networkAccess`, `writableRoots`, `maxRunMs`, `maxTotalMs`, `acceptance`, `acceptanceTimeoutMs`, `session_id`, `session_title`, `session_note`, `dependsOn`, `baseRef`, `sandbox`, `model`, `reasoningEffort`, `title`, `skipGitRepoCheck` | Git defaults to an isolated worktree. A non-Git write must choose `scratch`, or an authorized `in_place_write` with paths and acceptance. `workspaceSetup` prepares dependencies before the worker starts; when `preflight_id` is present its complete runtime contract must match. |
| `create_codex_followup_worker` | `task_id`, `followup_prompt`, `session_id`, `session_title`, `title`, `cwd`, `sandbox`, `model`, `ownedPaths`, `forbid`, `allowedCommands`, `context`, `contracts`, `externalOutputs`, `networkAccess`, `writableRoots`, `workspaceKind`, `workspaceSetup`, `goal`, `baseRef`, `acceptance` | A fresh session inherits the parent's current branch commit before landing, or the current target HEAD after landing; explicit `baseRef` takes precedence. Parent drafts are not copied; `preflight_id`, `dependsOn` and `skipGitRepoCheck` are unsupported. |
| `resume_codex_worker` | `task_id`, `prompt`, `rebaseOnto`, `acceptance`, `context` | Continue the same Codex conversation; `thread_id` stays. When the native goal is still active or its state database cannot prove completion, the resume omits the output schema for that turn to avoid `ActiveTurnOutputSchemaMismatch`. `rebaseOnto` first moves the worktree onto the project's newer commit (stash, skip integrated patches, replay new commits, unstash); a conflict puts it back and does not start the worker |
| `wait_codex_workers` | `task_ids`, `mode` (any/all), `timeoutMinutes`, `timeoutMs`, `allowLongWait`, `pollMs`, `compact`, `emitProgress`, `includeEvents`, `eventLimit`, `eventMaxChars`, `eventKinds` | Wait for terminal states with a call budget capped at 60 seconds unless the caller explicitly sets `allowLongWait: true` after verifying its client timeout. Returns requested/effective budgets, `timeout_capped` and a termination reason; `compact` gives one row per worker and `emitProgress` optionally sends progress notifications |
| `get_orchestration_overview` | `status`, `limit` | Every worker in one table, capped at 7000 bytes. Carries `version` and `update` |
| `get_worker_result` | `task_id`, `limit`, `maxChars`, `includeFiles` | The worker's own report, clipped past 6000 bytes with `truncated` and the size to ask for. `acceptance` is whether the supervisor's own checks passed, `verification` the commands the worker ran with exit codes, `base_behind` how far main has moved (`behind` is `null` with a note when `contains_base` is false, meaning the directory switched lines) |
| `get_worker_diff` | `task_id`, `file`, `hunk`, `pageSize`, `cursor`, `maxChars`, `paths` | What the worker actually changed. The default response is a complete file/hunk index. Select one file and page hunks with `hunk` or `cursor`; `maxChars` without `file` keeps the legacy bounded full-diff mode |
| `ask_codex_worker` | `task_id`, `question`, `timeoutMs`, `maxChars`, `fresh`, `end` | Ask the worker on the side. Its thread is forked into a read-only session with no network and no MCP tools; the worker itself is untouched. A resumed worker gets a new fork by itself, `fresh` forces one, `end` deletes it |
| `land_codex_worker` | `task_id`, `onto`, `commitMessage`, `includeFollowupParents`, `commitMessages`, `ignoreAcceptance`, `allowOutsideOwned` | Cherry-pick the worker's `codex/<id>` commits onto the current branch of the dispatch directory: clean target only, a conflict rolls back, a failed acceptance is refused. A malformed report summary no longer blocks an explicit landing when acceptance and the reviewed diff are sound. `commitMessage` first commits the current worker's uncommitted edits as one commit. `includeFollowupParents` lands the follow-up chain root first and `commitMessages` supplies a distinct checkpoint message for any task in that chain; `ignoreAcceptance` lands anyway |
| `verify_delivery_push` | `task_id`, `remote`, `branch` | Fetch a remote branch and prove landed_head is reachable; records push_verified; never pushes or deploys |
| `cleanup_plan` | `task_ids`, `project_root` | Create a 15-minute SAFE / REVIEW / BLOCKED plan with reasons, fingerprints and an estimate of reclaimable space. Landed or unchanged work is SAFE; unlanded work is REVIEW during its hold period, with the date it ends |
| `apply_cleanup` | `plan_id`, `item_ids` | Remove the selected SAFE items now. Each is assessed again and its fingerprint checked; uncommitted edits are committed to `codex/<id>` first. Keeps the branch, task, events, JSONL and artifacts |
| `cleanup_history` | `task_id`, `limit` | Read cleanup decisions and applied removals; never deletes anything |
| `get_worker_summary` | `task_id` | One paragraph: goal, status, changes, last command and message |
| `get_codex_worker_status` | `task_id`, `includePrompt`, `promptMaxChars` | One worker in detail |
| `get_codex_worker_events` | `task_id`, `limit`, `maxChars`, `kinds` | The raw event stream |
| `get_context_snapshot_meta` | `task_id` | Worker-only context snapshot metadata: fact IDs, token count and excluded categories, never capsule text |
| `get_fact` | `fact_id` | Read one historical fact version and its `effective_state`; revocation and automatic expiry retain the original version |
| `search_worker_facts` | `task_id`, `query`, `limit`, `cursor` | Search only verified facts scoped to the current work, explicit dependencies and path-matched repository facts; returns coverage and next_cursor, never raw history |
| `get_worker_evidence` | `task_id`, `limit` | Bounded event metadata and retained artifact IDs for one worker; select an artifact or event explicitly for detail |
| `get_artifact` | `artifact_id`, `maxChars` | Read one supervisor-managed evidence artifact without expanding a worker capsule into main context |
| `promote_worker_fact` | `fact_id`, `scope`, `watchedPaths`, `expiresAt` | Explicitly promote a candidate to a new verified fact after main-thread review; repo scope requires watched paths |
| `revoke_worker_fact` | `fact_id`, `reason` | Append a revocation version and audit event without overwriting the original; the fact is excluded from search and future capsules |
| `create_independent_verifier` | `task_id`, `title` | Create a fresh read-only, no-network verifier for a settled worker; it receives the objective and current worktree, never the target report or candidate facts |
| `record_independent_finding` | `verifier_task_id`, `verdict`, `reason` | Persist an independent passes/fails/inconclusive finding with a subject event and retained evidence artifact |
| `resolve_independent_finding` | `verifier_task_id`, `resolution` | Record how a finding was resolved without deleting the finding or evidence |
| `get_independent_review` | `verifier_task_id` | Read the persistent subject/verifier/finding/resolution relation |
| `get_worker_goal` | `task_id` | The goal recorded at dispatch plus the native Codex goal (tokens, time) |
| `list_codex_workers` | `status`, `includeHistory`, `includeDetails` | List workers, active ones by default |
| `get_session_works` | `session_id` | Every worker of one session. The way back after a main-thread restart |
| `describe_session` | `session_id`, `title`, `note`, `objective`, `default_acceptance`, `approval_state`, `expected_revision` | Record a title and note for a session |
| `search_works` | `query`, `limit` | Substring search over title / goal / prompt / last_message, newest first |
| `check_for_update` | `force` | Ask the registry for a newer version |
| `cancel_codex_worker` | `task_id` | Stop a worker. Falls back to the pid across processes, after confirming that pid runs codex |

Two fields are required by the MCP schema: `ownedPaths` and `goal.objective`. A writer must also pass the workflow preflight gate described above; the schema keeps `preflight_id` optional for old clients, which is a compatibility escape hatch, not the normal path. `ownedPaths` overlap is reserved at dispatch, the runtime guard checks direct file writes, and landing checks the complete diff.

`acceptance` runs in Bash with `errexit` and `pipefail`: an unhandled failure stops the check, including a failing test in `npm test | tail`. Workers run `node "$CODEX_SUPERVISOR_ACCEPTANCE_CLI"` for the exact supervisor contract instead of retyping checks in an interactive zsh. The self-check opens the supervisor database read-only, so it needs no write access to the state directory. Handle expected failures explicitly with `if` or `||`; a timeout always fails, even when the command exits 0 after termination. Windows requires Git for Windows Bash and reports an error when it is missing. Displayed output is clipped without changing the exit code.

In a repository with `package.json`, acceptance that uses local JavaScript tooling such as `npm`, `pnpm`, `vitest`, `vue-tsc`, `eslint` or `nuxi` is rejected with `workspace_setup_required` unless `workspaceSetup` was provided. Dependency preparation is now a runtime gate, not a reminder for the model.

The standard frontend worktree setup is:

```json
{
  "workspaceSetup": {
    "links": [{ "path": "node_modules", "source": "node_modules" }],
    "submodules": true,
    "commands": ["npx nuxi prepare"]
  }
}
```

Pass the same setup to `preflight_codex_worker` and the target `create_codex_worker`; otherwise the runtime contracts do not match.

`workspaceSetup.links.source` resolves against the dispatch `cwd` and may also be absolute; `path` is always a relative destination inside the worktree. The source must already exist.

`create_codex_followup_worker` starts from the current parent `codex/<parent>` checkpoint while the parent is unlanded, or the current target HEAD after it has landed; an explicit `baseRef` takes precedence. Uncommitted parent edits stay with that task, and a missing checkpoint returns `followup_checkpoint_missing`. Review each task's acceptance and diff before calling `land_codex_worker({includeFollowupParents: true})` to cherry-pick the chain root first; a failure preserves earlier landings, and the operation can be repeated after fixing the failing task.

When both the worker and run host have exited, the current run's durable `turn.completed` can recover completed status and exit settlement independently of the acceptance verdict. Missing acceptance is marked interrupted and must be rerun before landing; recovery neither removes worktrees nor reruns the worker automatically.

Plain-text reports from schema-free resumes remain candidate facts even after acceptance passes; synthesized empty arrays are not promoted as verified claims.

Chain landing skips commits proven present on the target and ancestors with no changes; `ignoreAcceptance` and `allowOutsideOwned` apply only to the named leaf, not to its ancestors.

When dispatch omits `goal.tokenBudget`, the worker must omit `token_budget` entirely. The runtime guard rejects `0`, `1`, `null` and any invented value. If a budget is supplied explicitly, the worker must use that exact positive integer.

Acceptance commands receive `CODEX_SUPERVISOR_TASK_ID`, `CODEX_SUPERVISOR_BASE_COMMIT` and `CODEX_SUPERVISOR_RUN`: the current task, run base and run number, refreshed after rebase/resume.

Structured acceptance entries use `{command, reportPath, baseline}`. The baseline contains `identity.base_commit`, `failures` (test_id/kind/signature), and `required`; the report contains complete, identity, failures, executed, skipped, and the current `CODEX_SUPERVISOR_CHECK_ID`. Missing/skipped required tests, reused evidence, and changed failures reject acceptance while preserving the shell exit code. reportPath must remain inside the working directory; write reports to an ignored temporary directory so they are not landed.

Landing checks the real diff against ownedPaths before committing drafts; only use allowOutsideOwned for an explicitly approved exception.

Worker acceptance runs before the dispatcher commits draft edits, so it should validate functionality and tests. Check clean Git status, commit counts and messages after landing. Inspect the failing check and its run before claiming a verdict is stale; a newer report, external test run or manual commit does not replace supervisor acceptance. Route conflicting requirements to the integration owner for revision and fresh acceptance instead of bypassing the gate with a manual cherry-pick.

Session default_acceptance is prepended to local checks; resume uses the latest policy. describe_session returns policy_revision and expected_revision prevents stale edits. waiting_user blocks dispatch/resume until approved. host_goal_sync returns a current-policy /goal command. Replace an active native goal through /goal, or propose the same condition through ProposeGoal for host approval when available. The condition reads the latest session revision and approved scope; MCP does not silently modify or disable the host Stop hook.

Wait defaults to 60 seconds and compact rows; longer requests are capped unless `allowLongWait: true` explicitly opts in. `requested_timeout_ms`, `timeout_ms` and `timeout_capped` expose the applied budget. Progress requires both `emitProgress` and a client progress token; it does not extend a host's hard timeout. Reattach an existing background wait instead of creating duplicates, and schedule `check_workers` for long monitoring.

Each run injects the shipped PreToolUse guard: apply_patch checks every target including renames and symlinks; forbid rejects red lines. Shell allows simple reads and explicitly declared allowedCommands/acceptance. Declared validation scripts run with dispatcher privileges and may have side effects; this is not a filesystem sandbox for arbitrary programs. Resume/follow-up inherit the policy without changing global hooks. Empty write runs use current output and command evidence and surface no_work; read-only tasks are not empty merely for having no diff.

Workers are not dispatchers. A worker starts with the codex-supervisor MCP server disabled, so it cannot dispatch, resume, cancel or edit another session. Business MCP servers remain available. Side-chat forks disable every MCP server.

A model with no separate `apply_patch` tool (measured with Codex 0.162 + DeepSeek/cc-switch) sends the patch as a shell call: `apply_patch <<'EOF' ... EOF`. The guard accepts that shape and judges every target path with the same ownedPaths rule, so such a model can still edit; an unquoted heredoc, or one followed by `&&`/`;`, is refused.

An `allowedCommands` entry ending in `*` is a prefix match (so `go test ./internal/*` covers `go test ./internal/service -run TestX`), valid only for a single command without shell metacharacters. An editor worker may also read with grep/sed (without `-i`)/find (without `-exec`/`-delete`)/jq (without `-i`)/awk, the git read subcommands and pure read pipes such as `cmd | head|tail|wc|sort|uniq`; `tee`, redirects and `env` stay refused. The guard is not a filesystem sandbox: a miss only writes inside the worker's own worktree, and land refuses it.

The guard relaxes by workspace shape: a `git_worktree` editor with non-empty `ownedPaths` gets only declared commands and simple reads; `read_only_in_place` cannot write or use network; networked research uses `scratch` under `SUPERVISOR_HOME`, never the source directory; `in_place_write` requires explicit authorization, owned paths and acceptance with before/after manifests. A non-Git `workspace-write` request without `workspaceKind` is refused. A worker capsule names its branch and acceptance source without embedding acceptance commands. Repository facts cross checkouts only when canonical `origin`, repository-relative watched paths and base SHA all match; an unrecognized origin leaves them work-scoped. A fact is append-only expired and excluded from a future worker capsule when its base SHA no longer covers the task, a watched path changed, its declared context content hash changed, or its in-place manifest drifted; explicit dependencies provide only delivery summaries.

After reconciliation, check_workers atomically resumes a dead first lost/no_work/invalid_report run once and returns recovery receipts (an invalid report only re-asks for the bare JSON; it does not redo the work). If the current run has a durable `turn.completed` and only its run host failed to record the exit code, the task is recovered as completed with report and attention evidence preserved instead of being marked lost. Two consecutive no-output/no-command runs with the same fingerprint become `two_stall` and `needs_attention`, never another blind retry; approval, authentication, permission and quota waits are not retried. Final reports use JSON result/verification/not_done. Parsing safely normalizes a single string field into string[] and one missing closing `]`/`}`; fabricated shapes still fail. The report is a summary: invalid_report preserves the completed lifecycle and attention, does not override the same run's acceptance or reviewed diff, and an explicit landing remains possible. Existing history is labelled legacy_text.

context declares up to 20 absolute file paths with optional sha256, within a combined 6000-character budget with contracts; each file is at most 5 MB. Dispatch pins actual hashes and resume refuses drift unless new context is explicitly supplied. Handoffs are limited to 1800 characters/16 lines with a truncation marker; complete contracts and refs remain separate, and inputs grant no write permission.

Declare externalOutputs:[{path,sha256?}] and acceptance for shared writes. Targets are absolute file paths, at most 1 MB each. Current-run before/after hashes and bounded content appear in result/diff as shared_file_already_written_not_cherry_pick; land cannot integrate external files. Targets participate in ownership conflict checks and hook policy; the dispatcher is responsible for validation script side effects.

workspace-write defaults to networkAccess:false; explicitly enable it for ssh/network checks. Resume/follow-up inherit the setting. maxRunMs bounds one run and maxTotalMs bounds wall time since dispatch; exceeding either stops the worker and preserves actionable partial results without automatic retry. A wait budget does not change these quotas.

Besides the worktree and the temp directory the sandbox writes the OS cache directory (macOS `~/Library/Caches`, Linux `~/.cache`, Windows `%LOCALAPPDATA%`), the toolchain cache directories that exist under the home directory (`.cargo`, `.npm`, `.yarn`, `.pnpm-store`, `.bun`, `.m2`, `.gradle`, `.nuget`, `.ivy2`, `.bundle`, `.composer`, `.pub-cache`, `.mix`, `.hex`, `.stack`, `.cpanm`, `.deno`, `.conda`, `go/pkg`) Credential directories (`.ssh`, `.gnupg`, `.config`, `.aws`, `.docker`, `.kube`, `.netrc`, `.git-credentials`, `~/Library/Keychains`) are never granted automatically: a dispatch that needs ssh, kubectl, a private registry or a signed commit names the directory in `writableRoots` for that run. `SUPERVISOR_NO_AUTO_CACHE_ROOTS=1` turns every automatic cache root off; an explicit `writableRoots` still applies. Toolchains that cache there, Go's build cache among them, need no per-language variable and no patch when a new language shows up. Codex refuses a writable root with a symlink component, and such a root fails every command in the worker, so both the cache directory and every declared `writableRoots` entry are resolved through realpath first and a root that cannot be resolved to a symlink-free path is dropped. A toolchain that caches elsewhere (`~/.m2`, `~/.gradle`, a vendored mirror) passes `writableRoots:[absolute paths]`: existing directories, at most 20, workspace-write only, inherited by resume/follow-up. Read-only reuse needs nothing.

Dispatch checks required hooks/output-schema support (Codex 0.162+); unsupported capability returns settled start_failed. get_worker_goal.native_goal_read distinguishes missing_goal, missing_database, locked and read_error; a read failure is not evidence that no goal exists. Native budget/usage limits need attention. Cleanup preserves ignored artifacts, shared evidence and unresolved attention.

Ownership reservation and task insertion are atomic across MCP dispatch/resume processes; ownership remains reserved during acceptance or exit settlement. Failure to create an isolated Git checkout is explicit and never falls back to executing in the project directory.

Cleanup runs by itself. `check_workers` and `overview_delta` sweep at most once every 10 minutes, remove the SAFE worktrees and list them under `cleaned`. The rules:

| Situation | Verdict |
|---|---|
| The worker or its acceptance is running, or an active worker depends on it | BLOCKED |
| Landed, the commit still on the target branch, worktree clean | SAFE |
| Finished without changing anything (failed, cancelled, timed out, an empty run) | SAFE |
| Unlanded commits or uncommitted edits | REVIEW during the hold period, SAFE after it |
| The path, branch or Git registration does not match | REVIEW, never handled automatically |

The hold period is 7 days from the moment the worker finished; `CODEX_SUPERVISOR_CLEANUP_HOLD_DAYS` changes it. Before a worktree with uncommitted edits is removed, the edits are committed to `codex/<id>`. Paths linked in by `workspaceSetup` and gitignored build output are not edits and are not saved. Branches, tasks, events, JSONL and artifacts are always kept.

After a worktree is gone, `resume_codex_worker`, `land_codex_worker`, `ask_codex_worker` and `get_worker_diff` cut it again from the branch and redo `workspaceSetup`, so cleanup never strands unfinished work.

By hand: `cleanup_plan` shows the verdicts and reasons, `apply_cleanup` removes SAFE items at once; from a shell, `codex-supervisor-cleanup --dry-run` and `codex-supervisor-cleanup --apply --plan <plan_id> --item <item_id>`. `CODEX_SUPERVISOR_NO_AUTO_CLEANUP=1` turns the automatic sweep off. A research worker's scratch directory goes after the same hold period.

## What the board shows

| Where | What |
|---|---|
| Left column | One row per session: title, worker count, how many running, last activity. Version and update notice at the bottom |
| Session page | Counts (total / running / done / failed / lost); while workers run, the command each one is on |
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
| `CODEX_SUPERVISOR_NO_AUTO_UPDATE` | unset | `1` turns off background updates and only notifies |
| `CODEX_SUPERVISOR_NO_AUTO_CLEANUP` | unset | `1` turns off automatic worktree cleanup; `apply_cleanup` still works |
| `CODEX_SUPERVISOR_CLEANUP_HOLD_DAYS` | `7` | Days unlanded work is kept after its worker finished; `0` keeps nothing |
| `CODEX_SUPERVISOR_SKIP_SKILL_SYNC` | unset | `1` turns the skill sync at server start off |
| `CODEX_SUPERVISOR_SKIP_SETUP` | unset | `1` skips the `postinstall` setup |
| `CODEX_SUPERVISOR_NPM` | unset | npm for the auto-update; default is the one shipped with the running node |
| `CODEX_SUPERVISOR_HANDOFF_TOKEN_THRESHOLD` | `300000` | Native-goal token count that marks a worker `handoff_recommended`; `0` disables the warning |

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
