// Shared scaffolding for the edge tests: a temp supervisor home, an MCP
// client over stdio against the real server, a fake npm registry, a git
// repository with history, and a tiny HTTP client for the web view.
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const fakeCodex = join(repoRoot, "src", "test-fixtures", "fake-codex.js");
export const packageVersion = JSON.parse(
  await import("node:fs/promises").then((fs) => fs.readFile(join(repoRoot, "package.json"), "utf8"))
).version;

export async function tempHome(prefix = "supervisor-edge-") {
  const home = await mkdtemp(join(tmpdir(), prefix));
  const workspace = join(home, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "README.md"), "edge fixture\n");
  git(workspace, ["init", "-q", "-b", "main"]);
  git(workspace, ["add", "README.md"]);
  git(workspace, ["commit", "-q", "-m", "fixture"]);
  return home;
}

export const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "edge",
  GIT_AUTHOR_EMAIL: "edge@example.com",
  GIT_COMMITTER_NAME: "edge",
  GIT_COMMITTER_EMAIL: "edge@example.com"
};

export function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: gitEnv, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

// A repository with two commits on main and a tag on the first.
export async function makeRepo(dir) {
  await mkdir(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  await writeFile(join(dir, "first.txt"), "one\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "first"]);
  const first = git(dir, ["rev-parse", "HEAD"]);
  git(dir, ["tag", "v-first"]);
  await writeFile(join(dir, "second.txt"), "two\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "second"]);
  const second = git(dir, ["rev-parse", "HEAD"]);
  return { dir, first, second };
}

export async function withMcp(env, fn) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(repoRoot, "src", "mcp-server.js")],
    cwd: repoRoot,
    env: { ...process.env, CODEX_BIN: fakeCodex, CODEX_SUPERVISOR_NO_UPDATE_CHECK: "1", ...env },
    stderr: "pipe"
  });
  const client = new Client({ name: "edge", version: "1.0.0" });
  await client.connect(transport);
  const call = (name, args = {}) =>
    client.callTool({ name, arguments: args }).then((result) => {
      const text = result.content?.[0]?.text ?? "null";
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    });
  try {
    return await fn({ client, call });
  } finally {
    await client.close();
  }
}

export async function waitFor(call, taskId, predicate, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await call("get_codex_worker_status", { task_id: taskId });
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  const why = last ? { status: last.status, phase: last.phase, exit_code: last.exit_code, error: last.error, last_message: last.last_message?.slice(0, 200) } : null;
  throw new Error(`timed out waiting for ${taskId}: ${JSON.stringify(why)}`);
}

// A terminal task row can be visible before the independent run host has
// finished its final write and exited. Cleanup deliberately refuses that
// overlap, so tests that inspect cleanup wait for the owner to go away.
export async function waitForRunHostExit(home, taskId, timeoutMs = 20000) {
  const db = new DatabaseSync(join(home, "data", "supervisor.sqlite"));
  db.exec("PRAGMA busy_timeout=15000");
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      const row = db.prepare("SELECT run_host_pid AS pid FROM tasks WHERE id=?").get(taskId);
      let alive = false;
      try { process.kill(row?.pid, 0); alive = true; } catch {}
      if (!alive) return;
      if (Date.now() >= deadline) throw new Error(`timed out waiting for run host of ${taskId} to exit`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } finally {
    db.close();
  }
}

export function dispatchArgs(title, cwd, extra = {}) {
  return {
    title,
    task: `Task ${title}`,
    cwd,
    sandbox: "read-only",
    ownedPaths: [`/tmp/edge/${title.replace(/\W+/g, "-")}`],
    goal: { objective: `objective for ${title}` },
    ...extra
  };
}

// A registry that answers like registry.npmjs.org for one package. `plan`
// decides the reply: a version string, "500", "hang", "garbage", or a
// function (req, res) for anything else.
export async function fakeRegistry(plan) {
  const state = { plan, hits: 0 };
  const server = createServer((req, res) => {
    state.hits += 1;
    const current = typeof state.plan === "function" ? state.plan : null;
    if (current) return current(req, res);
    if (state.plan === "500") {
      res.writeHead(500);
      return res.end("boom");
    }
    if (state.plan === "hang") return undefined;
    if (state.plan === "garbage") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end("{not json");
    }
    const latest = state.plan;
    const body = {
      name: "codex-supervisor-mcp",
      "dist-tags": { latest },
      versions: {
        [latest]: { version: latest, dist: { integrity: `sha512-INTEGRITY-${latest}`, shasum: `SHA-${latest}` } },
        [packageVersion]: { version: packageVersion, dist: { integrity: `sha512-INTEGRITY-${packageVersion}`, shasum: `SHA-${packageVersion}` } }
      },
      time: { [latest]: "2026-10-07T00:00:00.000Z" }
    };
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    state,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

export async function startWebServer(env) {
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [join(repoRoot, "src", "web-server.js")], {
    env: { ...process.env, CODEX_BIN: fakeCodex, CODEX_SUPERVISOR_NO_UPDATE_CHECK: "1", ...env, SUPERVISOR_WEB_PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  let errors = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { errors += chunk; });
  let base;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    base = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    if (base) break;
    if (child.exitCode !== null) throw new Error(`web server exited before listening: ${errors}`);
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  if (!base) { child.kill(); throw new Error(`web server failed to announce its port: ${errors}`); }
  return {
    base,
    get: async (path, init) => {
      const response = await fetch(`${base}${path}`, init);
      const text = await response.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
      return { status: response.status, body, headers: response.headers };
    },
    close: () => {
      child.kill("SIGTERM");
    }
  };
}
