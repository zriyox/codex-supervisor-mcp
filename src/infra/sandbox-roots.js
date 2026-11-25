import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, posix, resolve, win32 } from "node:path";

function pathJoin(platform, ...parts) {
  return (platform === "win32" ? win32 : posix).join(...parts);
}

// Codex refuses a writable root that contains a symlink component: the worker
// does not merely lose that directory, every command in it fails with
// UnsupportedOperation("writable root ... contains symlink component ...").
// ~/.cache is a symlink on the machine this was found on, so every candidate is
// resolved to a symlink-free absolute path before the sandbox sees it, and a
// candidate that cannot be resolved that way is dropped instead of poisoning
// the whole run. allow_symlinked_codex_home does not help here: it only covers
// writable roots under CODEX_HOME.
export function symlinkComponents(target) {
  const links = [];
  let current = resolve(target);
  for (;;) {
    try { if (lstatSync(current).isSymbolicLink()) links.push(current); }
    catch { /* a missing component is reported by the caller */ }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return links;
}

export function resolveWritableRoot(candidate) {
  if (typeof candidate !== "string" || !candidate.trim()) return { error: "empty path" };
  if (!isAbsolute(candidate)) return { error: "not an absolute path" };
  let resolved;
  try { resolved = realpathSync(candidate.trim()); } catch { return { error: "does not exist" }; }
  try { if (!lstatSync(resolved).isDirectory()) return { error: "not a directory" }; } catch { return { error: "not a directory" }; }
  const links = symlinkComponents(resolved);
  if (links.length) return { error: "resolved path still contains a symlink component: " + links.join(", ") };
  return { path: resolved };
}

// Cache locations a build writes to outside the worktree. The OS cache
// directory covers everything that follows XDG or the platform convention
// (Go build cache, pip, uv, huggingface, gh, ...). Toolchains that keep their
// own store under the home directory are listed by directory instead, because
// naming one environment variable per language stops working the moment a new
// language shows up: a directory that exists is granted, one that does not is
// not, and a new toolchain only adds a line here at most.
export const TOOLCHAIN_CACHE_DIRS = [
  ".cargo", // Rust: registry, git checkouts, .package-cache
  ".npm", // Node: _cacache, _logs
  ".yarn",
  ".pnpm-store",
  ".bun",
  ".m2", // Maven local repository
  ".gradle", // Gradle user home
  ".nuget", // NuGet global packages
  ".ivy2", // sbt / Ivy
  ".bundle", // Ruby Bundler
  ".composer", // PHP Composer
  ".pub-cache", // Dart / Flutter
  ".mix", // Elixir
  ".hex",
  ".stack", // Haskell
  ".cpanm", // Perl
  ".deno",
  ".conda", // conda package cache
  "go/pkg" // Go module cache
];

// Credentials are never granted automatically. A dispatcher that needs them
// names the directory in writableRoots for that one dispatch: an ssh test wants
// ~/.ssh (known_hosts, ControlMaster sockets), a kubectl test ~/.kube, a registry
// push ~/.docker, an aws test ~/.aws, a signed commit ~/.gnupg. Everything here is
// granted automatically only when it holds build state, not secrets, so a worker
// steered by injected text cannot persist a key or swap a trust anchor.
export const EXPLICIT_ONLY_DIRS = [".ssh", ".gnupg", ".config", ".aws", ".docker", ".kube", ".netrc", ".git-credentials", "Library/Keychains"];
function osCacheCandidates({ env, platform, home }) {
  if (platform === "win32") return [env.LOCALAPPDATA];
  return [env.XDG_CACHE_HOME, platform === "darwin" ? pathJoin(platform, home, "Library", "Caches") : null, pathJoin(platform, home, ".cache")];
}

function goBuildCacheCandidate({ env, platform, home }) {
  const configured = env.GOCACHE?.trim();
  if (configured && configured !== "off") return configured;
  if (platform === "win32") return env.LOCALAPPDATA ? win32.join(env.LOCALAPPDATA, "go-build") : null;
  if (platform === "darwin") return pathJoin(platform, home, "Library", "Caches", "go-build");
  return pathJoin(platform, env.XDG_CACHE_HOME?.trim() || pathJoin(platform, home, ".cache"), "go-build");
}

export function cacheRoots({ env = process.env, platform = process.platform, home = homedir(), resolveRoot = resolveWritableRoot, includeToolchain = true } = {}) {
  if (/^(1|true|yes)$/i.test((env.SUPERVISOR_NO_AUTO_CACHE_ROOTS ?? "").trim())) return [];
  const candidates = [
    ...osCacheCandidates({ env, platform, home }),
    goBuildCacheCandidate({ env, platform, home }),
    ...(includeToolchain ? TOOLCHAIN_CACHE_DIRS.map((dir) => pathJoin(platform, home, dir)) : [])
  ];
  const roots = [];
  for (const candidate of candidates) {
    if (!candidate?.trim()) continue;
    const resolved = resolveRoot(candidate.trim());
    if (resolved?.path) roots.push(resolved.path);
  }
  return [...new Set(roots)];
}

