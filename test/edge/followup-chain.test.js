import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { dispatchArgs, git, makeRepo, tempHome, waitFor, waitForRunHostExit, withMcp } from "./helpers.js";

test("a follow-up starts from the parent worker branch and sees its commits", async () => {
  const home = await tempHome("supervisor-followup-base-");
  const { dir } = await makeRepo(join(home, "repo"));
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const parent = await call("create_codex_worker", dispatchArgs("parent chain", dir, {
      sandbox: "workspace-write", ownedPaths: ["parent.txt"], acceptance: ['node -e "process.exit(0)"']
    }));
    await waitFor(call, parent.id, (task) => task.status === "completed" && task.exit_code === 0);
    await waitForRunHostExit(home, parent.id);
    await writeFile(join(parent.worktree_path, "parent.txt"), "parent checkpoint\n");
    git(parent.worktree_path, ["add", "parent.txt"]);
    git(parent.worktree_path, ["commit", "-q", "-m", "parent checkpoint"]);
    const parentHead = git(parent.worktree_path, ["rev-parse", "HEAD"]);
    await writeFile(join(parent.worktree_path, "draft.txt"), "uncommitted parent draft\n");

    const child = await call("create_codex_followup_worker", {
      task_id: parent.id,
      followup_prompt: "continue from the committed parent state",
      ownedPaths: ["child.txt"],
      acceptance: ['node -e "process.exit(0)"']
    });
    assert.ok(!child.error, JSON.stringify(child));
    assert.equal(child.base_commit, parentHead, JSON.stringify(child));
    assert.equal((await readFile(join(child.worktree_path, "parent.txt"), "utf8")).trim(), "parent checkpoint");
    assert.equal(existsSync(join(child.worktree_path, "draft.txt")), false);
    await waitFor(call, child.id, (task) => task.status === "completed" && task.exit_code === 0);
    await waitForRunHostExit(home, child.id);
    git(dir, ["worktree", "remove", child.worktree_path]);
    git(dir, ["branch", "-D", `codex/${child.id}`]);
    const missing = await call("create_codex_followup_worker", {
      task_id: child.id, followup_prompt: "must keep parent checkpoint"
    });
    assert.equal(missing.error, "followup_checkpoint_missing", JSON.stringify(missing));
  });
});

test("land_codex_worker can land an unlanded follow-up chain root first", async () => {
  const home = await tempHome("supervisor-followup-land-");
  const { dir } = await makeRepo(join(home, "repo"));
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const parent = await call("create_codex_worker", dispatchArgs("chain parent", dir, {
      sandbox: "workspace-write", ownedPaths: ["parent.txt"], acceptance: ['node -e "process.exit(0)"']
    }));
    await waitFor(call, parent.id, (task) => task.status === "completed" && task.exit_code === 0);
    await waitForRunHostExit(home, parent.id);
    await writeFile(join(parent.worktree_path, "parent.txt"), "parent\n");
    git(parent.worktree_path, ["add", "parent.txt"]);
    git(parent.worktree_path, ["commit", "-q", "-m", "parent"]);

    const child = await call("create_codex_followup_worker", {
      task_id: parent.id,
      followup_prompt: "add the child file",
      ownedPaths: ["child.txt"],
      acceptance: ['node -e "process.exit(0)"']
    });
    assert.ok(!child.error, JSON.stringify(child));
    await waitFor(call, child.id, (task) => task.status === "completed" && task.exit_code === 0);
    await waitForRunHostExit(home, child.id);
    await writeFile(join(child.worktree_path, "child.txt"), "child\n");
    git(child.worktree_path, ["add", "child.txt"]);
    git(child.worktree_path, ["commit", "-q", "-m", "child"]);

    const partial = await call("land_codex_worker", { task_id: child.id });
    assert.equal(partial.error, "followup_parents_not_landed", JSON.stringify(partial));
    const landed = await call("land_codex_worker", { task_id: child.id, includeFollowupParents: true });
    assert.ok(!landed.error, JSON.stringify(landed));
    assert.equal(landed.chain.length, 2, JSON.stringify(landed));
    assert.equal((await readFile(join(dir, "parent.txt"), "utf8")).trim(), "parent");
    assert.equal((await readFile(join(dir, "child.txt"), "utf8")).trim(), "child");
    assert(existsSync(join(parent.worktree_path, "parent.txt")));
    assert(existsSync(join(child.worktree_path, "child.txt")));

    // A worker-side HEAD is never equal to the target-side cherry-pick SHA.
    // Re-running the chain must prove the already-landed tasks from their
    // patches, not from an impossible HEAD comparison.
    const again = await call("land_codex_worker", { task_id: child.id, includeFollowupParents: true });
    assert.ok(!again.error, JSON.stringify(again));
    assert.deepEqual(again.chain.map((entry) => entry.skipped), ["already_in_target", "already_in_target"], JSON.stringify(again));
    git(dir, ["worktree", "remove", parent.worktree_path]);
    const withoutParentTree = await call("land_codex_worker", { task_id: child.id, includeFollowupParents: true });
    assert.ok(!withoutParentTree.error, JSON.stringify(withoutParentTree));
    assert.equal(withoutParentTree.chain[0].skipped, "already_landed");
    git(dir, ["switch", "-c", "unrelated-target", "v-first"]);
    const wrongTarget = await call("land_codex_worker", { task_id: child.id, includeFollowupParents: true });
    assert.equal(wrongTarget.error, "followup_chain_land_failed", JSON.stringify(wrongTarget));
    assert.equal(wrongTarget.chain[0].error, "landed_commit_unreachable", JSON.stringify(wrongTarget));
  });
});

test("chain landing skips an ancestor already applied to the target by patch", async () => {
  const home = await tempHome("supervisor-followup-already-in-target-");
  const { dir } = await makeRepo(join(home, "repo"));
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const parent = await call("create_codex_worker", dispatchArgs("manual parent", dir, {
      sandbox: "workspace-write", ownedPaths: ["parent.txt", "large.bin"], acceptance: ['node -e "process.exit(0)"']
    }));
    await waitFor(call, parent.id, (task) => task.status === "completed" && task.exit_code === 0);
    await waitForRunHostExit(home, parent.id);
    await writeFile(join(parent.worktree_path, "parent.txt"), "manual parent\n");
    await writeFile(join(parent.worktree_path, "large.bin"), "x".repeat(1_200_000));
    git(parent.worktree_path, ["add", "parent.txt", "large.bin"]);
    git(parent.worktree_path, ["commit", "-q", "-m", "manual parent"]);
    git(dir, ["cherry-pick", git(parent.worktree_path, ["rev-parse", "HEAD"])]);
    const parentTargetHead = git(dir, ["rev-parse", "HEAD"]);

    const child = await call("create_codex_followup_worker", {
      task_id: parent.id,
      followup_prompt: "add only the child file",
      ownedPaths: ["child.txt"],
      acceptance: ['node -e "process.exit(0)"']
    });
    await waitFor(call, child.id, (task) => task.status === "completed" && task.exit_code === 0);
    await waitForRunHostExit(home, child.id);
    await writeFile(join(child.worktree_path, "child.txt"), "child\n");
    git(child.worktree_path, ["add", "child.txt"]);
    git(child.worktree_path, ["commit", "-q", "-m", "child"]);

    const landed = await call("land_codex_worker", { task_id: child.id, includeFollowupParents: true });
    assert.ok(!landed.error, JSON.stringify(landed));
    assert.equal(landed.chain[0].skipped, "already_in_target", JSON.stringify(landed));
    const parentResult = await call("get_worker_result", { task_id: parent.id });
    assert.equal(parentResult.landed.at != null, true, JSON.stringify(parentResult));
    assert.equal(parentResult.landed.head, parentTargetHead, JSON.stringify(parentResult));
    assert.equal((await readFile(join(dir, "child.txt"), "utf8")).trim(), "child");
  });
});

test("a follow-up from an already landed parent starts at the current target, not the old worker branch", async () => {
  const home = await tempHome("supervisor-followup-landed-parent-");
  const { dir } = await makeRepo(join(home, "repo"));
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const parent = await call("create_codex_worker", dispatchArgs("landed parent", dir, {
      sandbox: "workspace-write", ownedPaths: ["parent.txt"], acceptance: ['node -e "process.exit(0)"']
    }));
    await waitFor(call, parent.id, (task) => task.status === "completed" && task.exit_code === 0);
    await waitForRunHostExit(home, parent.id);
    await writeFile(join(parent.worktree_path, "parent.txt"), "parent\n");
    git(parent.worktree_path, ["add", "parent.txt"]);
    git(parent.worktree_path, ["commit", "-q", "-m", "parent"]);

    const landed = await call("land_codex_worker", { task_id: parent.id });
    assert.ok(!landed.error, JSON.stringify(landed));
    await writeFile(join(dir, "later.txt"), "later target work\n");
    git(dir, ["add", "later.txt"]);
    git(dir, ["commit", "-q", "-m", "target moved after parent landed"]);
    const targetHead = git(dir, ["rev-parse", "HEAD"]);

    const child = await call("create_codex_followup_worker", {
      task_id: parent.id,
      followup_prompt: "continue from the current target",
      ownedPaths: ["child.txt"],
      acceptance: ['node -e "process.exit(0)"']
    });
    assert.ok(!child.error, JSON.stringify(child));
    assert.equal(child.base_commit, targetHead, JSON.stringify(child));
    assert.equal((await readFile(join(child.worktree_path, "later.txt"), "utf8")).trim(), "later target work");
  });
});

test("an empty parent does not prevent its follow-up from landing", async () => {
  const home = await tempHome("supervisor-followup-empty-parent-");
  const { dir } = await makeRepo(join(home, "repo"));
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const parent = await call("create_codex_worker", dispatchArgs("empty parent", dir, {
      sandbox: "read-only", ownedPaths: []
    }));
    await waitFor(call, parent.id, (task) => task.status === "completed" && task.exit_code === 0);
    await waitForRunHostExit(home, parent.id);
    const child = await call("create_codex_followup_worker", {
      task_id: parent.id, followup_prompt: "write child.txt", sandbox: "workspace-write",
      ownedPaths: ["child.txt"], acceptance: ['node -e "process.exit(0)"']
    });
    assert.ok(child.id, JSON.stringify(child));
    await waitFor(call, child.id, (task) => task.status === "completed" && task.exit_code === 0);
    await waitForRunHostExit(home, child.id);
    await writeFile(join(child.worktree_path, "child.txt"), "child\n");
    const landed = await call("land_codex_worker", {
      task_id: child.id, includeFollowupParents: true, commitMessage: "land child of empty parent"
    });
    assert.ok(!landed.error, JSON.stringify(landed));
    assert.equal(landed.chain[0].skipped, "no_changes", JSON.stringify(landed));
    assert.equal((await readFile(join(dir, "child.txt"), "utf8")).trim(), "child");
  });
});
