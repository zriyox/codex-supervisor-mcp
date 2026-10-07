# For agents working in this repository

Read CONTRIBUTING.md first; this file is the part that is easy to get wrong.

- `npm test` before every commit. A commit with a red suite is not a commit.
- Never `npm publish` or `npm version` while CI is red or still running. Check `gh run list` first. Nothing is urgent enough to skip this.
- Never run `npm i -g` or `codex-supervisor-setup` against the user's own machine unless asked; a test that needs an install uses a temporary `SUPERVISOR_HOME` and `HOME`.
- Tests run with `SUPERVISOR_HOME` pointed at a temp directory and `CODEX_BIN` pointed at `src/test-fixtures/fake-codex.js`. Keep it that way: no real Codex, no network, no git identity assumed.
- A tool, argument or behaviour change is not done until the skill, both READMEs and a test say the same thing.
- The skill is read by a model at the start of a session. Write it as rules, not as a tour; cut before adding.
- Commit messages: why, in plain prose, no bullet soup. Look at `git log` for the register.
