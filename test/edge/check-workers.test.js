import { test } from "node:test";
import assert from "node:assert/strict";
import { tempHome, withMcp, openStore } from "./helpers.js";

test("a poll cursor reports each settled run once, survives a restart, and a new cursor starts over", async () => {
  const home = await tempHome("supervisor-check-workers-");
  const env = { SUPERVISOR_HOME: home };
  await withMcp(env, async ({ call }) => {
    assert.equal((await call("poll_workers", { cursor: "main-a" })).quiet, true);
    const db = openStore(home);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO tasks (id,title,worker,status,cwd,project_root,sandbox,prompt,created_at,updated_at,run_log,run_count,exit_code)
      VALUES ('finished','done','codex','completed',?,?,'read-only','test',?,?,'unused',1,0)`).run(home, home, now, now);
    db.close();
    const first = await call("poll_workers", { cursor: "main-a" });
    assert.equal(first.quiet, false);
    assert.equal(first.transitions[0].id, "finished");
    assert.equal((await call("poll_workers", { cursor: "main-a" })).quiet, true);
  });
  await withMcp(env, async ({ call }) => {
    assert.equal((await call("poll_workers", { cursor: "main-a" })).quiet, true, "the cursor is kept in the store, not in the process");
    assert.equal((await call("poll_workers", { cursor: "main-b" })).quiet, false, "another cursor has seen nothing yet");
    // The table hands out a cursor that is already up to date.
    const table = await call("poll_workers", {});
    assert.equal(table.workers.length, 1);
    assert.equal((await call("poll_workers", { cursor: table.next_cursor })).quiet, true);
  });
});
