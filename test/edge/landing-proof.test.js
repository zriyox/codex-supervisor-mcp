import { test } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { landWorker } from "../../src/landing.js";
import { git, makeRepo, tempHome } from "./helpers.js";

test("patch mapping failure does not replay already integrated commits", async (context) => {
  const home = await tempHome("supervisor-landing-proof-");
  const { dir } = await makeRepo(join(home, "repo"));
  const base = git(dir, ["rev-parse", "HEAD"]);
  const worktree = join(home, "worker");
  git(dir, ["worktree", "add", "-b", "worker", worktree, base]);
  await writeFile(join(worktree, "parent.txt"), "parent\n");
  git(worktree, ["add", "parent.txt"]);
  git(worktree, ["commit", "-q", "-m", "parent"]);
  const parentHead = git(worktree, ["rev-parse", "HEAD"]);
  await writeFile(join(dir, "unrelated.txt"), "target\n");
  git(dir, ["add", "unrelated.txt"]);
  git(dir, ["commit", "-q", "-m", "move target"]);
  git(dir, ["cherry-pick", parentHead]);
  await writeFile(join(worktree, "child.txt"), "child\n");
  git(worktree, ["add", "child.txt"]);
  git(worktree, ["commit", "-q", "-m", "child"]);

  const originalExec = childProcess.execFileSync;
  context.mock.method(childProcess, "execFileSync", (command, args, options) => {
    if (args.includes("patch-id")) throw new Error("injected patch mapping failure");
    return originalExec(command, args, options);
  });
  syncBuiltinESMExports();
  context.after(() => {
    context.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const result = landWorker({
    id: "proof", project_root: dir, worktree_path: worktree, base_commit: base,
    owned_paths: [join(dir, "parent.txt"), join(dir, "child.txt")],
    acceptance_results: { status: "passed", passed: true, checks: [] }
  });
  assert.ok(!result.error, JSON.stringify(result));
  assert.equal(result.landed.length, 1);
  assert.deepEqual(result.already_landed, [parentHead]);
  assert.equal(result.match_complete, false);
  assert.match(result.match_error, /injected patch mapping failure/);
  assert.equal(await readFile(join(dir, "child.txt"), "utf8"), "child\n");
});
