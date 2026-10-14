import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { snapshotTaskOutput } from "../../src/worktree.js";
import { git, makeRepo, tempHome } from "./helpers.js";

test("current-run output comparison does not count earlier committed edits or drafts again", async () => {
  const home = await tempHome("supervisor-output-");
  const { dir, second } = await makeRepo(join(home, "repo"));
  const task = { worktree_path: dir, base_commit: second };
  await writeFile(join(dir, "first.txt"), "previous completed output\n");
  git(dir, ["commit", "-q", "-am", "earlier work"]);
  await writeFile(join(dir, "draft.txt"), "earlier draft\n");
  const before = snapshotTaskOutput(task);
  assert.equal(snapshotTaskOutput(task), before);
  await writeFile(join(dir, "draft.txt"), "new run extended the draft\n");
  assert.notEqual(snapshotTaskOutput(task), before);
  const edited = snapshotTaskOutput(task);
  await writeFile(join(dir, "first.txt"), "new run extended committed work\n");
  assert.notEqual(snapshotTaskOutput(task), edited);
  await writeFile(join(dir, "binary.dat"), Buffer.from([0, 1, 2]));
  const binary = snapshotTaskOutput(task);
  await writeFile(join(dir, "binary.dat"), Buffer.from([0, 3, 4]));
  assert.notEqual(snapshotTaskOutput(task), binary, "binary output changes must be visible too");
});

test("missing or over-budget output cannot falsely prove an empty run", async () => {
  assert.equal(snapshotTaskOutput({}), null);
  const home = await tempHome("supervisor-large-output-");
  const { dir, second } = await makeRepo(join(home, "repo"));
  await writeFile(join(dir, "large.txt"), "x".repeat(2_000_001));
  assert.equal(snapshotTaskOutput({ worktree_path: dir, base_commit: second }), null);
});
