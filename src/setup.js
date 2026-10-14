#!/usr/bin/env node
// Installs the codex-supervisor skill into the skill directories of the agent
// clients found on this machine, and registers the MCP server with them.
//
// Runs automatically after a *global* npm install (`postinstall`), and can be
// invoked directly to repair or re-run setup:
//
//   npx codex-supervisor-setup
//   codex-supervisor-setup --target claude --force
//
// Set CODEX_SUPERVISOR_SKIP_SETUP=1 to opt out of the automatic run.
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  defaultBinDirs,
  findBinaryPath,
  resolveCommand,
  shimMessage
} from "./bin-resolver.js";

const run = promisify(execFile);

import { installSkill, skillRoots } from "./skill-sync.js";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const serverEntry = join(packageRoot, "src", "mcp-server.js");

const MCP_NAME = "codex-supervisor";
const CLIENT_TIMEOUT_MS = 60_000;

// A client is "present" when its binary is on PATH or its skill directory
// already exists. We never invent directories for clients the user does not run.
// `npmEntry` lets bin-resolver.js step over a Windows .cmd shim by pointing at
// the package's own entry point. `binEnv` is the override named in the repair
// message when that fails (only Codex has one).
const SKILL_ROOTS = skillRoots();
const CLIENTS = [
  {
    ...SKILL_ROOTS.claude,
    binary: "claude",
    binEnv: "CLAUDE_BIN",
    npmEntry: { pkg: "@anthropic-ai/claude-code", bin: "bin/claude.exe" }
  },
  { ...SKILL_ROOTS.agents, binary: null },
  {
    ...SKILL_ROOTS.codex,
    binary: "codex",
    binEnv: "CODEX_BIN",
    npmEntry: { pkg: "@openai/codex", bin: "bin/codex.js" }
  }
];

function parseArgs(argv) {
  const options = {
    auto: false,
    quiet: false,
    dryRun: false,
    force: false,
    skills: true,
    mcp: true,
    targets: null,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--auto") {
      options.auto = true;
    } else if (arg === "--quiet") {
      options.quiet = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg === "--skill-only") {
      options.mcp = false;
    } else if (arg === "--mcp-only") {
      options.skills = false;
    } else if (arg === "--target") {
      options.targets = String(argv[index + 1] ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.targets?.includes("all")) options.targets = null;
  return options;
}

function printHelp() {
  console.log(`Usage: codex-supervisor-setup [options]

Installs the codex-supervisor skill and registers the MCP server with the
Claude Code and Codex clients found on this machine.

Options:
  --target <list>   Comma-separated: claude, agents, codex, all. Default: detected.
  --skill-only      Only install the skill; do not touch MCP config.
  --mcp-only        Only register the MCP server; do not install the skill.
  --force           Overwrite skill files without keeping a .bak copy.
  --dry-run         Print what would happen and change nothing.
  --quiet           Only print warnings and errors.
  --auto            Postinstall mode: global installs only, never fails.
  -h, --help        Show help.

Environment:
  CODEX_SUPERVISOR_SKIP_SETUP=1   Skip the automatic postinstall run entirely.
`);
}

// PATH first, then the well-known global bin directories (shared with the
// worker runner so both look in the same places), then the version managers,
// whose node bin directory is only discoverable by listing.
const EXTRA_BIN_DIRS = defaultBinDirs();

const VERSION_MANAGER_ROOTS = [
  [join(homedir(), ".nvm", "versions", "node"), join("bin")],
  [join(homedir(), ".fnm", "node-versions"), join("installation", "bin")]
];

function versionManagerBinDirs() {
  const dirs = [];
  for (const [root, suffix] of VERSION_MANAGER_ROOTS) {
    if (!existsSync(root)) continue;
    let entries = [];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      dirs.push(join(root, entry, suffix));
    }
  }
  return dirs;
}

// Turns a client binary into a spawnable target, or null when the client is not
// installed. On Windows a bare `codex` resolves to `codex.cmd`, which Node
// refuses to execute directly, so the resolver hands back `cmd` + `prefixArgs`
// instead (see bin-resolver.js).
function locateClient(binary) {
  if (!binary) return null;
  const client = CLIENTS.find((entry) => entry.binary === binary);
  const configured = client?.binEnv && process.env[client.binEnv]?.trim();
  const path = findBinaryPath(configured || binary, {
    extraDirs: [...EXTRA_BIN_DIRS, ...versionManagerBinDirs()]
  });
  if (!path) return null;
  const target = resolveCommand(path, { npmEntry: CLIENTS.find((c) => c.binary === binary)?.npmEntry });
  return { path, cmd: target.cmd, args: target.prefixArgs, shim: target.shim };
}

function runClient(target, args, options = {}) {
  return run(target.cmd, [...target.args, ...args], { windowsHide: true, ...options });
}

function selectClients(options) {
  return CLIENTS.filter((client) => {
    if (options.targets && !options.targets.includes(client.id)) return false;
    if (client.binary && locateClient(client.binary)) return true;
    return existsSync(client.skillRoot) || (client.binary && existsSync(dirname(client.skillRoot)));
  });
}

async function registeredMcp(target, client) {
  try {
    const { stdout } = await runClient(target, ["mcp", "get", MCP_NAME, ...(client.id === "codex" ? ["--json"] : [])], { timeout: CLIENT_TIMEOUT_MS });
    if (client.id === "codex") {
      const value = JSON.parse(stdout);
      const transport = value.transport ?? value;
      return { command: transport.command, args: transport.args ?? [], env: transport.env ?? {}, cwd: transport.cwd, enabled: value.enabled !== false, userScope: true };
    }
    const command = stdout.match(/^\s*Command: (.+)$/m)?.[1]?.trim();
    const args = stdout.match(/^\s*Args: (.*)$/m)?.[1]?.trim();
    const environment = stdout.split(/\n[ \t]*Environment:[ \t]*\r?\n/)[1]?.split(/(?:^|\n)[ \t]*To remove/)[0]?.trim();
    return { command, args: args ? [args] : [], env: environment ? { custom: true } : {}, enabled: !/Status:.*Disabled/i.test(stdout), userScope: /Scope: User config/.test(stdout) };
  } catch (error) {
    const message = `${error.stdout ?? ""}${error.stderr ?? ""}${error.message}`;
    if (/not found|no mcp server|could not find|does not exist/i.test(message)) return null;
    throw new Error(`cannot read ${client.label} MCP registration: ${error.message.split("\n")[0]}`);
  }
}

async function registerMcp(client, options, log, warn) {
  const target = locateClient(client.binary);
  if (!target) {
    warn(`mcp     ${client.label}: no ${client.binary} CLI found; install it or set ${client.binEnv} to its executable, then run "codex-supervisor-setup"`);
    return "failed";
  }
  if (target.shim) {
    warn(
      `mcp     ${client.label}: ${shimMessage(client.binary, target.path, client.binEnv)}`
    );
    return "failed";
  }
  let previous;
  try { previous = options.dryRun ? null : await registeredMcp(target, client); }
  catch (error) { warn(`mcp     ${client.label}: ${error.message}`); return "failed"; }
  if (previous) {
    const same = previous.userScope && previous.command === process.execPath && previous.args.length === 1 && previous.args[0] === serverEntry;
    if (same && previous.enabled) { log(`mcp     ${client.label}: already registered at this installation`); return "unchanged"; }
    const managed = previous.userScope && previous.enabled && !previous.cwd && Object.keys(previous.env).length === 0
      && previous.args.length === 1 && /(?:^|[\\/])codex-supervisor-mcp[\\/]src[\\/]mcp-server\.js$/.test(previous.args[0]);
    if (!managed) {
      warn(`mcp     ${client.label}: existing custom, disabled or project registration preserved; inspect "${client.binary} mcp get ${MCP_NAME}" before replacing it`);
      return "failed";
    }
  }

  const args =
    client.id === "claude"
      ? ["mcp", "add", "-s", "user", MCP_NAME, "--", process.execPath, serverEntry]
      : ["mcp", "add", MCP_NAME, "--", process.execPath, serverEntry];

  if (options.dryRun) {
    if (previous) log(`mcp     ${client.label}: would repair stale package registration`);
    log(`mcp     ${client.label}: would run ${client.binary} ${args.join(" ")}`);
    return "would-register";
  }
  try {
    if (previous) await runClient(target, client.id === "claude" ? ["mcp", "remove", "-s", "user", MCP_NAME] : ["mcp", "remove", MCP_NAME], { timeout: CLIENT_TIMEOUT_MS });
    await runClient(target, args, { timeout: CLIENT_TIMEOUT_MS });
    const actual = await registeredMcp(target, client);
    if (!actual || actual.command !== process.execPath || actual.args.length !== 1 || actual.args[0] !== serverEntry || !actual.enabled) throw new Error("registration command succeeded but read-back does not match this package");
    log(`mcp     ${client.label}: ${previous ? "repaired" : "registered"}`);
    return "registered";
  } catch (error) {
    if (previous) {
      try {
        await runClient(target, client.id === "claude" ? ["mcp", "remove", "-s", "user", MCP_NAME] : ["mcp", "remove", MCP_NAME], { timeout: CLIENT_TIMEOUT_MS }).catch(() => {});
        const restore = client.id === "claude" ? ["mcp", "add", "-s", "user", MCP_NAME, "--", previous.command, ...previous.args] : ["mcp", "add", MCP_NAME, "--", previous.command, ...previous.args];
        await runClient(target, restore, { timeout: CLIENT_TIMEOUT_MS });
      } catch (restoreError) { warn(`mcp     ${client.label}: restoring the original registration failed (${restoreError.message.split("\n")[0]})`); }
    }
    warn(
      `mcp     ${client.label}: registration failed (${error.message.split("\n")[0]}) ` +
        `- run "codex-supervisor-setup" once ${client.label} is working`
    );
    return "failed";
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    return 0;
  }

  if (options.auto) {
    if (process.env.CODEX_SUPERVISOR_SKIP_SETUP) {
      return 0;
    }
    if (process.env.npm_config_global !== "true") {
      return 0;
    }
  }

  const log = options.quiet ? () => {} : (line) => console.log(line);
  const warn = (line) => console.error(line);
  const clients = selectClients(options);
  const missingTargets = options.targets?.filter((id) => !clients.some((client) => client.id === id)) ?? [];
  if (missingTargets.length) warn(`setup: requested client(s) not detected: ${missingTargets.join(", ")}; install the CLI or set CLAUDE_BIN / CODEX_BIN`);

  if (clients.length === 0) {
    warn("setup: no Claude Code / Codex client detected; MCP was not registered. Install a client, then run codex-supervisor-setup.");
    return options.targets?.length && !options.auto ? 1 : 0;
  }

  log(`setup: ${options.dryRun ? "dry run against" : "configuring"} ${clients.map((client) => client.label).join(", ")}`);

  if (options.skills) {
    for (const client of clients) {
      await installSkill(client, options, log);
    }
  }
  let failures = missingTargets.length;
  if (options.mcp) {
    for (const client of clients.filter((client) => client.binary)) {
      if (await registerMcp(client, options, log, warn) === "failed") failures += 1;
    }
  }

  log(failures ? `setup: ${failures} MCP registration(s) require repair` : "setup: done");
  return failures && !options.auto ? 1 : 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  const message = `setup: ${error.message}`;
  if (process.argv.includes("--auto")) {
    console.error(`${message} (ignored)`);
  } else {
    console.error(message);
    process.exitCode = 1;
  }
}
