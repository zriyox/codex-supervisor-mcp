import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { dispatchArgs, makeRepo, tempHome, waitFor, withMcp } from "./helpers.js";

test("the real Codex child starts inside its worktree, not the project checkout", async () => {
  const home = await tempHome("supervisor-worker-cwd-");
  const { dir } = await makeRepo(join(home, "repo"));
  const cwdLog = join(home, "cwd.log");
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_CWD_LOG: cwdLog }, async ({ call }) => {
    const created = await call("create_codex_worker", dispatchArgs("cwd", dir));
    assert.ok(created.id, JSON.stringify(created));
    await waitFor(call, created.id, (task) => task.status === "completed" && task.exit_code === 0);
    const cwd = (await readFile(cwdLog, "utf8")).trim().split("\n").at(-1);
    assert.equal(await realpath(cwd), await realpath(created.worktree_path));
    assert.notEqual(cwd, dir);
  });
});
