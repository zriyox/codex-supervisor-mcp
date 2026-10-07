// Is the running copy the latest published one? Asked once per MCP start and
// again every few hours, answered from the npm registry, cached on disk so a
// burst of MCP processes does not turn into a burst of registry calls.
//
// Two things are compared. The version, against the registry's `latest`
// dist-tag. And the tarball integrity: a global install records the
// integrity of what npm unpacked in node_modules/.package-lock.json, and
// the registry says what the integrity of that version should be. A
// mismatch means the files on disk are not the published build.
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dataDir } from "./paths.js";

const PACKAGE_NAME = "codex-supervisor-mcp";
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));

export const INSTALL_COMMAND = `npm i -g ${PACKAGE_NAME}@latest`;
const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const CACHE_TTL_MS = 60 * 60 * 1000;
const cachePath = join(dataDir, "update-check.json");

function registryUrl() {
  return (process.env.CODEX_SUPERVISOR_REGISTRY?.trim() || DEFAULT_REGISTRY).replace(/\/+$/, "");
}

function timeoutMs() {
  const raw = Number(process.env.CODEX_SUPERVISOR_UPDATE_TIMEOUT_MS ?? 4000);
  return Number.isFinite(raw) && raw > 0 ? raw : 4000;
}

export function updateCheckDisabled() {
  return /^(1|true|yes)$/i.test(process.env.CODEX_SUPERVISOR_NO_UPDATE_CHECK?.trim() ?? "");
}

// "1.2.3" -> [1,2,3]; a prerelease tag sorts below the release it precedes.
export function parseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(text ?? "").trim());
  if (!match) return null;
  return { parts: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4] ?? null };
}

export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i += 1) {
    if (left.parts[i] !== right.parts[i]) return left.parts[i] < right.parts[i] ? -1 : 1;
  }
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  return left.prerelease < right.prerelease ? -1 : 1;
}

// What is actually on disk: the version from package.json, plus whichever
// provenance is available - npm's recorded integrity for a global install,
// the HEAD commit for a git checkout.
// A copy that npx fetched lives under npm's cache (.../_npx/<hash>/...).
// npx resolves `latest` on every start, so such a copy must never be
// auto-installed over a global one.
export function isNpxPath(path) {
  return String(path).split(/[\\/]/).includes("_npx");
}

// Who put this copy here. Pure, so it can be tested on made-up paths.
//   git  - a checkout (also what `npm link` resolves to, since node follows
//          the symlink before import.meta.url is set)
//   npx  - npm's exec cache; npx refreshes it by itself
//   npm  - a directory npm installed, global or project-local (the
//          auto-updater tells those apart with `npm root -g` before writing)
export function installSource(root, { exists = existsSync } = {}) {
  if (exists(join(root, ".git"))) return "git";
  if (isNpxPath(root)) return "npx";
  if (basename(dirname(root)) === "node_modules") return "npm";
  return "unknown";
}

export function installedPackage() {
  const info = { name: PACKAGE_NAME, version: packageJson.version, path: packageRoot, integrity: null, commit: null, source: installSource(packageRoot) };
  // A project-local install records the package's integrity in the hidden
  // lockfile one level up. A global install has no such record (each global
  // package is its own root), so integrity stays null and only the version
  // is compared.
  const lockPath = join(packageRoot, "..", ".package-lock.json");
  if (info.source === "npm" && existsSync(lockPath)) {
    try {
      const lock = JSON.parse(readFileSync(lockPath, "utf8"));
      const entry = lock.packages?.[`node_modules/${PACKAGE_NAME}`];
      if (entry?.integrity) info.integrity = entry.integrity;
    } catch {
      // unreadable lock: integrity stays unknown
    }
  }
  if (info.source === "git") {
    try {
      info.commit = execFileSync("git", ["-C", packageRoot, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      // a checkout without a usable git: still a checkout
    }
  }
  return info;
}

async function fetchRegistry() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  try {
    const response = await fetch(`${registryUrl()}/${PACKAGE_NAME}`, {
      signal: controller.signal,
      headers: { accept: "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8" }
    });
    if (!response.ok) throw new Error(`registry answered ${response.status}`);
    const body = await response.json();
    const latestVersion = body?.["dist-tags"]?.latest;
    if (!latestVersion || !parseVersion(latestVersion)) throw new Error("registry reply has no usable dist-tags.latest");
    const dist = body.versions?.[latestVersion]?.dist ?? {};
    return {
      latest: {
        version: latestVersion,
        integrity: dist.integrity ?? null,
        shasum: dist.shasum ?? null,
        published_at: body.time?.[latestVersion] ?? null
      },
      versions: Object.fromEntries(
        Object.entries(body.versions ?? {}).map(([version, meta]) => [version, { integrity: meta?.dist?.integrity ?? null }])
      )
    };
  } finally {
    clearTimeout(timer);
  }
}

async function readCache() {
  try {
    return JSON.parse(await readFile(cachePath, "utf8"));
  } catch {
    return null;
  }
}

async function writeCache(payload) {
  try {
    await mkdir(dataDir, { recursive: true });
    await writeFile(cachePath, JSON.stringify(payload));
  } catch {
    // a cache that cannot be written only costs a registry call next time
  }
}

// Pure: given what is installed and what the registry said, what to tell.
export function evaluateUpdate(installed, registry, { source, error }) {
  const cmp = registry ? compareVersions(installed.version, registry.latest.version) : null;
  const updateAvailable = cmp !== null && cmp < 0;
  const expected = registry?.versions?.[installed.version]?.integrity ?? null;
  const integrityMatches = installed.integrity && expected ? installed.integrity === expected : null;
  let notice = null;
  if (updateAvailable) {
    notice = `codex-supervisor-mcp ${installed.version} is installed but ${registry.latest.version} is published. Run \`${INSTALL_COMMAND}\` and restart the MCP client.`;
  } else if (integrityMatches === false) {
    notice = `The installed codex-supervisor-mcp ${installed.version} does not match the published tarball (integrity differs). Reinstall with \`${INSTALL_COMMAND}\`.`;
  }
  return {
    checked_at: new Date().toISOString(),
    source,
    error: error ?? null,
    installed: { version: installed.version, integrity: installed.integrity, commit: installed.commit, source: installed.source, path: installed.path },
    latest: registry?.latest ?? null,
    update_available: updateAvailable,
    integrity_matches: integrityMatches,
    install_command: INSTALL_COMMAND,
    notice
  };
}

let inflight = null;

// The full answer. `force` skips the on-disk cache. Never throws: a registry
// that is down yields source: "offline" with the reason in `error`.
export async function checkForUpdate({ force = false } = {}) {
  if (updateCheckDisabled()) {
    return { ...evaluateUpdate(installedPackage(), null, { source: "disabled", error: null }), disabled: true };
  }
  if (inflight) return inflight;
  inflight = (async () => {
    const installed = installedPackage();
    if (!force) {
      const cached = await readCache();
      const age = cached?.checked_at ? Date.now() - Date.parse(cached.checked_at) : Number.POSITIVE_INFINITY;
      if (cached?.registry && age >= 0 && age < CACHE_TTL_MS && cached.registry_url === registryUrl()) {
        return evaluateUpdate(installed, cached.registry, { source: "cache", error: null });
      }
    }
    try {
      const registry = await fetchRegistry();
      await writeCache({ checked_at: new Date().toISOString(), registry_url: registryUrl(), registry });
      return evaluateUpdate(installed, registry, { source: "registry", error: null });
    } catch (error) {
      const cached = await readCache();
      if (cached?.registry && cached.registry_url === registryUrl()) {
        return evaluateUpdate(installed, cached.registry, { source: "stale-cache", error: error.message });
      }
      return evaluateUpdate(installed, null, { source: "offline", error: error.message });
    }
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

// The small object that rides along in tool results. Null when there is
// nothing to say, so the common case costs no bytes.
// `autoUpdate` is the auto-update record (see auto-update.js); when it says
// the install is already under way or done, the notice stops asking the user
// to run npm and says what to do instead: start a new session.
export function updateNotice(result, autoUpdate = null) {
  if (!result || !result.notice) return null;
  const field = {
    update_available: result.update_available,
    installed_version: result.installed.version,
    latest_version: result.latest?.version ?? null,
    integrity_matches: result.integrity_matches,
    install_command: result.install_command,
    notice: result.notice
  };
  if (result.update_available && autoUpdate && autoUpdate.version === field.latest_version) {
    const name = `${PACKAGE_NAME} ${field.latest_version}`;
    if (autoUpdate.state === "done") {
      field.install_command = null;
      field.notice = `${name} has been installed in the background; this session still runs ${field.installed_version}. Start a new session (restart the MCP client) to use it.`;
    } else if (autoUpdate.state === "started" || autoUpdate.state === "running") {
      field.install_command = null;
      field.notice = `${name} is being installed in the background; this session still runs ${field.installed_version}. The next session starts on it once the install finishes.`;
    } else if (autoUpdate.state === "failed") {
      field.notice = `${field.notice} (automatic install failed: ${autoUpdate.reason ?? "unknown"})`;
    }
    field.auto_update = { state: autoUpdate.state, version: autoUpdate.version, ...(autoUpdate.reason ? { reason: autoUpdate.reason } : {}) };
  } else if (result.update_available && result.installed.source === "npx") {
    field.install_command = null;
    field.notice = `${PACKAGE_NAME} ${field.latest_version} is published; this npx-started session runs ${field.installed_version}. The next session fetches the new one by itself.`;
  }
  return field;
}
