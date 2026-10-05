// Turns a CLI name into something Node can actually spawn.
//
// Why this exists: on Windows npm installs a CLI as a `codex.cmd` / `codex.ps1`
// shim rather than an executable, and since the CVE-2024-27980 hardening in
// Node 18.20 / 20.12 `spawn` with shell:false refuses to run one (EINVAL), so
// the worker never starts. `shell: true` would "fix" that at the cost of the
// kill semantics this project depends on: the shell becomes the child, so
// cancelling a task kills cmd.exe and leaves the real Codex process running,
// which wedges the state machine in `running`.
//
// So instead of shelling out, resolve a spawnable target: a real .exe, or -
// for the npm shim case - the package's own entry point, run under node.
//
// Platform, env, filesystem probe and node path are all injectable, so the
// win32 branch is unit-testable from macOS and Linux.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** Windows extensions Node/libuv can hand straight to CreateProcess. */
const DIRECT_EXTS = new Set([".exe", ".com"]);
/** Windows extensions that need an interpreter - the npm-shim case. */
const SHIM_EXTS = new Set([".cmd", ".bat", ".ps1"]);
/** Fallback when PATHEXT is unset, matching the Windows default. */
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";
/** Extensions that need node in front of them on every platform. */
const JS_EXTS = new Set([".js", ".cjs", ".mjs"]);

/**
 * Well-known global install directories, probed after PATH. A CLI installed with
 * a custom npm prefix or a version manager is usually absent from a
 * non-interactive PATH, and without this it would look "not installed" even
 * though the user runs it every day. The Windows entries are env-derived, so
 * they simply drop out elsewhere.
 *
 * @param {Object} [options]
 * @param {Record<string, string|undefined>} [options.env]
 * @param {string} [options.home]
 * @returns {string[]}
 */
export function defaultBinDirs(options = {}) {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const dirs = [
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".local", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".volta", "bin"),
    path.join(home, "Library", "pnpm"),
    "/opt/homebrew/bin",
    "/usr/local/bin"
  ];
  for (const [variable, ...segments] of [
    ["APPDATA", "npm"], // npm global prefix on Windows
    ["LOCALAPPDATA", "pnpm"],
    ["LOCALAPPDATA", "Volta", "bin"],
    ["ProgramFiles", "nodejs"] // nvm-windows and the official installer
  ]) {
    const root = env[variable]?.trim();
    if (root) dirs.push(path.join(root, ...segments));
  }
  return dirs;
}

const isWindows = (platform) => platform === "win32";
const pathImpl = (platform) => (isWindows(platform) ? path.win32 : path.posix);
const listSeparator = (platform) => (isWindows(platform) ? ";" : ":");

/**
 * @typedef {Object} NpmEntryHint
 * @property {string} pkg  npm package name, e.g. "@openai/codex"
 * @property {string} bin  entry path inside the package, e.g. "bin/codex.js"
 */

/**
 * @typedef {Object} SpawnTarget
 * @property {string} cmd  first argument to pass to spawn
 * @property {string[]} prefixArgs  args to prepend before the caller's own argv
 * @property {boolean} shim  true when the only match needs a shell we refuse to
 *   use - the caller should fail with an actionable message instead of spawning
 */

/**
 * Locate a CLI on PATH (plus optional extra directories) and return its real
 * path, or null. On win32 the PATHEXT ladder is applied, so a bare `codex`
 * resolves to `codex.cmd`; everywhere else the bare name is joined onto each
 * PATH entry. A name carrying a path separator is probed as-is.
 *
 * @param {string} binary
 * @param {Object} [options]
 * @param {string} [options.platform]
 * @param {Record<string, string|undefined>} [options.env]
 * @param {(p: string) => boolean} [options.exists]
 * @param {string[]} [options.extraDirs]  well-known dirs to probe after PATH
 * @returns {string|null}
 */
export function findBinaryPath(binary, options = {}) {
  if (!binary) return null;
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const extraDirs = options.extraDirs ?? [];
  const p = pathImpl(platform);

  if (binary.includes("/") || binary.includes("\\")) return exists(binary) ? binary : null;

  const fromPath = String(env.PATH ?? env.Path ?? "")
    .split(listSeparator(platform))
    .filter(Boolean);
  const dirs = [...fromPath, ...extraDirs];
  const suffixes = isWindows(platform)
    ? String(env.PATHEXT || DEFAULT_PATHEXT)
        .split(";")
        .filter(Boolean)
        .map((ext) => ext.toLowerCase())
    : [""];

  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const candidate = p.join(dir, binary + suffix);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Resolve a command name into a spawnable target.
 *
 * A JS entry point (`.js` / `.cjs` / `.mjs`) is run under node on every
 * platform, because a script is not something either kernel can spawn on its
 * own: Windows refuses outright, and POSIX only manages it while the shebang
 * and the executable bit survive - which a checkout or a copy can drop. This
 * matters for `CODEX_BIN`, whose natural value is the npm package's own entry
 * point (`node_modules/@openai/codex/bin/codex.js`) - the same file the shim
 * bypass produces.
 *
 * Pass-through cases (behaviour identical to a bare `spawn(name, argv)`):
 *   - any other name containing a path separator - an explicit path is the
 *     caller's business, and the tests rely on this
 *   - any non-win32 platform - macOS and Linux behaviour must not change
 *   - win32 with no PATH match - preserve the ordinary ENOENT
 *
 * @param {string} name
 * @param {Object} [options]
 * @param {string} [options.platform]
 * @param {Record<string, string|undefined>} [options.env]
 * @param {(p: string) => boolean} [options.exists]
 * @param {string} [options.nodePath]
 * @param {NpmEntryHint} [options.npmEntry]  enables the shim bypass
 * @returns {SpawnTarget}
 */
export function resolveCommand(name, options = {}) {
  const passthrough = { cmd: name, prefixArgs: [], shim: false };
  if (typeof name !== "string" || !name) return passthrough;

  const platform = options.platform ?? process.platform;
  const nodePath = options.nodePath ?? process.execPath;

  if (JS_EXTS.has(pathImpl(platform).extname(name).toLowerCase())) {
    return { cmd: nodePath, prefixArgs: [name], shim: false };
  }

  if (!isWindows(platform)) return passthrough;

  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const bypass = (shimPath) => npmBypass(shimPath, options.npmEntry, exists, nodePath);

  const dirs = String(env.PATH ?? env.Path ?? "")
    .split(";")
    .filter(Boolean);
  const exts = String(env.PATHEXT || DEFAULT_PATHEXT)
    .split(";")
    .filter(Boolean);

  // An explicitly named shim - `CODEX_BIN=codex.cmd`, or a full path to one.
  // Handled before the separator pass-through below, because passing it through
  // spawns a shim Node cannot execute and then tells the user to set CODEX_BIN,
  // which is circular advice for someone who just did.
  const namedExt = path.win32.extname(name).toLowerCase();
  if (SHIM_EXTS.has(namedExt)) {
    // A bare shim NAME still needs locating; only a path-bearing one is already
    // located, and a global install's entry point lives beside the shim.
    const located =
      name.includes("/") || name.includes("\\") ? name : (findOnPath(name, dirs, exists) ?? name);
    return bypass(located) ?? { cmd: located, prefixArgs: [], shim: true };
  }

  // Any other explicit path (absolute or relative) is already a resolved target.
  if (name.includes("/") || name.includes("\\")) return passthrough;

  // FIRST MATCH WINS, in PATH order then PATHEXT order - the same precedence
  // libuv and `where` apply. Preferring a real .exe from a LATER directory would
  // silently run a different install than the one the user's own shell picks.
  /** @type {string|null} */
  let firstShim = null;
  for (const dir of dirs) {
    for (const raw of exts) {
      // PATHEXT is conventionally UPPERCASE while npm writes `codex.cmd`.
      // Windows is case-insensitive either way, but the lowercase form matches
      // the file as it actually sits on disk, which keeps error messages honest.
      const ext = raw.toLowerCase();
      const candidate = path.win32.join(dir, name + ext);
      if (!exists(candidate)) continue;
      // A real executable is spawnable as-is.
      if (DIRECT_EXTS.has(ext)) return { cmd: candidate, prefixArgs: [], shim: false };
      if (!SHIM_EXTS.has(ext)) continue;
      const viaNode = bypass(candidate);
      if (viaNode) return viaNode;
      // No entry point behind it - a broken or partial install. Keep scanning:
      // anything usable further down PATH beats failing outright when a working
      // install exists. The first shim is still what gets REPORTED if nothing
      // usable turns up, since that is the one the user believes they run.
      if (firstShim === null) firstShim = candidate;
    }
  }

  if (firstShim === null) return passthrough;
  return { cmd: firstShim, prefixArgs: [], shim: true };
}

/**
 * One-line explanation for a `shim: true` resolution, so every caller says the
 * same thing.
 * @param {string} name  the command that was looked up
 * @param {string} shimPath  the shim that was found
 * @param {string} envVar  the override the user can set, e.g. "CODEX_BIN"
 * @returns {string}
 */
export function shimMessage(name, shimPath, envVar) {
  return (
    `${name} only resolved to a shell shim (${shimPath}), which Node cannot execute directly. ` +
    `Set ${envVar} to the real executable, or reinstall ${name} so a .exe is on PATH.`
  );
}

/**
 * Find an exact filename on PATH. No extension is appended.
 * @param {string} file
 * @param {string[]} dirs
 * @param {(p: string) => boolean} exists
 * @returns {string|null}
 */
function findOnPath(file, dirs, exists) {
  for (const dir of dirs) {
    const candidate = path.win32.join(dir, file);
    if (exists(candidate)) return candidate;
  }
  return null;
}

/**
 * Turn an npm shim into a directly spawnable target, or null when there is no
 * entry point behind it. The shim itself is never executed.
 *
 * Two layouts are probed, because both put a `.cmd` on a Windows machine:
 *   - global: <prefix>\codex.cmd -> <prefix>\node_modules\<pkg>\<bin>
 *   - local:  <root>\node_modules\.bin\codex.cmd -> <root>\node_modules\<pkg>\<bin>
 *
 * A native entry (`bin/claude.exe`) is spawned directly; a JS entry gets node in
 * front of it.
 *
 * @param {string} shimPath
 * @param {NpmEntryHint|undefined} npmEntry
 * @param {(p: string) => boolean} exists
 * @param {string} nodePath
 * @returns {SpawnTarget|null}
 */
function npmBypass(shimPath, npmEntry, exists, nodePath) {
  if (!npmEntry?.pkg || !npmEntry?.bin) return null;
  const dir = path.win32.dirname(shimPath);
  const roots = [dir];
  // npm puts a locally installed CLI's shim in node_modules/.bin, one level below the package.
  if (path.win32.basename(dir).toLowerCase() === ".bin") {
    roots.push(path.win32.dirname(path.win32.dirname(dir)));
  }
  for (const root of roots) {
    const entry = path.win32.join(root, "node_modules", npmEntry.pkg, npmEntry.bin);
    if (!exists(entry)) continue;
    if (DIRECT_EXTS.has(path.win32.extname(entry).toLowerCase())) {
      return { cmd: entry, prefixArgs: [], shim: false };
    }
    return { cmd: nodePath, prefixArgs: [entry], shim: false };
  }
  return null;
}
