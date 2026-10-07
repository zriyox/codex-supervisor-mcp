# Security

Supported: the latest published version on npm. Older versions get no fixes; the server updates itself in the background, so staying current costs nothing.

Report a vulnerability through GitHub's private advisory form: https://github.com/zriyox/codex-supervisor-mcp/security/advisories/new. Do not open a public issue for it.

Include the version (`check_for_update` prints it), the platform, how the server is launched, and steps to reproduce. Expect a first reply within a week.

What this software does on your machine, so you can judge a report: it spawns `codex exec` processes with the sandbox you pass at dispatch (`workspace-write` by default), creates git worktrees under `~/.codex-supervisor/worktrees/`, writes state to `~/.codex-supervisor/data/`, asks the npm registry for the latest version, and installs it with `npm i -g` when newer. `CODEX_SUPERVISOR_NO_UPDATE_CHECK=1` and `CODEX_SUPERVISOR_NO_AUTO_UPDATE=1` turn the last two off.
