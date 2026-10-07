# Contributing

[中文](CONTRIBUTING.md)

## Running it

```bash
npm ci
npm test            # fake-codex replay, under a minute, no Codex account needed
npm run test:real   # the real codex CLI; needs a logged-in codex on this machine
```

Node 22.13.0 or newer. Board changes run under `npm run web:dev`.

## Changing code

- One change per commit. The message says why, not what; the diff says what.
- A behaviour change comes with a test. Worker-side behaviour is replayed through a scenario in `src/test-fixtures/fake-codex.js`, never through the real Codex.
- Tests must not depend on the machine: no git identity, `PATH`, network or writable `/tmp` as a given. CI's Linux and Windows runners have no git identity; that is how 0.7.0 broke.
- All three platforms must pass. Windows pitfalls are the `.cmd` shim, path separators and the lack of signals; see "Windows" in the README.
- A new tool or a changed argument updates three things together: `skills/codex-supervisor/SKILL.md`, the tool table and tool count in both READMEs. The skill ships inside the package, so a skill change reaches users only with a release.
- A README tool row is two sentences at most. Mechanics and pitfalls go into the skill or "Known limitations".

## Releasing

Only with all four CI jobs green, in this order:

```bash
npm version <x.y.z> -m "codex-supervisor-mcp %s"
npm publish                                   # prepublishOnly builds the board and runs the whole suite
git push origin main --tags
gh release create v<x.y.z> --notes "..."
```

Then install it on a machine that never had it (`npm i -g codex-supervisor-mcp@<x.y.z>`) and confirm postinstall put the skill and the registration in place.

## Filing an issue

Include the platform, `node -v`, `codex --version`, the output of `check_for_update`, and the smallest steps that reproduce it. For a worker problem, attach the last 20 lines of `data/runs/<taskId>.jsonl`.
