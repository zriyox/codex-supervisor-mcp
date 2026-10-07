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
import { dirname, join, resolve } from "node:path";
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
export function installedPackage() {
  const info = { name: PACKAGE_NAME, version: packageJson.version, path: packageRoot, integrity: null, commit: null, source: "unknown" };
  const lockPath = join(packageRoot, "..", ".package-lock.json");
  if (existsSync(lockPath)) {
    try {
      const lock = JSON.parse(readFileSync(lockPath, "utf8"));
      const entry = lock.packages?.[`node_modules/${PACKAGE_NAME}`];
      if (entry?.integrity) {
        info.integrity = entry.integrity;
        info.source = "npm";
      }
    } catch {
      // unreadable lock: fall through, provenance stays unknown
    }
  }
  if (!info.integrity && existsSync(join(packageRoot, ".git"))) {
    try {
      info.commit = execFileSync("git", ["-C", packageRoot, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
      info.source = "git";
    } catch {
      // not a usable checkout
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
export function updateNotice(result) {
  if (!result || !result.notice) return null;
  return {
    update_available: result.update_available,
    installed_version: result.installed.version,
    latest_version: result.latest?.version ?? null,
    integrity_matches: result.integrity_matches,
    install_command: result.install_command,
    notice: result.notice
  };
}
