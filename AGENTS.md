# Repository guidelines

For any agent working in this repository. CONTRIBUTING.md has the human version.

## Layout

```
src/mcp-server.js        the 19 MCP tools; everything else is called from here
src/codex-runner.js      spawns codex exec, one worktree per worker, writes the task row
src/task-store.js        sqlite: tasks, task_events, sessions, side_sessions / side_turns
src/event-parser.js      codex --json events -> status / phase / error on the row
src/worktree.js          what a worker changed (readTaskChanges, readWorktreeDiff)
src/landing.js           land_codex_worker
src/side-chat.js         ask_codex_worker and the board's side chat (codex exec fork)
src/auto-update*.js      background npm i -g; skill-sync.js copies the bundled skill
src/web-server.js        the board; UI source in web/, built to web/dist
skills/codex-supervisor/ the skill a model loads; ships inside the package
test/edge/*.test.js      node --test, each file its own temp SUPERVISOR_HOME
src/*-test.js            older checks, run first by npm test
src/test-fixtures/fake-codex.js  replays codex event streams by FAKE_CODEX_SCENARIO
```

## Commands

```bash
npm test                 # the whole suite; under a minute; run before every commit
node --test test/edge/<name>.test.js
npm run test:real        # real codex CLI, needs a logged-in codex
npm run web:build        # runs by itself before npm publish
```

## Rules

- `npm test` green before every commit. Never `npm version` or `npm publish` while CI is red or still running; check `gh run list` first.
- Tests use a temp `SUPERVISOR_HOME` and `CODEX_BIN=src/test-fixtures/fake-codex.js`. No real Codex, no network, no git identity, no writable `/tmp` assumed. CI's Linux and Windows runners have none of those.
- Never run `npm i -g` or `codex-supervisor-setup` against the user's machine unless asked.
- A tool, argument or behaviour change is done when the skill, both READMEs (tool table and count) and a test say the same thing. The skill ships inside the package: a skill change reaches users only with a release.
- The skill is read by a model at the start of a session: rules, not a tour. Cut before adding. README tool rows are two sentences at most.
- One change per commit. The message says why, in prose; `git log` shows the register.
