// land_codex_worker: the worker's commits arrive on the dispatch branch in
// order with their messages, a dirty or wrongly-named target is refused
// untouched, a conflict is reported and rolled back, and a worker without
// commits lands nothing but says what it left uncommitted.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { dispatchArgs, git, makeRepo, tempHome, waitFor, withMcp } from "./helpers.js";

const home = await tempHome("supervisor-land-");
const { dir: repo } = await makeRepo(join(home, "repo"));
let worker;
let idle;

async function commitIn(wt, file, text, message) {
  await writeFile(join(wt, file), text);
  git(wt, ["add", "-A"]);
  git(wt, ["commit", "-q", "-m", message]);
  return git(wt, ["rev-parse", "HEAD"]);
}

before(async () => {
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const created = await call("create_codex_worker", dispatchArgs("lander", repo));
    worker = await waitFor(call, created.id, (t) => t.status === "completed");
    const second = await call("create_codex_worker", dispatchArgs("idle", repo));
    idle = await waitFor(call, second.id, (t) => t.status === "completed");
  });
  await commitIn(worker.worktree_path, "step.txt", "step one\n", "step 1: add step.txt");
  await commitIn(worker.worktree_path, "first.txt", "one\nand two\n", "step 2: extend first.txt");
  await writeFile(join(worker.worktree_path, "scratch.txt"), "not committed\n");
  await writeFile(join(idle.worktree_path, "left.txt"), "left behind\n");
});

test("a dirty target is refused and left alone", async () => {
  await writeFile(join(repo, "second.txt"), "two\nedited locally\n");
  try {
    await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
      const result = await call("land_codex_worker", { task_id: worker.id });
      assert.equal(result.error, "dirty_target");
      assert.deepEqual(result.dirty_files, ["second.txt"]);
    });
  } finally {
    git(repo, ["checkout", "--", "second.txt"]);
  }
});

test("onto is a guard: a different branch name is refused, nothing is switched", async () => {
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const result = await call("land_codex_worker", { task_id: worker.id, onto: "dev" });
    assert.equal(result.error, "wrong_branch");
    assert.equal(result.current_branch, "main");
    assert.equal(git(repo, ["symbolic-ref", "--short", "HEAD"]), "main");
  });
});

test("the worker's commits land in order with their messages; uncommitted edits are reported, not landed", async () => {
  const before = git(repo, ["rev-parse", "HEAD"]);
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const result = await call("land_codex_worker", { task_id: worker.id, onto: "main" });
    assert.equal(result.error, undefined, JSON.stringify(result).slice(0, 400));
    assert.equal(result.onto, "main");
    assert.equal(result.landed.length, 2);
    assert.deepEqual(result.landed.map((c) => c.subject), ["step 1: add step.txt", "step 2: extend first.txt"]);
    assert.notEqual(result.landed[0].sha, result.landed[0].original, "a cherry-pick makes a new commit");
    assert.deepEqual(result.uncommitted, ["scratch.txt"]);
    assert.equal(result.head, git(repo, ["rev-parse", "HEAD"]));
  });
  assert.equal(git(repo, ["rev-list", "--count", `${before}..HEAD`]), "2");
  assert.equal(git(repo, ["show", "HEAD:first.txt"]), "one\nand two");
  assert.equal(git(repo, ["status", "--porcelain"]), "", "the target is clean afterwards");
  assert.throws(() => git(repo, ["cat-file", "-e", "HEAD:scratch.txt"]), "the uncommitted file did not land");
});

test("a conflict is reported with the files and the target is rolled back", async () => {
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const created = await call("create_codex_worker", dispatchArgs("conflicting", repo, { baseRef: "v-first" }));
    const other = await waitFor(call, created.id, (t) => t.status === "completed");
    await commitIn(other.worktree_path, "first.txt", "one\nsomething else\n", "step 3: clash on first.txt");
    const before = git(repo, ["rev-parse", "HEAD"]);
    const result = await call("land_codex_worker", { task_id: other.id });
    assert.equal(result.error, "conflict");
    assert.deepEqual(result.conflicts, ["first.txt"]);
    assert.equal(git(repo, ["rev-parse", "HEAD"]), before, "HEAD did not move");
    assert.equal(git(repo, ["status", "--porcelain"]), "", "no half-applied cherry-pick left behind");
  });
});

test("a worker that committed nothing lands nothing and lists what it left", async () => {
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const result = await call("land_codex_worker", { task_id: idle.id });
    assert.equal(result.error, "nothing_to_land");
    assert.deepEqual(result.uncommitted, ["left.txt"]);
    const missing = await call("land_codex_worker", { task_id: "codex-none" });
    assert.equal(missing.error, "task_not_found");
  });
});
