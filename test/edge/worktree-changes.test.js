// readWorktreeChanges on awkward histories: odd file names, renames,
// deletions, a deleted branch, a base that no longer exists.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { git, makeRepo, tempHome } from "./helpers.js";

const home = await tempHome("supervisor-changes-");
process.env.SUPERVISOR_HOME = home;
const { readWorktreeChanges, resolveWorktreeBase, readTaskChanges } = await import("../../src/worktree.js");

async function worktreeFrom(repo, name) {
  const wt = join(home, "wt", name);
  const base = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["worktree", "add", "--detach", wt, base]);
  git(wt, ["switch", "-q", "-c", `codex/${name}`]);
  return { wt, base, branch: `codex/${name}` };
}

// Relative to the worktree, with forward slashes on every platform.
const names = (files, wt) => files.map((f) => f.slice(wt.length + 1).replaceAll("\\", "/")).sort();

test("spaces, unicode, nested dirs, renames and deletions are all listed once", async () => {
  const { dir } = await makeRepo(join(home, "repo-names"));
  const { wt, base } = await worktreeFrom(dir, "names");
  await writeFile(join(wt, "with space.txt"), "x\n");
  await writeFile(join(wt, "中文 文件.md"), "y\n");
  await import("node:fs/promises").then((fs) => fs.mkdir(join(wt, "deep", "er"), { recursive: true }));
  await writeFile(join(wt, "deep", "er", "leaf.go"), "z\n");
  git(wt, ["mv", "first.txt", "renamed.txt"]);
  await rm(join(wt, "second.txt"));
  git(wt, ["add", "-A"]);
  git(wt, ["commit", "-q", "-m", "mixed"]);
  // and one more uncommitted on top
  await writeFile(join(wt, "draft.txt"), "d\n");
  const found = names(readWorktreeChanges(wt, { baseCommit: base }), wt);
  assert.deepEqual(found, ["deep/er/leaf.go", "draft.txt", "renamed.txt", "second.txt", "with space.txt", "中文 文件.md"]);
});

test("a deleted branch loses the reflog fallback but keeps the uncommitted part", async () => {
  const { dir } = await makeRepo(join(home, "repo-branch"));
  const { wt, branch } = await worktreeFrom(dir, "gone");
  await writeFile(join(wt, "c.txt"), "c\n");
  git(wt, ["add", "-A"]);
  git(wt, ["commit", "-q", "-m", "c"]);
  await writeFile(join(wt, "u.txt"), "u\n");
  assert.ok(resolveWorktreeBase(wt, { branch }), "reflog base resolves while the branch exists");
  git(wt, ["switch", "-q", "--detach"]);
  git(dir, ["branch", "-D", branch]);
  assert.equal(resolveWorktreeBase(wt, { branch }), null);
  assert.deepEqual(names(readWorktreeChanges(wt, { branch }), wt), ["u.txt"], "no base: only git status");
});

test("a base commit that does not exist degrades to the uncommitted part", async () => {
  const { dir } = await makeRepo(join(home, "repo-badbase"));
  const { wt } = await worktreeFrom(dir, "badbase");
  await writeFile(join(wt, "k.txt"), "k\n");
  git(wt, ["add", "-A"]);
  git(wt, ["commit", "-q", "-m", "k"]);
  await writeFile(join(wt, "u.txt"), "u\n");
  assert.deepEqual(names(readWorktreeChanges(wt, { baseCommit: "0".repeat(40) }), wt), ["u.txt"]);
});

test("a missing worktree path and a non-git directory both yield an empty list", async () => {
  assert.deepEqual(readWorktreeChanges(join(home, "nope"), { baseCommit: "abc" }), []);
  assert.deepEqual(readWorktreeChanges(home, { branch: "codex/x" }), []);
  assert.deepEqual(readTaskChanges({ id: "t", worktree_path: null, changed_files: ["/kept"] }), ["/kept"], "event-sourced files survive without a worktree");
});

test("a worker that only committed (clean status) is fully visible through readTaskChanges", async () => {
  const { dir } = await makeRepo(join(home, "repo-clean"));
  const { wt, base, branch } = await worktreeFrom(dir, "clean");
  await writeFile(join(wt, "only.txt"), "o\n");
  git(wt, ["add", "-A"]);
  git(wt, ["commit", "-q", "-m", "only"]);
  assert.equal(git(wt, ["status", "--porcelain"]), "");
  const task = { id: "clean", worktree_path: wt, base_commit: base, changed_files: [] };
  assert.deepEqual(names(readTaskChanges(task), wt), ["only.txt"]);
  const legacy = { id: "clean", worktree_path: wt, base_commit: null, changed_files: [] };
  assert.deepEqual(names(readTaskChanges(legacy), wt), ["only.txt"], `legacy row via reflog of ${branch}`);
});
