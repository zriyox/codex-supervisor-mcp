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

test("a worker that committed nothing lands nothing and says how to land its edits", async () => {
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const result = await call("land_codex_worker", { task_id: idle.id });
    assert.equal(result.error, "nothing_to_land");
    assert.deepEqual(result.uncommitted, ["left.txt"]);
    assert.match(result.reason, /commitMessage/);
    const missing = await call("land_codex_worker", { task_id: "codex-none" });
    assert.equal(missing.error, "task_not_found");
  });
});

test("a machine where git has no identity still lands, with a stand-in committer", async () => {
  // git is told to use only configured identities (what a CI runner amounts
  // to), and the global config is pointed at a file that does not exist.
  const noIdentity = {
    SUPERVISOR_HOME: home,
    GIT_CONFIG_GLOBAL: join(home, "no-such-gitconfig"),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "user.useConfigOnly",
    GIT_CONFIG_VALUE_0: "true",
    GIT_AUTHOR_NAME: "",
    GIT_AUTHOR_EMAIL: "",
    GIT_COMMITTER_NAME: "",
    GIT_COMMITTER_EMAIL: ""
  };
  await withMcp(noIdentity, async ({ call }) => {
    const created = await call("create_codex_worker", dispatchArgs("anonymous", repo));
    const anon = await waitFor(call, created.id, (t) => t.status === "completed");
    await writeFile(join(anon.worktree_path, "anon.txt"), "no identity here\n");
    const result = await call("land_codex_worker", { task_id: anon.id, commitMessage: "step 5: add anon.txt" });
    assert.equal(result.error, undefined, JSON.stringify(result).slice(0, 400));
    assert.equal(result.landed.length, 1);
  });
  const committer = git(repo, ["log", "-1", "--format=%cn <%ce>"]);
  assert.equal(committer, "codex-supervisor <codex-supervisor@localhost>");
});

test("commitMessage commits a workspace-write worker's edits as one commit on its branch and lands it", async () => {
  const before = git(repo, ["rev-parse", "HEAD"]);
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const result = await call("land_codex_worker", { task_id: idle.id, commitMessage: "step 4: add left.txt" });
    assert.equal(result.error, undefined, JSON.stringify(result).slice(0, 300));
    assert.equal(result.landed.length, 1);
    assert.equal(result.landed[0].subject, "step 4: add left.txt");
    assert.equal(result.landed[0].original, result.committed_for_worker);
    assert.deepEqual(result.uncommitted, []);
  });
  assert.equal(git(repo, ["rev-list", "--count", `${before}..HEAD`]), "1");
  assert.equal(git(repo, ["show", "HEAD:left.txt"]), "left behind");
  assert.equal(git(idle.worktree_path, ["status", "--porcelain"]), "", "the worker's worktree is clean afterwards");
  assert.equal(git(idle.worktree_path, ["log", "-1", "--format=%s"]), "step 4: add left.txt", "the commit sits on the worker's branch");
});
