// get_worker_diff: committed, uncommitted and untracked changes all show,
// the character budget cuts patches but never the file list, paths narrow
// the read, and a worker without a worktree says so.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { dispatchArgs, git, makeRepo, tempHome, waitFor, withMcp } from "./helpers.js";

const home = await tempHome("supervisor-diff-");
const { dir: repo } = await makeRepo(join(home, "repo"));
let worker;
let inPlace;

before(async () => {
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const created = await call("create_codex_worker", dispatchArgs("diffable", repo));
    worker = await waitFor(call, created.id, (t) => t.status === "completed");
    const plain = join(home, "not-a-repo");
    await mkdir(plain, { recursive: true });
    const createdPlain = await call("create_codex_worker", dispatchArgs("in-place", plain));
    inPlace = await waitFor(call, createdPlain.id, (t) => t.status === "completed");
  });
  // Stand in for the worker's own edits: one commit, one unstaged edit, one
  // new file git has never seen, one big file for the budget test.
  const wt = worker.worktree_path;
  await writeFile(join(wt, "first.txt"), "one\nmore\n");
  await mkdir(join(wt, "lib"), { recursive: true });
  await writeFile(join(wt, "lib", "a.txt"), "alpha\n");
  git(wt, ["add", "-A"]);
  git(wt, ["commit", "-q", "-m", "step 1: first and lib/a"]);
  await writeFile(join(wt, "second.txt"), "two\nchanged\n");
  await writeFile(join(wt, "新文件.txt"), "untracked\nlines\n");
  await writeFile(join(wt, "big.txt"), "x".repeat(5000) + "\n");
});

test("committed, uncommitted and untracked changes are all there, with patches", async () => {
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const diff = await call("get_worker_diff", { task_id: worker.id });
    assert.equal(diff.error, undefined, JSON.stringify(diff).slice(0, 300));
    assert.equal(diff.branch, `codex/${worker.id}`);
    assert.equal(diff.base_commit, worker.base_commit ?? diff.base_commit);
    const byPath = Object.fromEntries(diff.files.map((f) => [f.path, f]));
    assert.deepEqual(Object.keys(byPath).sort(), ["big.txt", "first.txt", "lib/a.txt", "second.txt", "新文件.txt"]);
    assert.equal(byPath["first.txt"].status, "modified");
    assert.match(byPath["first.txt"].patch, /^\+more$/m, "a committed change has its patch");
    assert.equal(byPath["lib/a.txt"].status, "added");
    assert.equal(byPath["second.txt"].status, "modified");
    assert.match(byPath["second.txt"].patch, /^\+changed$/m, "an unstaged change has its patch");
    assert.equal(byPath["新文件.txt"].status, "untracked");
    assert.equal(byPath["新文件.txt"].patch, "+untracked\n+lines");
    assert.equal(byPath["新文件.txt"].additions, 2);
    assert.equal(byPath["first.txt"].additions, 1);
    assert.equal(byPath["first.txt"].deletions, 0);
    assert.equal(diff.total_files, 5);
    assert.equal(diff.truncated_files, 0);
  });
});

test("the budget cuts patches, never the file list", async () => {
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const diff = await call("get_worker_diff", { task_id: worker.id, maxChars: 600 });
    assert.equal(diff.total_files, 5, "every changed file is still listed");
    assert.ok(diff.truncated_files >= 1);
    const served = diff.files.filter((f) => f.patch !== null);
    const total = served.reduce((n, f) => n + f.patch.length, 0);
    assert.ok(total <= 600 + 40, `served ${total} chars for a 600 budget (the cut marker is allowed on top)`);
    const big = diff.files.find((f) => f.path === "big.txt");
    assert.equal(big.truncated, true);
    assert.ok(big.patch === null || big.patch.length <= 640);
  });
});

test("paths narrows the read", async () => {
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const diff = await call("get_worker_diff", { task_id: worker.id, paths: ["lib", "新文件.txt"] });
    assert.deepEqual(diff.files.map((f) => f.path).sort(), ["lib/a.txt", "新文件.txt"]);
  });
});

test("a worker that ran in place has no worktree to diff, and says where to look instead", async () => {
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const diff = await call("get_worker_diff", { task_id: inPlace.id });
    assert.equal(diff.error, "no_worktree");
    assert.match(diff.reason, /get_worker_result/);
    const missing = await call("get_worker_diff", { task_id: "codex-nope" });
    assert.equal(missing.error, "task_not_found");
  });
});
