import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXPLICIT_ONLY_DIRS, cacheRoots, resolveWritableRoot, symlinkComponents } from "../../src/sandbox-roots.js";
import { dispatchArgs, makeRepo, tempHome, waitFor, withMcp } from "./helpers.js";

// Creating a symlink needs privileges on Windows; the platform still exercises
// the resolution path through cacheRoots, which takes an injected resolver.
const isWindows = process.platform === "win32";
const asGiven = (candidate) => ({ path: candidate });

test("the platform cache directory is offered to the sandbox on every platform", () => {
  assert.deepEqual(cacheRoots({ platform: "darwin", home: "/Users/example", env: {}, resolveRoot: asGiven, includeToolchain: false }),
    [join("/Users/example", "Library", "Caches"), join("/Users/example", ".cache"), join("/Users/example", "Library", "Caches", "go-build")]);
  assert.deepEqual(cacheRoots({ platform: "linux", home: "/home/example", env: {}, resolveRoot: asGiven, includeToolchain: false }),
    [join("/home/example", ".cache"), join("/home/example", ".cache", "go-build")]);
  assert.deepEqual(cacheRoots({ platform: "win32", home: "C:\\Users\\example", env: { LOCALAPPDATA: "C:\\Users\\example\\AppData\\Local" }, resolveRoot: asGiven, includeToolchain: false }),
    ["C:\\Users\\example\\AppData\\Local", "C:\\Users\\example\\AppData\\Local\\go-build"]);
});

test("a symlinked Go build cache grants its resolved target", () => {
  const home = "/Users/example";
  const goBuild = join(home, "Library", "Caches", "go-build");
  const roots = cacheRoots({
    platform: "darwin",
    home,
    env: {},
    includeToolchain: false,
    resolveRoot: (candidate) => candidate === goBuild ? { path: "/Volumes/dev-cache/go-build" } : { path: candidate }
  });
  assert.ok(roots.includes("/Volumes/dev-cache/go-build"));
});

test("an explicit GOCACHE takes precedence and is resolved before the sandbox sees it", () => {
  const roots = cacheRoots({
    platform: "darwin",
    home: "/Users/example",
    env: { GOCACHE: "/aliases/go-build" },
    includeToolchain: false,
    resolveRoot: (candidate) => candidate === "/aliases/go-build" ? { path: "/Volumes/dev-cache/go-build" } : { path: candidate }
  });
  assert.ok(roots.includes("/Volumes/dev-cache/go-build"));
  assert.equal(roots.includes("/Users/example/Library/Caches/go-build"), false);
});

test("a candidate that cannot be resolved to a symlink-free path is dropped", () => {
  // This is the bug 0.9.2 shipped: a symlinked ~/.cache was handed to Codex,
  // which refuses such a writable root and then fails every worker command.
  // The separator is platform-specific: the win32 runner builds \\Users\\...\\\.cache.
  const dropLink = (candidate) => /(^|[\\/])\.cache$/.test(candidate) ? { error: "resolved path still contains a symlink component" } : { path: candidate };
  assert.deepEqual(cacheRoots({ platform: "darwin", home: "/Users/example", env: {}, resolveRoot: dropLink, includeToolchain: false }),
    [join("/Users/example", "Library", "Caches"), join("/Users/example", "Library", "Caches", "go-build")]);
  assert.deepEqual(cacheRoots({ platform: "linux", home: "/home/example", env: {}, resolveRoot: () => ({ error: "does not exist" }), includeToolchain: false }), []);
  assert.deepEqual(cacheRoots({ platform: "linux", home: "/home/example", env: { XDG_CACHE_HOME: "/vol/cache" },
    resolveRoot: (candidate) => ({ path: candidate === "/vol/cache" ? "/Volumes/data/cache" : candidate === "/vol/cache/go-build" ? "/Volumes/data/cache/go-build" : candidate }), includeToolchain: false }),
    ["/Volumes/data/cache", join("/home/example", ".cache"), "/Volumes/data/cache/go-build"], "an alias is replaced by its target");
  assert.deepEqual(cacheRoots({ platform: "linux", home: "/home/example", env: { XDG_CACHE_HOME: "/vol/cache" },
    resolveRoot: () => ({ path: "/Volumes/data/cache" }), includeToolchain: false }), ["/Volumes/data/cache"], "duplicates collapse");
});

test("a writable root is resolved, and a symlinked one is reported through its target", async () => {
  const root = await mkdtemp(join(tmpdir(), "supervisor-root-"));
  const real = join(root, "real");
  await mkdir(real);
  assert.equal(resolveWritableRoot(real).path, realpathSync(real));
  assert.match(resolveWritableRoot(join(root, "missing")).error, /does not exist/);
  assert.match(resolveWritableRoot("relative/dir").error, /not an absolute path/);
  assert.match(resolveWritableRoot("").error, /empty path/);
  if (isWindows) return;
  const link = join(root, "linked");
  await symlink(real, link, "dir");
  assert.ok(symlinkComponents(link).includes(link), "the alias itself is a symlink component");
  const resolved = resolveWritableRoot(link);
  assert.equal(resolved.path, realpathSync(real), "Codex gets the target, never the alias");
  assert.deepEqual(symlinkComponents(resolved.path), [], "what Codex receives has no symlink component");
});

test("toolchain caches are granted automatically and credentials never are", () => {
  const home = "/Users/example";
  const asGiven = (candidate) => ({ path: candidate });
  const roots = cacheRoots({ platform: "darwin", home, env: {}, resolveRoot: asGiven });
  for (const dir of [".cargo", ".npm", ".m2", ".gradle", ".nuget", ".bundle", ".composer", ".pub-cache", ".deno", "go/pkg"]) {
    assert.ok(roots.includes(join(home, dir)), dir + " must be granted");
  }
  for (const dir of EXPLICIT_ONLY_DIRS) {
    assert.ok(!roots.includes(join(home, dir)), dir + " must never be granted automatically");
  }
});

test("the credential stores stay on an explicit list so a future edit cannot move one", () => {
  for (const dir of [".ssh", ".gnupg", ".config", ".aws", ".docker", ".kube", ".netrc", ".git-credentials", "Library/Keychains"]) {
    assert.ok(EXPLICIT_ONLY_DIRS.includes(dir), dir + " must be explicit-only");
  }
});

test("the automatic roots can be switched off", () => {
  const asGiven = (candidate) => ({ path: candidate });
  assert.deepEqual(cacheRoots({ platform: "linux", home: "/Users/example", env: { SUPERVISOR_NO_AUTO_CACHE_ROOTS: "1" }, resolveRoot: asGiven }), []);
  assert.deepEqual(cacheRoots({ platform: "linux", home: "/Users/example", env: { SUPERVISOR_NO_AUTO_CACHE_ROOTS: "true" }, resolveRoot: asGiven }), []);
  assert.ok(cacheRoots({ platform: "linux", home: "/Users/example", env: { SUPERVISOR_NO_AUTO_CACHE_ROOTS: "0" }, resolveRoot: asGiven }).length > 0);
});


function writableRootsOf(args) {
  const flag = args.find((arg) => arg.startsWith("sandbox_workspace_write.writable_roots="));
  return flag ? JSON.parse(flag.slice("sandbox_workspace_write.writable_roots=".length)) : [];
}

test("every writable root a worker receives is symlink-free", async () => {
  const home = await tempHome("supervisor-cache-");
  const cache = join(home, "xdg-cache");
  await mkdir(cache, { recursive: true });
  const argsLog = join(home, "codex-args.jsonl");
  const { dir: repo } = await makeRepo(join(home, "repo"));
  // The platform picks its own variable: XDG_CACHE_HOME on unix, LOCALAPPDATA
  // on Windows.
  const cacheEnv = isWindows ? { LOCALAPPDATA: cache } : { XDG_CACHE_HOME: cache };
  await withMcp({ SUPERVISOR_HOME: home, ...cacheEnv, FAKE_CODEX_ARGS_LOG: argsLog }, async ({ call }) => {
    const worker = await call("create_codex_worker", dispatchArgs("cache-roots", repo, {}));
    await waitFor(call, worker.id, (task) => task.status === "completed" && task.exit_code != null);
  });
  const runs = (await readFile(argsLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line).args);
  const run = runs.find((args) => args.includes("--output-schema"));
  assert.ok(run, "the worker run reached Codex");
  const roots = writableRootsOf(run);
  assert.ok(roots.includes(realpathSync(cache)), `the cache directory must be writable, got ${JSON.stringify(roots)}`);
  for (const entry of roots) assert.deepEqual(symlinkComponents(entry), [], `${entry} must have no symlink component`);
});

test("a declared root is stored and passed resolved, and unusable ones are refused", async () => {
  const home = await tempHome("supervisor-extra-root-");
  const custom = join(home, "m2-repository");
  await mkdir(custom, { recursive: true });
  const argsLog = join(home, "codex-args.jsonl");
  const { dir: repo } = await makeRepo(join(home, "repo"));
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_ARGS_LOG: argsLog }, async ({ call }) => {
    const worker = await call("create_codex_worker", dispatchArgs("extra-root", repo, {
      sandbox: "workspace-write", ownedPaths: [repo], writableRoots: [custom]
    }));
    assert.ok(worker.id, JSON.stringify(worker).slice(0, 300));
    await waitFor(call, worker.id, (task) => task.status === "completed" && task.exit_code != null);
    const relative = await call("create_codex_worker", dispatchArgs("bad-root", repo, {
      sandbox: "workspace-write", ownedPaths: [repo], writableRoots: ["relative/cache"]
    }));
    assert.match(relative.message ?? "", /absolute paths/, "a relative root is refused");
    const missing = await call("create_codex_worker", dispatchArgs("missing-root", repo, {
      sandbox: "workspace-write", ownedPaths: [repo], writableRoots: [join(home, "nope")]
    }));
    assert.match(missing.message ?? "", /unusable/, "a root that does not exist is refused before dispatch");
    if (!isWindows) {
      const link = join(home, "linked-root");
      await symlink(custom, link, "dir");
      const viaLink = await call("create_codex_worker", dispatchArgs("link-root", repo, {
        sandbox: "workspace-write", ownedPaths: [repo], writableRoots: [link]
      }));
      assert.ok(viaLink.id, JSON.stringify(viaLink).slice(0, 300));
      await waitFor(call, viaLink.id, (task) => task.status === "completed" && task.exit_code != null);
    }
  });
  const runs = (await readFile(argsLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line).args);
  for (const args of runs.filter((entry) => entry.includes("--output-schema"))) {
    const roots = writableRootsOf(args);
    assert.ok(roots.includes(realpathSync(custom)), `the declared directory must be writable, got ${JSON.stringify(roots)}`);
    for (const entry of roots) assert.deepEqual(symlinkComponents(entry), [], `${entry} must have no symlink component`);
  }
});

