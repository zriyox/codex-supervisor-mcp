// Real multi-project smoke for the orchestration boundary: two repositories
// prepare dependencies/submodules independently, pass their own preflight,
// run Codex workers concurrently, expose stage checkpoints and land only their
// owned output. This intentionally uses the real Codex CLI and a real model.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, "..");
const home = await mkdtemp(join(tmpdir(), "supervisor-multi-real-"));
const runGit = (cwd, args) => execFileSync("git", args, { cwd, stdio: "pipe" });

async function createRepo(name, vendor) {
  const root = join(home, name);
  await mkdir(join(root, "资料"), { recursive: true });
  await mkdir(join(root, "node_modules", "example-dep"), { recursive: true });
  await writeFile(join(root, ".gitignore"), "node_modules/\n.prepared/\n");
  await writeFile(join(root, "README.md"), `# ${name}\n`);
  await writeFile(join(root, "资料", "说明.txt"), "中文预检通过\n");
  await writeFile(join(root, "node_modules", "example-dep", "index.js"), "module.exports = 'dependency ready';\n");
  runGit(root, ["init", "-q", "-b", "main"]);
  runGit(root, ["config", "user.email", "test@example.com"]);
  runGit(root, ["config", "user.name", "Supervisor Multi Project Test"]);
  runGit(root, ["add", "."]);
  runGit(root, ["commit", "-q", "-m", "init"]);
  runGit(root, ["-c", "protocol.file.allow=always", "submodule", "add", vendor, "vendor-lib"]);
  runGit(root, ["commit", "-q", "-am", "add vendor submodule"]);
  return root;
}

const vendor = join(home, "vendor-source");
await mkdir(vendor, { recursive: true });
runGit(vendor, ["init", "-q", "-b", "main"]);
runGit(vendor, ["config", "user.email", "test@example.com"]);
runGit(vendor, ["config", "user.name", "Supervisor Multi Project Test"]);
await writeFile(join(vendor, "lib.txt"), "submodule ready\n");
runGit(vendor, ["add", "."]);
runGit(vendor, ["commit", "-q", "-m", "init vendor"]);

const projects = [
  { name: "project-a", label: "A", file: "A.md", repo: await createRepo("project-a", vendor) },
  { name: "project-b", label: "B", file: "B.md", repo: await createRepo("project-b", vendor) }
];

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(projectRoot, "src", "mcp-server.js")],
  cwd: projectRoot,
  env: { ...process.env, SUPERVISOR_HOME: home, CODEX_SUPERVISOR_NO_UPDATE_CHECK: "1" },
  stderr: "pipe"
});
const client = new Client({ name: "supervisor-multi-project-real", version: "1.0.0" });
await client.connect(transport);
const parse = (result) => JSON.parse(result.content?.[0]?.text ?? "null");
const call = (name, args = {}) => client.callTool({ name, arguments: args }).then(parse);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(taskId, predicate, timeoutMs = 420000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await call("get_codex_worker_status", { task_id: taskId });
    if (predicate(last)) return last;
    await sleep(250);
  }
  throw new Error(`timed out for ${taskId}: ${JSON.stringify(last)?.slice(0, 800)}`);
}

try {
  const setup = {
    links: [{ path: "node_modules", source: "node_modules" }],
    submodules: true,
    commands: ["mkdir -p .prepared && printf ready > .prepared/status"]
  };
  const probes = [
    "node --version",
    "test -f node_modules/example-dep/index.js",
    "test -f vendor-lib/lib.txt",
    "test -f .prepared/status",
    "test -f 资料/说明.txt"
  ];
  const chineseProbe = "head -n 1 资料/说明.txt | grep 中文";

  const preflights = await Promise.all(projects.map((project) => call("preflight_codex_worker", {
    title: project.name,
    cwd: project.repo,
    sandbox: "workspace-write",
    reasoningEffort: "low",
    ownedPaths: [project.file],
    allowedCommands: ["sleep 5"],
    workspaceSetup: setup,
    baseRef: "HEAD",
    probeCommands: [...probes, chineseProbe]
  })));
  for (const [index, receipt] of preflights.entries()) {
    assert.ok(receipt.id, JSON.stringify(receipt));
    const result = await waitFor(receipt.id, (task) => task.status !== "running" && task.status !== "queued", 240000);
    assert.ok(["completed", "failed", "lost"].includes(result.status), JSON.stringify(result));
    const verdict = await call("get_worker_preflight", { task_id: receipt.id });
    assert.equal(verdict.status, "passed", JSON.stringify({ index, verdict, result }));
    projects[index].preflightId = receipt.id;
    console.log(`preflight ${projects[index].name}: passed`);
  }

  const sessionId = `multi-project-${Date.now()}`;
  const dispatched = await Promise.all(projects.map((project) => {
    const acceptance = `node -e "const fs=require('fs');if(fs.readFileSync('${project.file}','utf8').trim()!=='${project.label} ready')process.exit(1);console.log('${project.label} acceptance passed')"`;
    return call("create_codex_worker", {
      title: `${project.name} real worker`,
      session_id: sessionId,
      session_title: "multi-project real smoke",
      task: `Create ${project.file} with exactly the line "${project.label} ready" using apply_patch. Before editing, run node "$CODEX_SUPERVISOR_STAGE_CLI" "gate:${project.label}" --detail "dependencies ready", then run sleep 5 exactly. Do not touch any other file. Follow the supervisor final JSON report format exactly.`,
      cwd: project.repo,
      sandbox: "workspace-write",
      reasoningEffort: "low",
      ownedPaths: [project.file],
      allowedCommands: ["sleep 5"],
      workspaceSetup: setup,
      baseRef: "HEAD",
      preflight_id: project.preflightId,
      acceptance: [acceptance],
      goal: { objective: `In ${project.name}, prove isolated dependencies and create ${project.file}` }
    });
  }));
  for (const receipt of dispatched) assert.ok(receipt.id, JSON.stringify(receipt));

  const observedStages = new Set();
  const finals = await Promise.all(dispatched.map((receipt, index) => waitFor(receipt.id, (task) => {
    if (task.current_stage) observedStages.add(`${projects[index].label}:${task.current_stage}`);
    return ["completed", "failed", "cancelled", "lost"].includes(task.status) && task.exit_code !== null;
  })));
  const overlapMs = Math.min(...finals.map((task) => Date.parse(task.completed_at)))
    - Math.max(...finals.map((task) => Date.parse(task.started_at)));
  assert.ok(overlapMs > 0, `workers did not overlap: ${JSON.stringify(finals.map(({ started_at, completed_at }) => ({ started_at, completed_at })))}`);
  console.log(`concurrent worker overlap: ${overlapMs}ms`);

  for (const [index, final] of finals.entries()) {
    const project = projects[index];
    let settled = final;
    if (settled.attention_reason === "invalid_report") {
      await call("resume_codex_worker", {
        task_id: dispatched[index].id,
        prompt: `Keep ${project.file} unchanged. Rerun the declared acceptance and return the required final JSON report with closed objects and arrays.`
      });
      settled = await waitFor(dispatched[index].id, (task) => ["completed", "failed", "cancelled", "lost"].includes(task.status) && task.exit_code !== null);
    }
    assert.equal(settled.status, "completed", JSON.stringify(settled));
    assert.equal(settled.acceptance, "passed", JSON.stringify(settled));
    assert.equal(settled.last_stage, `gate:${project.label}`, JSON.stringify(settled));
    assert.ok(settled.changed_files.some((path) => path.endsWith(project.file)), JSON.stringify(settled.changed_files));

    const worktreeLink = await lstat(join(settled.worktree_path, "node_modules"));
    assert.equal(worktreeLink.isSymbolicLink(), true, "node_modules should be linked into the worker worktree");
    assert.equal((await readFile(join(settled.worktree_path, "vendor-lib", "lib.txt"), "utf8")).trim(), "submodule ready");
    assert.equal((await readFile(join(settled.worktree_path, ".prepared", "status"), "utf8")).trim(), "ready");

    const diffIndex = await call("get_worker_diff", { task_id: dispatched[index].id });
    assert.equal(diffIndex.summary_only, true);
    assert.ok(diffIndex.files.some((entry) => entry.path === project.file));
    const page = await call("get_worker_diff", { task_id: dispatched[index].id, file: project.file, pageSize: 1 });
    assert.match(page.hunks[0].patch, new RegExp(`${project.label} ready`));
    const landed = await call("land_codex_worker", { task_id: dispatched[index].id, commitMessage: `Land ${project.file}` });
    assert.ok(!landed.error, JSON.stringify(landed));
    assert.equal((await readFile(join(project.repo, project.file), "utf8")).trim(), `${project.label} ready`);
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: project.repo, encoding: "utf8" }).trim(), "");
    console.log(`worker ${project.name}: acceptance passed, stage=${settled.last_stage}, landed`);
  }

  assert.equal(observedStages.size >= 1, true, `live stage was never observed: ${[...observedStages]}`);
  const session = await call("get_session_works", { session_id: sessionId });
  assert.equal(session.count, 2);
  console.log(`live stages observed: ${[...observedStages].join(", ")}`);
  console.log(`multi-project real smoke passed (state dir: ${home})`);
} finally {
  await client.close();
}
