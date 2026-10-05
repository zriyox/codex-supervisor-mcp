// End-to-end cover for the Windows half of setup.js.
//
// setup-test.js stops at the skill installer, because registering the MCP shells
// out to a client CLI, which leaves the Windows path covered only by hand. That
// is the half most likely to rot: `npm i -g` on Windows produces a `codex.cmd`
// shim that Node refuses to spawn, and nothing on macOS or Linux ever notices if
// the bypass stops working.
//
// The simulation works because a backslash is an ordinary filename character on
// macOS and Linux, so `C:\Users\z\AppData\Roaming\npm\codex.cmd` can be created
// as a single file - and that is exactly the string `path.win32.join` produces
// inside bin-resolver.js. Only process.platform is faked, in a child process.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

if (process.platform === "win32") {
  console.log("setup-windows: skipped on a real Windows host (POSIX filenames required)");
  process.exit(0);
}

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const setupEntry = join(packageRoot, "src", "setup.js");
const serverEntry = join(packageRoot, "src", "mcp-server.js");

// Windows paths, held as single filenames. NPM_PREFIX mirrors the default npm
// global prefix on Windows, which is also what the APPDATA probe looks for.
const APPDATA = String.raw`C:\Users\z\AppData\Roaming`;
const NPM_PREFIX = `${APPDATA}\\npm`;
const CODEX_SHIM = `${NPM_PREFIX}\\codex.cmd`;
const CODEX_ENTRY = `${NPM_PREFIX}\\node_modules\\@openai\\codex\\bin\\codex.js`;
const CLAUDE_SHIM = `${NPM_PREFIX}\\claude.cmd`;
const CLAUDE_ENTRY = `${NPM_PREFIX}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;

const BOOTSTRAP = `Object.defineProperty(process, "platform", { value: "win32" });
await import(process.env.SETUP_ENTRY);
`;

// Stand-in for a client CLI. It records how it was invoked, so a passing test
// proves the shim was stepped over and the registration arguments were right.
const FAKE_CLI = `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.WINSIM_LOG, JSON.stringify(argv) + "\\n");
if (argv[0] === "mcp" && argv[1] === "get") process.exit(1);
process.exit(0);
`;

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

async function makeHost({ withCodexEntry = true, withClaudeEntry = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "supervisor-win-"));
  await mkdir(join(root, "home"), { recursive: true });
  await writeFile(join(root, "bootstrap.mjs"), BOOTSTRAP);
  await writeFile(join(root, CODEX_SHIM), "@ECHO off\r\n");
  if (withCodexEntry) await writeFile(join(root, CODEX_ENTRY), FAKE_CLI);
  if (withClaudeEntry) {
    await writeFile(join(root, CLAUDE_SHIM), "@ECHO off\r\n");
    await writeFile(join(root, CLAUDE_ENTRY), FAKE_CLI);
  }
  return root;
}

// PATH is semicolon-split on win32, so a POSIX PATH would be one bogus entry -
// binDirs exists to make the well-known-directory probe testable on its own.
function runSetup(root, args, { binDirs = [NPM_PREFIX], appData = APPDATA } = {}) {
  return run(process.execPath, [join(root, "bootstrap.mjs"), ...args], {
    cwd: root,
    env: {
      ...process.env,
      PATH: binDirs.join(";"),
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      APPDATA: appData,
      HOME: join(root, "home"),
      SETUP_ENTRY: pathToFileURL(setupEntry).href,
      WINSIM_LOG: join(root, "calls.log")
    }
  });
}

const readCalls = async (root) =>
  (await readFile(join(root, "calls.log"), "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

await check("win32 bypasses the .cmd shim and actually registers the MCP server", async () => {
  const root = await makeHost();
  const { stdout } = await runSetup(root, ["--target", "codex"]);

  assert.match(stdout, /mcp\s+Codex: registered/, stdout);
  const add = (await readCalls(root)).find((argv) => argv[0] === "mcp" && argv[1] === "add");
  assert.ok(add, "codex mcp add must be invoked");
  assert.deepEqual(add, ["mcp", "add", "codex-supervisor", "--", process.execPath, serverEntry]);
  assert.equal(
    existsSync(join(root, "home", ".codex", "skills", "codex-supervisor", "SKILL.md")),
    true,
    "the skill must land in the Codex skill directory"
  );
});

await check("win32 finds the CLI under %APPDATA%\\npm when PATH has nothing", async () => {
  const root = await makeHost({ withCodexEntry: true });
  const { stdout } = await runSetup(root, ["--target", "codex", "--mcp-only"], {
    binDirs: []
  });
  assert.match(stdout, /mcp\s+Codex: registered/, stdout);
});

await check("win32 registers Claude through its native claude.exe, not the shim", async () => {
  const root = await makeHost({ withClaudeEntry: true });
  const { stderr, stdout } = await runSetup(root, ["--target", "claude", "--dry-run"]);
  assert.match(stdout, /would run claude mcp add -s user codex-supervisor --/, stdout);
  assert.doesNotMatch(stderr, /shell shim/, stderr);
});

await check("win32 reports an un-bypassable shim instead of spawning it", async () => {
  const root = await makeHost({ withCodexEntry: false });
  const { stderr } = await runSetup(root, ["--target", "codex"]).then(
    (result) => result,
    (error) => error
  );
  assert.match(stderr, /shell shim/, stderr);
  assert.match(stderr, /CODEX_BIN/, stderr);
  assert.equal(existsSync(join(root, "calls.log")), false, "the shim must never be executed");
});

console.log(`\n${passed} windows setup checks passed`);
