import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, readlink, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dispatchArgs, git, makeRepo, tempHome, waitFor, withMcp } from "./helpers.js";

const settled = (task) => ["completed", "failed", "cancelled", "lost"].includes(task.status) && task.exit_code !== null;

function writableRoots(args) {
  const flag = args.find((arg) => arg.startsWith("sandbox_workspace_write.writable_roots="));
  return flag ? JSON.parse(flag.slice("sandbox_workspace_write.writable_roots=".length)) : [];
}

test("workspaceSetup links dependencies, runs prepare, and exposes the link source and cache roots", async () => {
  const home = await tempHome("supervisor-workspace-setup-");
  const { dir } = await makeRepo(join(home, "repo"));
  await mkdir(join(dir, "node_modules"));
  await writeFile(join(dir, "node_modules", "installed.txt"), "shared\n");
  await writeFile(join(dir, ".gitignore"), "generated/\n");
  git(dir, ["add", ".gitignore"]);
  git(dir, ["commit", "-q", "-m", "ignore generated setup output"]);
  const argsLog = join(home, "args.jsonl");
  const setup = {
    links: [{ path: "node_modules", source: "node_modules" }],
    commands: ["mkdir -p generated && printf setup > generated/prepared.txt"]
  };
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_ARGS_LOG: argsLog }, async ({ call }) => {
    const preflight = await call("preflight_codex_worker", {
      title: "frontend",
      cwd: dir,
      sandbox: "workspace-write",
      ownedPaths: ["apps/web/src/page.vue"],
      workspaceSetup: setup,
      probeCommands: ["ls -la"]
    });
    assert.ok(preflight.id, JSON.stringify(preflight));
    await waitFor(call, preflight.id, settled);
    assert.equal((await call("get_worker_preflight", { task_id: preflight.id })).status, "passed");
    const first = await call("get_codex_worker_status", { task_id: preflight.id });
    assert.equal(await readlink(join(first.worktree_path, "node_modules")), join(dir, "node_modules"));
    assert.equal(await readFile(join(first.worktree_path, "generated", "prepared.txt"), "utf8"), "setup");

    const worker = await call("create_codex_worker", {
      ...dispatchArgs("frontend target", dir, {
        sandbox: "workspace-write",
        ownedPaths: ["apps/web/src/page.vue"],
        workspaceSetup: setup
      }),
      preflight_id: preflight.id
    });
    assert.ok(worker.id, JSON.stringify(worker));
    await waitFor(call, worker.id, settled);
    const second = await call("get_codex_worker_status", { task_id: worker.id });
    assert.equal(await readlink(join(second.worktree_path, "node_modules")), join(dir, "node_modules"));

    await mkdir(join(second.worktree_path, "apps", "web", "src"), { recursive: true });
    await writeFile(join(second.worktree_path, "apps", "web", "src", "page.vue"), "<template>ready</template>\n");
    const landed = await call("land_codex_worker", { task_id: worker.id, commitMessage: "land owned frontend file" });
    assert.ok(!landed.error, JSON.stringify(landed));
    assert.equal(git(dir, ["show", "HEAD:apps/web/src/page.vue"]), "<template>ready</template>");
    const committed = git(dir, ["ls-tree", "-r", "--name-only", "HEAD"]).split("\n");
    assert.equal(committed.some((path) => path === "node_modules" || path.startsWith("node_modules/")), false);
    assert.equal(committed.includes("generated/prepared.txt"), false);

    const runs = (await readFile(argsLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const canonicalDir = await realpath(dir);
    const expected = [
      join(canonicalDir, "node_modules"),
      ...[".vite", ".vite-temp", ".cache"].map((name) => join(canonicalDir, "node_modules", name))
    ];
    for (const run of runs.slice(-2)) assert.deepEqual(expected.filter((root) => !writableRoots(run.args).includes(root)), []);
  });
});

test("workspaceSetup failure aborts dispatch and removes its worktree", async () => {
  const home = await tempHome("supervisor-workspace-setup-fail-");
  const { dir } = await makeRepo(join(home, "repo"));
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const refused = await call("create_codex_worker", {
      ...dispatchArgs("prepare failure", dir, {
        sandbox: "workspace-write",
        ownedPaths: ["src/result.txt"],
        workspaceSetup: { commands: ["printf prepare-error >&2; exit 7"] }
      })
    });
    assert.match(refused.message ?? "", /workspaceSetup command failed/);
    const entries = await readdir(join(home, "worktrees")).catch(() => []);
    assert.deepEqual(entries.filter((entry) => entry.startsWith("codex-")), []);
  });
});

test("workspaceSetup initializes submodules from the shared object store", async () => {
  const home = await tempHome("supervisor-workspace-setup-submodule-");
  const { dir } = await makeRepo(join(home, "repo"));
  const proto = join(home, "proto");
  await makeRepo(proto);
  git(dir, ["-c", "protocol.file.allow=always", "submodule", "add", proto, "proto"]);
  git(dir, ["commit", "-q", "-m", "add proto submodule"]);
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const worker = await call("create_codex_worker", {
      ...dispatchArgs("submodule setup", dir, {
        sandbox: "workspace-write",
        ownedPaths: ["src/result.txt"],
        workspaceSetup: { submodules: true }
      })
    });
    assert.ok(worker.id, JSON.stringify(worker));
    await waitFor(call, worker.id, settled);
    const row = await call("get_codex_worker_status", { task_id: worker.id });
    assert.equal(await readFile(join(row.worktree_path, "proto", "first.txt"), "utf8"), "one\n");
  });
});

test("workspaceSetup changes invalidate a preflight contract", async () => {
  const home = await tempHome("supervisor-workspace-setup-contract-");
  const { dir } = await makeRepo(join(home, "repo"));
  await mkdir(join(dir, "node_modules"));
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const setup = { links: [{ path: "node_modules", source: "node_modules" }] };
    const preflight = await call("preflight_codex_worker", {
      title: "setup contract",
      cwd: dir,
      sandbox: "workspace-write",
      ownedPaths: ["src/result.txt"],
      workspaceSetup: setup,
      probeCommands: ["ls -la"]
    });
    await waitFor(call, preflight.id, settled);
    const refused = await call("create_codex_worker", {
      ...dispatchArgs("changed setup", dir, {
        sandbox: "workspace-write",
        ownedPaths: ["src/result.txt"],
        workspaceSetup: { ...setup, submodules: true }
      }),
      preflight_id: preflight.id
    });
    assert.equal(refused.error, "preflight_mismatch", JSON.stringify(refused));
  });
});

test("workspaceSetup is rejected outside git worktrees", async () => {
  const home = await tempHome("supervisor-workspace-setup-nongit-");
  const source = join(home, "source");
  await mkdir(source, { recursive: true });
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const refused = await call("create_codex_worker", {
      title: "non git setup",
      task: "inspect",
      cwd: source,
      workspaceKind: "read_only_in_place",
      sandbox: "read-only",
      ownedPaths: [],
      goal: { objective: "inspect" },
      workspaceSetup: { commands: ["true"] }
    });
    assert.match(refused.message ?? "", /only supported for git_worktree/);
  });
});
