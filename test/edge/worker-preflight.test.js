import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { dispatchArgs, makeRepo, tempHome, waitFor, withMcp } from "./helpers.js";
import { normalizeObservedCommand } from "../../src/worker-preflight.js";

test("preflight matches the shell wrapper Codex emits around a command", () => {
  assert.equal(normalizeObservedCommand("/bin/zsh -lc 'git status --short'"), "git status --short");
  assert.equal(normalizeObservedCommand("/bin/bash -c \"node --version\""), "node --version");
  assert.equal(
    normalizeObservedCommand("/bin/zsh -lc \"go test ./pkg -run '\"'^TestThing$'\"' -count=1\""),
    "go test ./pkg -run '^TestThing$' -count=1"
  );
  assert.equal(normalizeObservedCommand("git status --short"), "git status --short");
});

async function runPreflight(call, cwd, options = {}) {
  const created = await call("preflight_codex_worker", {
    title: "target worker",
    cwd,
    sandbox: "workspace-write",
    ownedPaths: ["result.txt"],
    probeCommands: ["ls -la"],
    ...options
  });
  assert.ok(created.id, JSON.stringify(created));
  await waitFor(call, created.id, (task) => task.status === "completed" && task.exit_code !== null);
  return created;
}

test("a real worker preflight records command evidence and gates a matching dispatch", async () => {
  const home = await tempHome("supervisor-worker-preflight-");
  const { dir } = await makeRepo(join(home, "repo"));
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const preflight = await runPreflight(call, dir);
    const verdict = await call("get_worker_preflight", { task_id: preflight.id });
    assert.equal(verdict.status, "passed", JSON.stringify(verdict));
    assert.deepEqual(verdict.probes, [{ command: "ls -la", executed: true, exit_code: 0, status: "completed", passed: true }]);
    assert.match(verdict.contract_hash, /^[a-f0-9]{64}$/);

    const worker = await call("create_codex_worker", {
      ...dispatchArgs("gated target", dir, { sandbox: "workspace-write", ownedPaths: ["result.txt"] }),
      preflight_id: preflight.id
    });
    assert.ok(worker.id, JSON.stringify(worker));
  });
});

test("a preflight fails closed when required commands were not observed", async () => {
  const home = await tempHome("supervisor-worker-preflight-");
  const { dir } = await makeRepo(join(home, "repo"));
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const preflight = await runPreflight(call, dir, {
      allowedCommands: ["go test ./..."],
      probeCommands: ["go test ./..."]
    });
    const verdict = await call("get_worker_preflight", { task_id: preflight.id });
    assert.equal(verdict.status, "failed");
    assert.equal(verdict.probes[0].executed, false);

    const refused = await call("create_codex_worker", {
      ...dispatchArgs("failed preflight target", dir, {
        sandbox: "workspace-write",
        ownedPaths: ["result.txt"],
        allowedCommands: ["go test ./..."]
      }),
      preflight_id: preflight.id
    });
    assert.equal(refused.error, "preflight_not_passed");
  });
});

test("a preflight cannot be reused after its worker contract changes", async () => {
  const home = await tempHome("supervisor-worker-preflight-");
  const { dir } = await makeRepo(join(home, "repo"));
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const preflight = await runPreflight(call, dir);
    const refused = await call("create_codex_worker", {
      ...dispatchArgs("changed contract", dir, {
        sandbox: "workspace-write",
        ownedPaths: ["result.txt"],
        allowedCommands: ["npm test"]
      }),
      preflight_id: preflight.id
    });
    assert.equal(refused.error, "preflight_mismatch");
  });
});

test("a workspaceKind change invalidates a non-Git worker preflight", async () => {
  const home = await tempHome("supervisor-worker-preflight-workspace-");
  const source = join(home, "source");
  await mkdir(source, { recursive: true });
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const preflight = await call("preflight_codex_worker", {
      title: "scratch target",
      cwd: source,
      workspaceKind: "scratch",
      sandbox: "workspace-write",
      ownedPaths: [],
      networkAccess: true,
      probeCommands: ["ls -la"]
    });
    assert.ok(preflight.id, JSON.stringify(preflight));
    await waitFor(call, preflight.id, (task) => task.status === "completed" && task.exit_code !== null);
    const verdict = await call("get_worker_preflight", { task_id: preflight.id });
    assert.equal(verdict.status, "passed", JSON.stringify(verdict));

    const refused = await call("create_codex_worker", {
      ...dispatchArgs("in-place target", source, {
        sandbox: "workspace-write",
        workspaceKind: "in_place_write",
        inPlaceAuthorization: "User explicitly authorized this isolated non-Git fixture edit.",
        ownedPaths: ["result.txt"],
        acceptance: ["node -e \"process.exit(0)\""]
      }),
      preflight_id: preflight.id
    });
    assert.equal(refused.error, "preflight_mismatch");
  });
});
