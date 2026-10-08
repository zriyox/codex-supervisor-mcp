// resume_codex_worker with rebaseOnto: the worker's worktree is moved onto
// the project's newer commit before the worker continues, and every way
// that can go wrong leaves the worktree as it was.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dispatchArgs, git, makeRepo, tempHome, waitFor, withMcp } from "./helpers.js";

async function advanceMain(dir, name = "later.txt", content = "later\n") {
  await writeFile(join(dir, name), content);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", `main: ${name}`]);
  return git(dir, ["rev-parse", "HEAD"]);
}

// helpers.git trims, which eats the status column of " M file".
function porcelain(cwd) {
  return execFileSync("git", ["-C", cwd, "status", "--porcelain"], { encoding: "utf8" }).replace(/\n$/, "");
}

// Windows runners have core.autocrlf on, so a file that went through the
// stash comes back with CRLF; the content is what is being checked.
async function text(path) {
  return (await readFile(path, "utf8")).replace(/\r\n/g, "\n");
}

function settled(t) {
  return t.status === "completed" && t.exit_code !== null;
}

function baseCommitInDb(home, id) {
  const db = new DatabaseSync(join(home, "data", "supervisor.sqlite"));
  const row = db.prepare("SELECT base_commit FROM tasks WHERE id = ?").get(id);
  db.close();
  return row.base_commit;
}

test("a worker with commits is replayed onto the moved main, and only its own commits land afterwards", async () => {
  const home = await tempHome("supervisor-rebase-");
  const { dir } = await makeRepo(join(home, "repo"));
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "commit-in-worktree" }, async ({ call }) => {
    const created = await call("create_codex_worker", dispatchArgs("committer", dir));
    await waitFor(call, created.id, settled);
    const before = await call("get_worker_result", { task_id: created.id });
    assert.deepEqual(before.base_behind, { behind: 0, contains_base: true, ref: "main" });

    await advanceMain(dir, "a.txt");
    const mainHead = await advanceMain(dir, "b.txt");
    const mid = await call("get_worker_result", { task_id: created.id });
    assert.deepEqual(mid.base_behind, { behind: 2, contains_base: true, ref: "main" });

    const resumed = await call("resume_codex_worker", { task_id: created.id, prompt: "carry on", rebaseOnto: "main" });
    assert.ok(!resumed.error, JSON.stringify(resumed).slice(0, 400));
    assert.equal(resumed.base_commit, mainHead, "base moves to the new main head");
    assert.equal(resumed.rebase.replayed, 1);
    assert.equal(resumed.rebase.stashed, true, "the uncommitted draft was carried across");
    assert.deepEqual(resumed.base_behind, { behind: 0, contains_base: true, ref: "main" });
    await waitFor(call, created.id, settled);

    assert.equal(git(created.worktree_path, ["rev-list", "--count", "main..HEAD"]), "1", "exactly the worker's commit sits on top of main");
    assert.equal(git(created.worktree_path, ["status", "--porcelain"]).split("\n").filter(Boolean).length, 1, "the draft is back, uncommitted");
    const diff = await call("get_worker_diff", { task_id: created.id });
    assert.deepEqual(diff.files.map((f) => basename(f.path)).sort(), ["committed.txt", "uncommitted.txt"], "the diff is still just the worker's work");
    const landed = await call("land_codex_worker", { task_id: created.id });
    assert.ok(!landed.error, JSON.stringify(landed).slice(0, 400));
    assert.equal(landed.landed.length, 1, "main's own commits are not landed again");
  });
});

test("a workspace-write worker's uncommitted edits and untracked files ride across the rebase", async () => {
  const home = await tempHome("supervisor-rebase-");
  const { dir } = await makeRepo(join(home, "repo"));
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const created = await call("create_codex_worker", dispatchArgs("editor", dir));
    await waitFor(call, created.id, settled);
    await writeFile(join(created.worktree_path, "second.txt"), "two, edited by the worker\n");
    await writeFile(join(created.worktree_path, "new.txt"), "new\n");
    const mainHead = await advanceMain(dir);
    const resumed = await call("resume_codex_worker", { task_id: created.id, prompt: "carry on", rebaseOnto: "HEAD" });
    assert.ok(!resumed.error, JSON.stringify(resumed).slice(0, 400));
    assert.equal(resumed.base_commit, mainHead);
    assert.equal(resumed.rebase.replayed, 0);
    await waitFor(call, created.id, settled);
    assert.equal(git(created.worktree_path, ["rev-parse", "HEAD"]), mainHead, "no commits to replay: the branch now sits on main");
    assert.equal(porcelain(created.worktree_path), " M second.txt\n?? new.txt", "edits and untracked files are back");
    assert.equal(await text(join(created.worktree_path, "second.txt")), "two, edited by the worker\n");
    assert.equal(git(created.worktree_path, ["stash", "list"]), "", "nothing left on the stash");
  });
});

test("nothing to do when onto is already in the branch: same base, or an ancestor of it", async () => {
  const home = await tempHome("supervisor-rebase-");
  const { dir, second } = await makeRepo(join(home, "repo"));
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "commit-in-worktree" }, async ({ call }) => {
    const created = await call("create_codex_worker", dispatchArgs("steady", dir));
    await waitFor(call, created.id, settled);
    const head = git(created.worktree_path, ["rev-parse", "HEAD"]);
    for (const onto of ["main", "v-first"]) {
      const resumed = await call("resume_codex_worker", { task_id: created.id, prompt: "again", rebaseOnto: onto });
      assert.ok(!resumed.error, JSON.stringify(resumed).slice(0, 400));
      assert.equal(resumed.rebase.noop, true, onto);
      assert.equal(resumed.base_commit, second, `${onto}: base stays`);
      await waitFor(call, created.id, settled);
      assert.equal(git(created.worktree_path, ["rev-parse", "HEAD"]), head, `${onto}: the branch did not move backwards`);
    }
  });
});

test("a conflicting commit aborts the rebase, lists the file, and does not start the worker", async () => {
  const home = await tempHome("supervisor-rebase-");
  const { dir } = await makeRepo(join(home, "repo"));
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const created = await call("create_codex_worker", dispatchArgs("clasher", dir));
    const done = await waitFor(call, created.id, settled);
    await writeFile(join(created.worktree_path, "first.txt"), "worker's version\n");
    git(created.worktree_path, ["commit", "-q", "-am", "worker edits first"]);
    const head = git(created.worktree_path, ["rev-parse", "HEAD"]);
    await advanceMain(dir, "first.txt", "main's version\n");

    const refused = await call("resume_codex_worker", { task_id: created.id, prompt: "carry on", rebaseOnto: "main" });
    assert.equal(refused.error, "rebase_conflict");
    assert.deepEqual(refused.files, ["first.txt"]);
    assert.equal(git(created.worktree_path, ["rev-parse", "HEAD"]), head, "the branch is where it was");
    assert.equal(git(created.worktree_path, ["status", "--porcelain"]), "", "no conflict markers, no rebase in progress");
    const after = await call("get_codex_worker_status", { task_id: created.id });
    assert.equal(after.run_count, done.run_count, "the worker was not started");
    assert.equal(after.status, "completed");
    assert.equal(baseCommitInDb(home, created.id), created.base_commit, "base_commit did not move");
  });
});

test("uncommitted edits that conflict with the new base: the rebase is undone and the edits are back", async () => {
  const home = await tempHome("supervisor-rebase-");
  const { dir } = await makeRepo(join(home, "repo"));
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const created = await call("create_codex_worker", dispatchArgs("drafter", dir));
    await waitFor(call, created.id, settled);
    const head = git(created.worktree_path, ["rev-parse", "HEAD"]);
    await writeFile(join(created.worktree_path, "first.txt"), "worker's draft\n");
    await writeFile(join(created.worktree_path, "note.txt"), "untracked note\n");
    await advanceMain(dir, "first.txt", "main's version\n");

    const refused = await call("resume_codex_worker", { task_id: created.id, prompt: "carry on", rebaseOnto: "main" });
    assert.equal(refused.error, "stash_conflict", JSON.stringify(refused).slice(0, 400));
    assert.deepEqual(refused.files, ["first.txt"]);
    assert.match(refused.message, /commitMessage/);
    assert.equal(git(created.worktree_path, ["rev-parse", "HEAD"]), head);
    assert.equal(porcelain(created.worktree_path), " M first.txt\n?? note.txt");
    assert.equal(await text(join(created.worktree_path, "first.txt")), "worker's draft\n");
    assert.equal(await text(join(created.worktree_path, "note.txt")), "untracked note\n");
    assert.equal(git(created.worktree_path, ["stash", "list"]), "");
    assert.equal(baseCommitInDb(home, created.id), created.base_commit);
  });
});

test("an untracked file that the new base now tracks is handled the same way", async () => {
  const home = await tempHome("supervisor-rebase-");
  const { dir } = await makeRepo(join(home, "repo"));
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const created = await call("create_codex_worker", dispatchArgs("newfile", dir));
    await waitFor(call, created.id, settled);
    const head = git(created.worktree_path, ["rev-parse", "HEAD"]);
    await writeFile(join(created.worktree_path, "new.txt"), "worker's new file\n");
    await advanceMain(dir, "new.txt", "main's new file\n");

    const refused = await call("resume_codex_worker", { task_id: created.id, prompt: "carry on", rebaseOnto: "main" });
    assert.equal(refused.error, "stash_conflict", JSON.stringify(refused).slice(0, 400));
    assert.equal(git(created.worktree_path, ["rev-parse", "HEAD"]), head);
    assert.equal(git(created.worktree_path, ["status", "--porcelain"]), "?? new.txt");
    assert.equal(await text(join(created.worktree_path, "new.txt")), "worker's new file\n");
    assert.equal(git(created.worktree_path, ["stash", "list"]), "");
  });
});

test("a machine where git has no identity still rebases, with the stand-in committer", async () => {
  const home = await tempHome("supervisor-rebase-");
  const { dir } = await makeRepo(join(home, "repo"));
  const noIdentity = {
    SUPERVISOR_HOME: home,
    FAKE_CODEX_SCENARIO: "commit-in-worktree",
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
    const created = await call("create_codex_worker", dispatchArgs("anon", dir));
    await waitFor(call, created.id, settled);
    const mainHead = await advanceMain(dir);
    const resumed = await call("resume_codex_worker", { task_id: created.id, prompt: "carry on", rebaseOnto: "main" });
    assert.ok(!resumed.error, JSON.stringify(resumed).slice(0, 400));
    assert.equal(resumed.base_commit, mainHead);
    await waitFor(call, created.id, settled);
    assert.equal(git(created.worktree_path, ["log", "-1", "--format=%cn <%ce>"]), "codex-supervisor <codex-supervisor@localhost>");
  });
});

test("a bad ref, a worker without a worktree, and a worker still running are refused without touching anything", async () => {
  const home = await tempHome("supervisor-rebase-");
  const { dir } = await makeRepo(join(home, "repo"));
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const created = await call("create_codex_worker", dispatchArgs("guarded", dir));
    await waitFor(call, created.id, settled);
    const bad = await call("resume_codex_worker", { task_id: created.id, prompt: "x", rebaseOnto: "does-not-exist" });
    assert.equal(bad.error, "invalid_rebase_onto");
    const inPlace = await call("create_codex_worker", dispatchArgs("in-place", join(home, "workspace")));
    await waitFor(call, inPlace.id, settled);
    const none = await call("resume_codex_worker", { task_id: inPlace.id, prompt: "x", rebaseOnto: "HEAD" });
    assert.equal(none.error, "no_worktree");
  });
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "hang" }, async ({ call }) => {
    const running = await call("create_codex_worker", dispatchArgs("busy", dir));
    await waitFor(call, running.id, (t) => t.phase === "thinking");
    const active = await call("resume_codex_worker", { task_id: running.id, prompt: "x", rebaseOnto: "HEAD" });
    assert.equal(active.error, "worker_active");
    await call("cancel_codex_worker", { task_id: running.id });
  });
});

test("a rewritten base is reported, and the rebase still replays only the worker's commit", async () => {
  const home = await tempHome("supervisor-rebase-");
  const { dir } = await makeRepo(join(home, "repo"));
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "commit-in-worktree" }, async ({ call }) => {
    const created = await call("create_codex_worker", dispatchArgs("amended", dir));
    await waitFor(call, created.id, settled);
    git(dir, ["commit", "-q", "--amend", "-m", "second, amended"]);
    const mainHead = await advanceMain(dir);
    const result = await call("get_worker_result", { task_id: created.id });
    assert.equal(result.base_behind.contains_base, false, "the base is no longer in main's history");
    const resumed = await call("resume_codex_worker", { task_id: created.id, prompt: "carry on", rebaseOnto: "main" });
    assert.ok(!resumed.error, JSON.stringify(resumed).slice(0, 400));
    assert.equal(resumed.rebase.replayed, 1, "main's own amended commit is not replayed as the worker's");
    assert.equal(resumed.base_commit, mainHead);
    await waitFor(call, created.id, settled);
  });
});

test("base_commit is recorded before the worker starts, so a launch failure cannot leave it stale", async () => {
  const home = await tempHome("supervisor-rebase-");
  const { dir } = await makeRepo(join(home, "repo"));
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "resume-fail" }, async ({ call }) => {
    const created = await call("create_codex_worker", dispatchArgs("unlucky", dir));
    await waitFor(call, created.id, settled);
    const mainHead = await advanceMain(dir);
    const resumed = await call("resume_codex_worker", { task_id: created.id, prompt: "carry on", rebaseOnto: "main" });
    assert.equal(resumed.base_commit, mainHead);
    await waitFor(call, created.id, (t) => t.status === "failed");
    assert.equal(baseCommitInDb(home, created.id), mainHead);
    assert.equal(git(created.worktree_path, ["rev-parse", "HEAD"]), mainHead);
  });
});
