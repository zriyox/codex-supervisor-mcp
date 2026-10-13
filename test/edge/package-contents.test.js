// Source-tree tests cannot detect a runtime module omitted from npm's files
// allowlist. Inspect a real tarball's manifest, starting at each shipped CLI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCommand } from "../../src/bin-resolver.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("the npm tarball includes every local import reachable from its CLI entries", { timeout: 60000 }, async (t) => {
  const destination = await mkdtemp(join(tmpdir(), "supervisor-package-"));
  t.after(() => rm(destination, { recursive: true, force: true }));
  const npm = process.env.npm_execpath
    ? { cmd: process.execPath, prefixArgs: [process.env.npm_execpath] }
    : resolveCommand("npm", { npmEntry: { pkg: "npm", bin: "bin/npm-cli.js" } });
  const [packed] = JSON.parse(execFileSync(npm.cmd, [
    ...npm.prefixArgs, "pack", "--json", "--ignore-scripts", "--offline",
    "--pack-destination", destination
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 30000,
    env: { ...process.env, npm_config_cache: join(destination, "cache") },
    stdio: ["ignore", "pipe", "pipe"]
  }));
  assert.ok((await readFile(join(destination, packed.filename))).length > 0, "npm must produce a tarball");
  const shipped = new Set(packed.files.map((file) => file.path));
  const manifest = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
  const pending = Object.values(manifest.bin).map((entry) => posix.normalize(entry));
  const visited = new Set();
  while (pending.length > 0) {
    const file = pending.pop();
    assert.ok(shipped.has(file), `npm tarball omits required runtime file: ${file}`);
    if (visited.has(file)) continue;
    visited.add(file);
    const source = await readFile(join(repoRoot, file), "utf8");
    // Cover static imports/re-exports, side-effect imports and literal dynamic
    // imports (web-server.js loads web-app.js only after resolving the store).
    const localImports = /\bfrom\s*["'](\.[^"']+)["']|\bimport\s*(?:\(\s*)?["'](\.[^"']+)["']/g;
    for (const match of source.matchAll(localImports)) {
      const dependency = posix.normalize(posix.join(posix.dirname(file), match[1] ?? match[2]));
      assert.ok(shipped.has(dependency), `${file} imports ${dependency}, but npm does not ship it`);
      if (/\.[cm]?jsx?$/.test(dependency)) pending.push(dependency);
    }
  }
  assert.ok(shipped.has("skills/codex-supervisor/SKILL.md"), "the runtime skill must ship");
});
