import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { tempHome, withMcp } from "./helpers.js";

test("check_workers quietly consumes each settled run once and persists an explicit observer", async () => {
  const home = await tempHome("supervisor-check-workers-");
  const env = { SUPERVISOR_HOME: home, CODEX_SUPERVISOR_OBSERVER_ID: "main-a" };
  await withMcp(env, async ({ call }) => {
    assert.equal((await call("check_workers")).quiet, true);
    const db = new DatabaseSync(join(home, "data", "supervisor.sqlite"));
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO tasks (id,title,worker,status,cwd,project_root,sandbox,prompt,created_at,updated_at,run_log,run_count,exit_code)
      VALUES ('finished','done','codex','completed',?,?,'read-only','test',?,?,'unused',1,0)`).run(home, home, now, now);
    db.close();
    const first = await call("check_workers");
    assert.equal(first.quiet, false);
    assert.equal(first.transitions[0].id, "finished");
    assert.equal((await call("check_workers")).quiet, true);
  });
  await withMcp(env, async ({ call }) => assert.equal((await call("check_workers")).quiet, true));
  await withMcp({ ...env, CODEX_SUPERVISOR_OBSERVER_ID: "main-b" }, async ({ call }) => assert.equal((await call("check_workers")).quiet, false));
});
