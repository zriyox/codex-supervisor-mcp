// Shared scaffolding for the edge tests: a temp supervisor home, an MCP
// client over stdio against the real server, a fake npm registry, a git
// repository with history, and a tiny HTTP client for the web view.
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const fakeCodex = join(repoRoot, "src", "test-fixtures", "fake-codex.js");
export const packageVersion = JSON.parse(
  await import("node:fs/promises").then((fs) => fs.readFile(join(repoRoot, "package.json"), "utf8"))
).version;

export async function tempHome(prefix = "supervisor-edge-") {
  const home = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(home, "workspace"), { recursive: true });
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
  const port = 17000 + Math.floor(Math.random() * 2000);
  const child = spawn(process.execPath, [join(repoRoot, "src", "web-server.js")], {
    env: { ...process.env, CODEX_SUPERVISOR_NO_UPDATE_CHECK: "1", ...env, SUPERVISOR_WEB_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/overview`);
      if (response.ok) break;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
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
