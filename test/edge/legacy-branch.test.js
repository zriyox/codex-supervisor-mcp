// Workers dispatched before 1.0 live on codex/<id> and their rows name no
// branch. They must stay readable and landable after the upgrade.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { dispatchArgs, git, makeRepo, openStore, tempHome, waitFor, waitForRunHostExit, withMcp } from "./helpers.js";

test("a worker on an old codex/ branch can still be diffed and landed", async () => {
  const home = await tempHome("supervisor-legacy-branch-");
  const { dir } = await makeRepo(join(home, "repo"));
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "commit-in-worktree", AGENT_SUPERVISOR_NO_AUTO_CLEANUP: "1" }, async ({ call }) => {
    const worker = await call("create_worker", dispatchArgs("old", dir, { sandbox: { mode: "workspace-write" }, owned_paths: ["committed.txt", "uncommitted.txt"] }));
    await waitFor(call, worker.id, (task) => task.status === "completed" && task.exit_code === 0);
    await waitForRunHostExit(home, worker.id);
    assert.equal((await call("get_worker_diff", { task_id: worker.id })).branch, `worker/${worker.id}`);

    // Turn it into what an older version left behind.
    git(worker.worktree_path, ["branch", "-m", `codex/${worker.id}`]);
    const db = openStore(home);
    db.prepare("UPDATE tasks SET workspace_metadata = json_remove(workspace_metadata, '$.branch') WHERE id = ?").run(worker.id);
    db.close();

    const diff = await call("get_worker_diff", { task_id: worker.id });
    assert.equal(diff.branch, `codex/${worker.id}`);
    assert.ok(diff.files.some((file) => file.path === "committed.txt"), JSON.stringify(diff).slice(0, 300));
    const landed = await call("land_worker", { task_id: worker.id, commit_message: "land old worker" });
    assert.ok(!landed.error, JSON.stringify(landed));
    assert(existsSync(join(dir, "committed.txt")));
  });
});
