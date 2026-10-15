// A worker is not only an editor. These are the shapes a research, review or
// retrieval run takes: read-only, or a workspace-write scratch run that lands
// nothing. Reading is never exclusive, writing still is.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dispatchArgs, makeRepo, tempHome, waitFor, withMcp } from "./helpers.js";

async function argsLogRuns(path) {
  return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("two workers may read the same shared file at the same time", async () => {
  const home = await tempHome("supervisor-shared-read-");
  const { dir: repo } = await makeRepo(join(home, "repo"));
  const shared = join(repo, "shared.txt");
  await writeFile(shared, "the same input both need\n");
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "hang" }, async ({ call }) => {
    const reader = (title) => call("create_codex_worker", dispatchArgs(title, repo, {
      sandbox: "read-only", ownedPaths: [], context: [{ path: shared }]
    }));
    const [a, b] = await Promise.all([reader("read-a"), reader("read-b")]);
    assert.ok(a.id, `the first reader was refused: ${JSON.stringify(a)}`);
    assert.ok(b.id, `reading the same input must not conflict: ${JSON.stringify(b)}`);
    const live = await Promise.all([a, b].map((worker) => call("get_codex_worker_status", { task_id: worker.id })));
    for (const [index, status] of live.entries()) {
      assert.equal(status.status, "running", `reader ${index + 1} must be running while the other one is: ${JSON.stringify(status)}`);
    }
    for (const worker of [a, b]) await call("cancel_codex_worker", { task_id: worker.id });
  });
});

test("a research worker fetches with network and lands nothing", async () => {
  const home = await tempHome("supervisor-research-");
  const { dir: repo } = await makeRepo(join(home, "repo"));
  const argsLog = join(home, "codex-args.jsonl");
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "commit-in-worktree", FAKE_CODEX_ARGS_LOG: argsLog }, async ({ call }) => {
    const worker = await call("create_codex_worker", dispatchArgs("research", repo, {
      sandbox: "workspace-write", ownedPaths: [], networkAccess: true
    }));
    assert.ok(worker.id, `a no-land research worker must be dispatchable: ${JSON.stringify(worker)}`);
    // completed with exit_code null is an intermediate state; land also waits
    // for the run to be fully settled.
    await waitFor(call, worker.id, (task) => task.status === "completed" && task.exit_code !== null);
    const landed = await call("land_codex_worker", { task_id: worker.id, commitMessage: "research notes" });
    assert.equal(landed.error, "outside_owned_paths", "nothing a no-land worker produced may be merged");
  });
  const run = (await argsLogRuns(argsLog)).find((entry) => entry.args.includes("--output-schema"));
  assert.ok(run.args.includes("sandbox_workspace_write.network_access=true"), `network must be on: ${run.args.join(" ")}`);
  assert.equal(run.guard.sandbox, "workspace-write");
  assert.deepEqual(run.guard.ownedPaths, [], "the guard sees a worker that lands nothing");
});

test("the read-only sandbox is never asked for network it does not have", async () => {
  const home = await tempHome("supervisor-readonly-net-");
  const { dir: repo } = await makeRepo(join(home, "repo"));
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const refused = await call("create_codex_worker", dispatchArgs("verify", repo, {
      sandbox: "read-only", ownedPaths: [], networkAccess: true
    }));
    assert.match(refused.message ?? "", /read-only sandbox has no network/);
    assert.match(refused.message ?? "", /ownedPaths: \[\]/, "the message names the shape that does fetch");
  });
});

test("a read-only worker is told it cannot write and gets no command allowlist", async () => {
  const home = await tempHome("supervisor-readonly-prompt-");
  const { dir: repo } = await makeRepo(join(home, "repo"));
  const argsLog = join(home, "codex-args.jsonl");
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_ARGS_LOG: argsLog }, async ({ call }) => {
    const worker = await call("create_codex_worker", dispatchArgs("review", repo, { sandbox: "read-only", ownedPaths: [] }));
    await waitFor(call, worker.id, (task) => task.status === "completed");
  });
  const run = (await argsLogRuns(argsLog)).find((entry) => entry.args.includes("--output-schema"));
  assert.equal(run.guard.sandbox, "read-only");
  assert.deepEqual(run.guard.ownedPaths, []);
});

test("the guard preamble states each worker's write boundary", async () => {
  const { buildGuardPreamble } = await import("../../src/prompt.js");
  const readOnly = buildGuardPreamble({ sandbox: "read-only", ownedPaths: [], forbid: ["rm -rf"] });
  assert.match(readOnly, /read-only task/);
  assert.match(readOnly, /denies every file write/);
  assert.doesNotMatch(readOnly, /apply_patch/, "a read-only worker is not told to edit");
  const research = buildGuardPreamble({ sandbox: "workspace-write", ownedPaths: [], networkAccess: true, forbid: [] });
  assert.match(research, /lands nothing/);
  assert.match(research, /Network is available/);
  const writer = buildGuardPreamble({ sandbox: "workspace-write", ownedPaths: ["/tmp/x"], allowedCommands: ["npm test"], forbid: [] });
  assert.match(writer, /edits must use apply_patch within \["\/tmp\/x"\]/);
  assert.match(writer, /npm test/);
});
