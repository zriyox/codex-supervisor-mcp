import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dispatchArgs, tempHome, waitFor, withMcp } from "./helpers.js";

async function makeDirectory(home, name) {
  const dir = join(home, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "source.txt"), "source material\n");
  return dir;
}

test("a non-Git workspace-write worker must choose scratch or explicitly authorized in_place_write", async () => {
  const home = await tempHome("supervisor-workspace-kind-refuse-");
  const source = await makeDirectory(home, "source");
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const refused = await call("create_codex_worker", dispatchArgs("non-git-write", source, {
      sandbox: "workspace-write",
      ownedPaths: ["notes.txt"]
    }));
    assert.equal(refused.error, "workspace_kind_required");
    assert.match(refused.message, /never writes a user directory by default/);
  });
});

test("read_only_in_place stays in the non-Git source directory without creating a worktree", async () => {
  const home = await tempHome("supervisor-workspace-read-only-");
  const source = await makeDirectory(home, "source");
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const worker = await call("create_codex_worker", dispatchArgs("read-only-in-place", source, {
      sandbox: "read-only",
      ownedPaths: [],
      workspaceKind: "read_only_in_place"
    }));
    const settled = await waitFor(call, worker.id, (task) => task.status === "completed" && task.exit_code === 0);
    assert.equal(settled.workspace_kind, "read_only_in_place");
    assert.equal(settled.cwd, source);
    assert.equal(settled.worktree_path, null);
  });
});

test("scratch runs in supervisor storage and never writes the non-Git source directory", async () => {
  const home = await tempHome("supervisor-workspace-scratch-");
  const source = await makeDirectory(home, "source");
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "commit-in-worktree" }, async ({ call }) => {
    const worker = await call("create_codex_worker", dispatchArgs("scratch", source, {
      sandbox: "workspace-write",
      ownedPaths: [],
      networkAccess: true,
      workspaceKind: "scratch"
    }));
    const settled = await waitFor(call, worker.id, (task) => task.status === "completed" && task.exit_code === 0);
    assert.equal(settled.workspace_kind, "scratch");
    assert.equal(settled.worktree_path, null);
    assert.match(settled.cwd, new RegExp(`${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/scratch/`));
    assert(existsSync(join(settled.cwd, "committed.txt")), "the worker wrote inside supervisor scratch");
    assert.equal(existsSync(join(source, "committed.txt")), false, "the source directory remains untouched");
  });
});

test("in_place_write requires authorization and acceptance, then records before and after manifests", async () => {
  const home = await tempHome("supervisor-workspace-in-place-");
  const source = await makeDirectory(home, "source");
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "commit-in-worktree" }, async ({ call }) => {
    const base = dispatchArgs("in-place", source, {
      sandbox: "workspace-write",
      ownedPaths: ["committed.txt"],
      workspaceKind: "in_place_write"
    });
    const withoutAuthorization = await call("create_codex_worker", base);
    assert.equal(withoutAuthorization.error, "invalid_in_place_workspace");

    const withoutAcceptance = await call("create_codex_worker", {
      ...base,
      inPlaceAuthorization: "User explicitly authorized this isolated non-Git fixture edit."
    });
    assert.equal(withoutAcceptance.error, "in_place_acceptance_required");

    const worker = await call("create_codex_worker", {
      ...base,
      inPlaceAuthorization: "User explicitly authorized this isolated non-Git fixture edit.",
      acceptance: ["node -e \"const fs=require('fs'); if (!fs.readFileSync('committed.txt','utf8').trim()) process.exit(1)\""]
    });
    await waitFor(call, worker.id, (task) => task.status === "completed" && task.exit_code === 0 && task.acceptance?.status !== "running");
    assert.match(await readFile(join(source, "committed.txt"), "utf8"), /hello/);
    const result = await call("get_worker_result", { task_id: worker.id });
    assert.equal(result.workspace_kind, "in_place_write");
    assert.equal(result.acceptance.passed, true, JSON.stringify(result.acceptance));
    assert.equal(result.run_evidence.workspace.manifest_changed, true);
    assert.notEqual(result.run_evidence.workspace.before_manifest.sha256, result.run_evidence.workspace.after_manifest.sha256);
    const landed = await call("land_codex_worker", { task_id: worker.id });
    assert.equal(landed.error, "workspace_kind_not_landable");
  });
});
