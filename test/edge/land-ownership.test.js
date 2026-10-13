import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tempHome, makeRepo, withMcp, dispatchArgs, waitFor, git } from "./helpers.js";

test("landing rejects unowned commits and drafts before committing or moving either branch", async () => {
  const home = await tempHome("supervisor-land-owned-");
  const { dir } = await makeRepo(join(home, "repo"));
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const worker = await call("create_codex_worker", dispatchArgs("owned", dir, { ownedPaths: ["allowed.txt"] }));
    await waitFor(call, worker.id, (t) => t.status === "completed" && t.exit_code !== null);
    await writeFile(join(worker.worktree_path, "outside.txt"), "draft");
    const before = git(worker.worktree_path, ["rev-parse", "HEAD"]);
    const result = await call("land_codex_worker", { task_id: worker.id, commitMessage: "draft" });
    assert.equal(result.error, "outside_owned_paths");
    assert.deepEqual(result.outside_paths, ["outside.txt"]);
    assert.equal(git(worker.worktree_path, ["rev-parse", "HEAD"]), before);
    assert.equal(git(dir, ["rev-parse", "HEAD"]), before);
    const allowed = await call("land_codex_worker", { task_id: worker.id, commitMessage: "explicit exception", allowOutsideOwned: true });
    assert.ok(!allowed.error, JSON.stringify(allowed));
  });
});
