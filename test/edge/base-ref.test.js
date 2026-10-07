// baseRef in every form git accepts, and every way it can be wrong.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { dispatchArgs, git, makeRepo, tempHome, waitFor, withMcp } from "./helpers.js";

test("tag, short sha, branch name and full sha all cut the worktree from that commit", async () => {
  const home = await tempHome("supervisor-baseref-");
  const { dir, first, second } = await makeRepo(join(home, "repo"));
  git(dir, ["branch", "side", first]);
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    for (const [label, ref] of [["tag", "v-first"], ["short sha", first.slice(0, 7)], ["branch", "side"], ["full sha", first]]) {
      const created = await call("create_codex_worker", dispatchArgs(`base-${label.replace(" ", "-")}`, dir, { baseRef: ref }));
      assert.equal(created.base_commit, first, `${label} must resolve to the first commit`);
      assert.equal(git(created.worktree_path, ["rev-parse", "HEAD"]), first, label);
      await waitFor(call, created.id, (t) => t.status === "completed");
    }
    assert.equal(git(dir, ["rev-parse", "HEAD"]), second, "the main checkout never moves");
  });
});

test("a worker cut from another worker's branch sees that worker's commit", async () => {
  const home = await tempHome("supervisor-baseref-");
  const { dir } = await makeRepo(join(home, "repo"));
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "commit-in-worktree" }, async ({ call }) => {
    const a = await call("create_codex_worker", dispatchArgs("step-a", dir));
    await waitFor(call, a.id, (t) => t.status === "completed");
    const aHead = git(a.worktree_path, ["rev-parse", "HEAD"]);
    assert.notEqual(aHead, a.base_commit, "worker a committed on its branch");
    const b = await call("create_codex_worker", dispatchArgs("step-b", dir, { baseRef: a.branch }));
    assert.equal(b.base_commit, aHead, "b starts where a finished");
    await waitFor(call, b.id, (t) => t.status === "completed");
    const result = await call("get_worker_result", { task_id: b.id });
    const names = result.changed_files.map((f) => f.split("/").pop()).sort();
    assert.deepEqual(names, ["committed.txt", "uncommitted.txt"], "b's own work only, not a's commit, is reported as b's change");
  });
});

test("an unknown ref, a ref in a non-git cwd, and an empty string are refused without leaving a row", async () => {
  const home = await tempHome("supervisor-baseref-");
  const { dir } = await makeRepo(join(home, "repo"));
  const plain = join(home, "plain");
  await mkdir(plain, { recursive: true });
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const unknown = await call("create_codex_worker", dispatchArgs("bad-1", dir, { baseRef: "does-not-exist" }));
    assert.equal(unknown.error, "invalid_base_ref");
    const nonGit = await call("create_codex_worker", dispatchArgs("bad-2", plain, { baseRef: "main" }));
    assert.equal(nonGit.error, "invalid_base_ref");
    const empty = await call("create_codex_worker", dispatchArgs("bad-3", dir, { baseRef: "" }));
    assert.ok(typeof empty === "string" || empty.error, "an empty baseRef fails schema validation");
    const rows = await call("list_codex_workers", { includeHistory: true });
    assert.equal(rows.filter((r) => r.title.startsWith("bad-")).length, 0);
  });
});

test("a repository with no commits yet gets no worktree and still runs", async () => {
  const home = await tempHome("supervisor-baseref-");
  const bare = join(home, "fresh");
  await mkdir(bare, { recursive: true });
  git(bare, ["init", "-q", "-b", "main"]);
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const created = await call("create_codex_worker", dispatchArgs("fresh", bare));
    assert.ok(created.id, JSON.stringify(created));
    assert.equal(created.worktree_path, null, "nothing to cut a worktree from");
    assert.equal(created.base_commit, null);
    assert.equal(created.cwd, bare);
    const final = await waitFor(call, created.id, (t) => t.status === "completed");
    assert.equal(final.status, "completed");
  });
});
