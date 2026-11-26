import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { dispatchArgs, makeRepo, tempHome, waitFor, withMcp } from "./helpers.js";

async function createLandedWorker(call, repo) {
  const upstream = await call("create_worker", dispatchArgs("upstream", repo, {
    sandbox: { mode: "workspace-write" },
    owned_paths: ["committed.txt", "uncommitted.txt"]
  }));
  assert.ok(upstream.id, JSON.stringify(upstream));
  await waitFor(call, upstream.id, (task) => task.status === "completed" && task.exit_code === 0);
  const landed = await call("land_worker", { task_id: upstream.id, commit_message: "land upstream draft" });
  assert.ok(!landed.error, JSON.stringify(landed));
  return upstream;
}

test("a dependent worker cannot start before its upstream settles and lands", async () => {
  const home = await tempHome("supervisor-dependency-");
  const { dir } = await makeRepo(join(home, "repo"));
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "hang" }, async ({ call }) => {
    const upstream = await call("create_worker", dispatchArgs("running upstream", dir));
    await waitFor(call, upstream.id, (task) => task.status === "running");
    const refused = await call("create_worker", dispatchArgs("blocked downstream", dir, {
      owned_paths: ["downstream.txt"],
      depends_on: [upstream.id]
    }));
    assert.equal(refused.error, "dependency_not_ready");
    await call("cancel_worker", { task_id: upstream.id });
  });
});

test("a completed but unlanded dependency still blocks dispatch", async () => {
  const home = await tempHome("supervisor-dependency-");
  const { dir } = await makeRepo(join(home, "repo"));
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const upstream = await call("create_worker", dispatchArgs("unlanded upstream", dir));
    await waitFor(call, upstream.id, (task) => task.status === "completed" && task.exit_code === 0);
    const refused = await call("create_worker", dispatchArgs("blocked downstream", dir, {
      owned_paths: ["downstream.txt"],
      depends_on: [upstream.id]
    }));
    assert.equal(refused.error, "dependency_not_landed");
  });
});

test("a dependent worker requires an integrated base from the same project", async () => {
  const home = await tempHome("supervisor-dependency-");
  const { dir } = await makeRepo(join(home, "repo"));
  const { dir: other } = await makeRepo(join(home, "other-repo"));
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "commit-in-worktree" }, async ({ call }) => {
    const upstream = await createLandedWorker(call, dir);
    const stale = await call("create_worker", dispatchArgs("stale downstream", dir, {
      owned_paths: ["downstream.txt"],
      depends_on: [upstream.id],
      workspace: { base_ref: "v-first" }
    }));
    assert.equal(stale.error, "dependency_base_mismatch");

    const crossProject = await call("create_worker", dispatchArgs("cross project downstream", other, {
      owned_paths: ["downstream.txt"],
      depends_on: [upstream.id]
    }));
    assert.equal(crossProject.error, "dependency_project_mismatch");

    const downstream = await call("create_worker", dispatchArgs("ready downstream", dir, {
      owned_paths: ["downstream.txt"],
      depends_on: [upstream.id]
    }));
    assert.ok(downstream.id, JSON.stringify(downstream));
    const facts = await call("facts", { task_id: downstream.id, query: "landed_delivery_summary", action: "search" });
    assert.equal(facts.facts.length, 1);
    assert.equal(facts.facts[0].scope, "dependency");
    assert.equal(facts.facts[0].state, "verified");
  });
});
