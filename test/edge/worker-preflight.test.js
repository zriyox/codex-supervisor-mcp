import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { dispatchArgs, makeRepo, tempHome, waitFor, withMcp, openStore } from "./helpers.js";
import { commandsEquivalent, normalizeObservedCommand } from "../../src/domain/worker-preflight.js";

test("preflight matches the shell wrapper Codex emits around a command", () => {
  assert.equal(normalizeObservedCommand("/bin/zsh -lc 'git status --short'"), "git status --short");
  assert.equal(normalizeObservedCommand("/bin/bash -c \"node --version\""), "node --version");
  assert.equal(
    normalizeObservedCommand("/bin/zsh -lc \"go test ./pkg -run '\"'^TestThing$'\"' -count=1\""),
    "go test ./pkg -run '^TestThing$' -count=1"
  );
  assert.equal(
    normalizeObservedCommand("/bin/zsh -lc \"head -5 '/Volumes/盘/千谲 项目/提示词.json'\""),
    "head -5 '/Volumes/盘/千谲 项目/提示词.json'"
  );
  assert.equal(
    commandsEquivalent("/bin/zsh -lc \"head -5 '/Volumes/盘/千谲/提示词.json'\"", "head -5 /Volumes/盘/千谲/提示词.json"),
    true
  );
  assert.equal(normalizeObservedCommand("git status --short"), "git status --short");
});

test("preflight reverses zsh history-expansion quotes around ! and quoted literals", () => {
  const observed = Buffer.from(
    "L2Jpbi96c2ggLWMgIm5vZGUgLWUgXCJjb25zdCBmcz1yZXF1aXJlKCdmcycpO2Zvcihjb25zdCBwIG9mIFsnbm9kZV9tb2R1bGVzL2V4YW1wbGUtZGVwL2luZGV4LmpzJywndmVuZG9yLWxpYi9saWIudHh0JywnLnByZXBhcmVkL3N0YXR1cycsJ+i1hOaWmS/or7TmmI4udHh0J10paWYoIichZnMuZXhpc3RzU3luYyhwKSlwcm9jZXNzLmV4aXQoMSk7Y29uc29sZS5sb2coJyInc2V0dXAtb2snKVwiIg==",
    "base64"
  ).toString("utf8");
  const expected = `node -e "const fs=require('fs');for(const p of ['node_modules/example-dep/index.js','vendor-lib/lib.txt','.prepared/status','资料/说明.txt'])if(!fs.existsSync(p))process.exit(1);console.log('setup-ok')"`;
  assert.equal(normalizeObservedCommand(observed), expected);
});

async function runPreflight(call, cwd, options = {}) {
  const created = await call("preflight_worker", {
    title: "target worker",
    cwd,
    sandbox: { mode: "workspace-write" },
    owned_paths: ["result.txt"],
    probe_commands: ["ls -la"],
    ...options
  });
  assert.ok(created.id, JSON.stringify(created));
  await waitFor(call, created.id, (task) => ["completed", "failed", "cancelled", "lost"].includes(task.status) && task.exit_code !== null);
  return created;
}

test("a real worker preflight records command evidence and gates a matching dispatch", async () => {
  const home = await tempHome("supervisor-worker-preflight-");
  const { dir } = await makeRepo(join(home, "repo"));
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const preflight = await runPreflight(call, dir);
    const verdict = await call("get_worker", { task_id: preflight.id, include: ["preflight"] });
    assert.equal(verdict.status, "passed", JSON.stringify(verdict));
    assert.deepEqual(verdict.probes, [{ command: "ls -la", executed: true, exit_code: 0, status: "completed", passed: true }]);
    assert.match(verdict.contract_hash, /^[a-f0-9]{64}$/);

    const worker = await call("create_worker", {
      ...dispatchArgs("gated target", dir, { sandbox: { mode: "workspace-write" }, owned_paths: ["result.txt"] }),
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
      sandbox: { allowed_commands: ["go test ./..."] },
      probe_commands: ["go test ./..."]
    });
    const verdict = await call("get_worker", { task_id: preflight.id, include: ["preflight"] });
    assert.equal(verdict.status, "failed");
    assert.equal(verdict.probes[0].executed, false);

    const refused = await call("create_worker", {
      ...dispatchArgs("failed preflight target", dir, {
        sandbox: { mode: "workspace-write", allowed_commands: ["go test ./..."] },
        owned_paths: ["result.txt"]
      }),
      preflight_id: preflight.id
    });
    assert.equal(refused.error, "preflight_not_passed");
  });
});

test("a valid probe survives an invalid final report and is not auto-resumed", async () => {
  const home = await tempHome("supervisor-worker-preflight-report-");
  const { dir } = await makeRepo(join(home, "repo"));
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_BAD_REPORT_ON_RUN: "1" }, async ({ call }) => {
    const preflight = await runPreflight(call, dir);
    const verdict = await call("get_worker", { task_id: preflight.id, include: ["preflight"] });
    assert.equal(verdict.status, "passed", JSON.stringify(verdict));
    assert.equal(verdict.worker_outcome.report_ignored, false, "preflight no longer fails the run for a report, so this stays diagnostic only");
    const checked = await call("poll_workers", { cursor: "observer" });
    assert.deepEqual(checked.recoveries, []);
  });
});

test("a valid probe survives a missing process exit and is not auto-resumed", async () => {
  const home = await tempHome("supervisor-worker-preflight-exit-");
  const { dir } = await makeRepo(join(home, "repo"));
  const preflightId = await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "command-then-no-terminal" }, async ({ call }) => {
    const preflight = await runPreflight(call, dir);
    const verdict = await call("get_worker", { task_id: preflight.id, include: ["preflight"] });
    assert.equal(verdict.status, "passed", JSON.stringify(verdict));
    assert.equal(verdict.worker_outcome.missing_exit_tolerated, true);
    const db = openStore(home);
    db.prepare("UPDATE tasks SET status = 'completed', exit_code = NULL WHERE id = ?").run(preflight.id);
    let recovered = await call("get_worker", { task_id: preflight.id, include: ["preflight"] });
    assert.equal(recovered.status, "passed", JSON.stringify(recovered));
    assert.equal(recovered.worker_outcome.missing_exit_tolerated, true);
    db.prepare("UPDATE tasks SET status = 'lost', exit_code = NULL WHERE id = ?").run(preflight.id);
    db.close();
    recovered = await call("get_worker", { task_id: preflight.id, include: ["preflight"] });
    assert.equal(recovered.status, "passed", JSON.stringify(recovered));
    assert.equal(recovered.worker_outcome.missing_exit_tolerated, true);
    return preflight.id;
  });
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "happy" }, async ({ call }) => {
    const target = await call("create_worker", {
      ...dispatchArgs("passed preflight target", dir, {
        sandbox: { mode: "workspace-write" },
        owned_paths: ["result.txt"]
      }),
      preflight_id: preflightId
    });
    assert.ok(target.id, JSON.stringify(target));
    assert.notEqual(target.error, "ownership_conflict");
    await waitFor(call, target.id, (task) => task.status === "completed" && task.exit_code === 0);
    const checked = await call("poll_workers", { cursor: "observer" });
    assert.deepEqual(checked.recoveries, []);
  });
});

test("a preflight cannot be reused after its worker contract changes", async () => {
  const home = await tempHome("supervisor-worker-preflight-");
  const { dir } = await makeRepo(join(home, "repo"));
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const preflight = await runPreflight(call, dir);
    const refused = await call("create_worker", {
      ...dispatchArgs("changed contract", dir, {
        sandbox: { mode: "workspace-write", allowed_commands: ["npm test"] },
        owned_paths: ["result.txt"]
      }),
      preflight_id: preflight.id
    });
    assert.equal(refused.error, "preflight_mismatch");
  });
});

test("probe commands are allowed for the probe run without entering the worker contract", async () => {
  const home = await tempHome("supervisor-worker-preflight-probe-allowlist-");
  const { dir } = await makeRepo(join(home, "repo"));
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const preflight = await runPreflight(call, dir, {
      sandbox: { allowed_commands: ["npm test"] },
      probe_commands: ["ssh test-host true", "head -5 /Volumes/盘/千谲/提示词.json"]
    });
    const db = openStore(home);
    const row = db.prepare("SELECT guard_policy FROM tasks WHERE id = ?").get(preflight.id);
    db.close();
    const policy = JSON.parse(row.guard_policy);
    assert.deepEqual(policy.allowedCommands, ["npm test", "ssh test-host true", "head -5 /Volumes/盘/千谲/提示词.json"]);
    assert.deepEqual(policy.preflight.contract.allowed_commands, ["npm test"], "probe-only grants must not enter the final runtime contract");
  });
});

test("a workspace.kind change invalidates a non-Git worker preflight", async () => {
  const home = await tempHome("supervisor-worker-preflight-workspace-");
  const source = join(home, "source");
  await mkdir(source, { recursive: true });
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const preflight = await call("preflight_worker", {
      title: "scratch target",
      cwd: source,
      workspace: { kind: "scratch" },
      sandbox: { mode: "workspace-write", network_access: true },
      owned_paths: [],
      probe_commands: ["ls -la"]
    });
    assert.ok(preflight.id, JSON.stringify(preflight));
    await waitFor(call, preflight.id, (task) => task.status === "completed" && task.exit_code !== null);
    const verdict = await call("get_worker", { task_id: preflight.id, include: ["preflight"] });
    assert.equal(verdict.status, "passed", JSON.stringify(verdict));

    const refused = await call("create_worker", {
      ...dispatchArgs("in-place target", source, {
        sandbox: { mode: "workspace-write" },
        workspace: { kind: "in_place_write", in_place_authorization: "User explicitly authorized this isolated non-Git fixture edit." },
        owned_paths: ["result.txt"],
        acceptance: { commands: ["node -e \"process.exit(0)\""] }
      }),
      preflight_id: preflight.id
    });
    assert.equal(refused.error, "preflight_mismatch");
  });
});

test("a preflight with unusable probe commands is refused before any worktree or branch exists", async () => {
  const home = await tempHome("supervisor-preflight-invalid-");
  const { dir: repo } = await makeRepo(join(home, "repo"));
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const refused = await call("preflight_worker", { title: "bad probe", cwd: repo, sandbox: { mode: "workspace-write" }, owned_paths: ["result.txt"], probe_commands: ["   "] });
    assert.match(JSON.stringify(refused), /probe_commands must be a nonempty list/);
  });
  const { execFileSync } = await import("node:child_process");
  assert.equal(execFileSync("git", ["-C", repo, "branch", "--list", "worker/*"], { encoding: "utf8" }).trim(), "", "no worker branch may be left behind");
  assert.equal(execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"], { encoding: "utf8" }).split("\n").filter((line) => line.startsWith("worktree ")).length, 1);
});
