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
import { mkdir, readFile, writeFile } from "node:fs/promises";
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

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const skillSource = join(packageRoot, "skills", "codex-supervisor", "SKILL.md");
const serverEntry = join(packageRoot, "src", "mcp-server.js");

const SKILL_NAME = "codex-supervisor";
const MCP_NAME = "codex-supervisor";
const CLIENT_TIMEOUT_MS = 60_000;

// A client is "present" when its binary is on PATH or its skill directory
// already exists. We never invent directories for clients the user does not run.
// `npmEntry` lets bin-resolver.js step over a Windows .cmd shim by pointing at
// the package's own entry point. `binEnv` is the override named in the repair
// message when that fails (only Codex has one).
const CLIENTS = [
  {
    id: "claude",
    label: "Claude Code",
    skillRoot: join(homedir(), ".claude", "skills"),
    binary: "claude",
    binEnv: null,
    npmEntry: { pkg: "@anthropic-ai/claude-code", bin: "bin/claude.exe" }
  },
  { id: "agents", label: "~/.agents", skillRoot: join(homedir(), ".agents", "skills"), binary: null },
  {
    id: "codex",
    label: "Codex",
    skillRoot: join(homedir(), ".codex", "skills"),
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
  const path = findBinaryPath(binary, {
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
    return existsSync(client.skillRoot);
  });
}

async function installSkill(client, options, log) {
  const destination = join(client.skillRoot, SKILL_NAME, "SKILL.md");
  const source = await readFile(skillSource, "utf8");

  if (existsSync(destination)) {
    const current = await readFile(destination, "utf8");
    if (current === source) {
      log(`skill   ${client.label}: up to date`);
      return "unchanged";
    }
    if (!options.force) {
      const backup = `${destination}.bak-${Date.now()}`;
      if (options.dryRun) {
        log(`skill   ${client.label}: would back up to ${backup} and overwrite`);
        return "would-update";
      }
      await writeFile(backup, current);
    }
    if (options.dryRun) {
      log(`skill   ${client.label}: would overwrite`);
      return "would-update";
    }
    await writeFile(destination, source);
    log(`skill   ${client.label}: updated`);
    return "updated";
  }

  if (options.dryRun) {
    log(`skill   ${client.label}: would install to ${destination}`);
    return "would-install";
  }
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, source);
  log(`skill   ${client.label}: installed`);
  return "installed";
}

async function mcpAlreadyRegistered(target, options) {
  if (options.dryRun) return false;
  try {
    await runClient(target, ["mcp", "get", MCP_NAME], { timeout: CLIENT_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

async function registerMcp(client, options, log, warn) {
  const target = locateClient(client.binary);
  if (!target) {
    log(`mcp     ${client.label}: skipped (no ${client.binary} found)`);
    return "skipped";
  }
  if (target.shim) {
    warn(
      `mcp     ${client.label}: ${shimMessage(client.binary, target.path, client.binEnv)}`
    );
    return "failed";
  }
  if (await mcpAlreadyRegistered(target, options)) {
    log(`mcp     ${client.label}: already registered`);
    return "unchanged";
  }

  const args =
    client.id === "claude"
      ? ["mcp", "add", "-s", "user", MCP_NAME, "--", process.execPath, serverEntry]
      : ["mcp", "add", MCP_NAME, "--", process.execPath, serverEntry];

  if (options.dryRun) {
    log(`mcp     ${client.label}: would run ${client.binary} ${args.join(" ")}`);
    return "would-register";
  }
  try {
    await runClient(target, args, { timeout: CLIENT_TIMEOUT_MS });
    log(`mcp     ${client.label}: registered`);
    return "registered";
  } catch (error) {
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

  if (clients.length === 0) {
    log("setup: no Claude Code / Codex client detected; nothing to do");
    return 0;
  }

  log(`setup: ${options.dryRun ? "dry run against" : "configuring"} ${clients.map((client) => client.label).join(", ")}`);

  if (options.skills) {
    for (const client of clients) {
      await installSkill(client, options, log);
    }
  }
  if (options.mcp) {
    for (const client of clients.filter((client) => client.binary)) {
      await registerMcp(client, options, log, warn);
    }
  }

  log("setup: done");
  return 0;
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
