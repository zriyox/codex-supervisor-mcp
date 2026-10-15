import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { cacheRoots } from "../../src/sandbox-roots.js";
import { dispatchArgs, makeRepo, tempHome, waitFor, withMcp } from "./helpers.js";

test("the platform cache directory is offered to the sandbox on every platform", () => {
  const exists = () => true;
  assert.deepEqual(cacheRoots({ platform: "darwin", home: "/Users/example", env: {}, exists }),
    [join("/Users/example", "Library", "Caches"), join("/Users/example", ".cache")]);
  assert.deepEqual(cacheRoots({ platform: "linux", home: "/home/example", env: {}, exists }),
    [join("/home/example", ".cache")]);
  assert.deepEqual(cacheRoots({ platform: "win32", home: "C:\\Users\\example", env: { LOCALAPPDATA: "C:\\Users\\example\\AppData\\Local" }, exists }),
    ["C:\\Users\\example\\AppData\\Local"]);
});

test("XDG_CACHE_HOME wins on unix and missing directories are dropped", () => {
  assert.deepEqual(cacheRoots({ platform: "linux", home: "/home/example", env: { XDG_CACHE_HOME: "/tmp/xdg" }, exists: () => true }),
    ["/tmp/xdg", join("/home/example", ".cache")]);
  assert.deepEqual(cacheRoots({ platform: "linux", home: "/home/example", env: {}, exists: () => false }), []);
  const seen = [];
  cacheRoots({ platform: "darwin", home: "/Users/example", env: {}, exists: (dir) => { seen.push(dir); return true; } });
  assert.deepEqual(seen, [join("/Users/example", "Library", "Caches"), join("/Users/example", ".cache")], "only real directories are added");
});

test("a dispatched worker's sandbox is told to write that cache directory", async () => {
  const home = await tempHome("supervisor-cache-");
  const cache = join(home, "xdg-cache");
  await mkdir(cache, { recursive: true });
  const argsLog = join(home, "codex-args.jsonl");
  const { dir: repo } = await makeRepo(join(home, "repo"));
  // The platform picks its own variable: XDG_CACHE_HOME on unix, LOCALAPPDATA
  // on Windows.
  const cacheEnv = process.platform === "win32" ? { LOCALAPPDATA: cache } : { XDG_CACHE_HOME: cache };
  await withMcp({ SUPERVISOR_HOME: home, ...cacheEnv, FAKE_CODEX_ARGS_LOG: argsLog }, async ({ call }) => {
    const worker = await call("create_codex_worker", dispatchArgs("cache-roots", repo, {}));
    await waitFor(call, worker.id, (task) => task.status === "completed");
  });
  const runs = (await readFile(argsLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line).args);
  const run = runs.find((args) => args.includes("--output-schema"));
  assert.ok(run, "the worker run reached Codex");
  const flag = run.find((arg) => arg.startsWith("sandbox_workspace_write.writable_roots="));
  assert.ok(flag, `no writable_roots passed: ${run.join(" ")}`);
  assert.ok(JSON.parse(flag.slice("sandbox_workspace_write.writable_roots=".length)).includes(cache),
    `the cache directory must be writable, got ${flag}`);
});

test("a dispatch may name a cache directory that is not the OS cache directory", async () => {
  const home = await tempHome("supervisor-extra-root-");
  const custom = join(home, "m2-repository");
  await mkdir(custom, { recursive: true });
  const argsLog = join(home, "codex-args.jsonl");
  const { dir: repo } = await makeRepo(join(home, "repo"));
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_ARGS_LOG: argsLog }, async ({ call }) => {
    const worker = await call("create_codex_worker", dispatchArgs("extra-root", repo, {
      sandbox: "workspace-write", ownedPaths: [repo], writableRoots: [custom]
    }));
    await waitFor(call, worker.id, (task) => task.status === "completed");
    const relative = await call("create_codex_worker", dispatchArgs("bad-root", repo, {
      sandbox: "workspace-write", ownedPaths: [repo], writableRoots: ["relative/cache"]
    }));
    assert.match(relative.message ?? "", /absolute paths/, "a relative root is refused");
    const missing = await call("create_codex_worker", dispatchArgs("missing-root", repo, {
      sandbox: "workspace-write", ownedPaths: [repo], writableRoots: [join(home, "nope")]
    }));
    assert.match(missing.message ?? "", /existing directory/, "a root that does not exist is refused before dispatch");
  });
  const runs = (await readFile(argsLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line).args);
  const run = runs.find((args) => args.includes("--output-schema"));
  const flag = run.find((arg) => arg.startsWith("sandbox_workspace_write.writable_roots="));
  assert.ok(JSON.parse(flag.slice("sandbox_workspace_write.writable_roots=".length)).includes(custom),
    `the declared directory must be writable, got ${flag}`);
});
