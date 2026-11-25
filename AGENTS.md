# Repository guidelines

For any agent working in this repository. CONTRIBUTING.md has the human version.

## Layout

Five layers and the run host; a layer imports only the ones below it. `docs/architecture.md` has the rules and the path of one dispatch. ESLint enforces them.

```
src/interface/           MCP tools (mcp/tools, one module per job), CLIs (bin), board API (web)
src/run-host/            the detached process that owns one run: launch, streams, finalize
src/app/                 use cases: dispatch, resume, followup, landing, rebase, cleanup-plan, acceptance, side-chat
src/runners/codex/       the Codex CLI: arguments, event parsing, native goals, the tool guard
src/infra/               store/ (SQLite, one module per record), git.js, process.js, worktree.js, update/
src/domain/              pure rules: status, ownership, worker report, prompt, truncation
src/mcp-server.js        four-line entry; client registrations point at this path
skills/codex-supervisor/ the skill a model loads; ships inside the package
test/edge/*.test.js      node --test, each file its own temp SUPERVISOR_HOME
test/scripts/*-test.js   older checks, run first by npm test
test/fixtures/fake-codex.js  replays codex event streams by FAKE_CODEX_SCENARIO
test/e2e/real-flow.mjs   an installed package against a real CLI; not in npm test
```

## Commands

```bash
npm test                 # the whole suite; about two minutes
npm run lint             # layer boundaries and size limits
node --test test/edge/<name>.test.js
npm run test:real        # real codex CLI, needs a logged-in codex
npm run web:build        # runs by itself before npm publish
```

## Rules

- `npm test` green before every commit. Never `npm version` or `npm publish` while CI is red or still running; check `gh run list` first.
- Tests use a temp `SUPERVISOR_HOME` and `CODEX_BIN=test/fixtures/fake-codex.js`. No real Codex, no network, no git identity, no writable `/tmp` assumed. CI's Linux and Windows runners have none of those.
- Never run `npm i -g` or `codex-supervisor-setup` against the user's machine unless asked.
- A tool, argument or behaviour change is done when the skill, both READMEs (tool table and count), both `docs/reference*.md` (arguments and edge cases) and a test say the same thing. The skill ships inside the package: a skill change reaches users only with a release.
- The skill is read by a model at the start of a session: rules, not a tour. Cut before adding. README tool rows are two sentences at most.
- One change per commit. The message says why, in prose; `git log` shows the register.
