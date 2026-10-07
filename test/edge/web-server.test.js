// The read-only web API over a store with several sessions, a ghost row,
// explicit and derived titles, odd ids, and hostile paths.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dispatchArgs, makeRepo, startWebServer, tempHome, waitFor, withMcp } from "./helpers.js";

const home = await tempHome("supervisor-web-");
const { dir: repo } = await makeRepo(join(home, "repo"));
let web;
let ids = {};

before(async () => {
  // Build the store through the real MCP server with the fake codex.
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "commit-in-worktree" }, async ({ call }) => {
    const a = await call("create_codex_worker", dispatchArgs("titled-1", repo, { session_id: "s/with slash", session_title: "有标题的批次", session_note: "一句说明" }));
    const b = await call("create_codex_worker", dispatchArgs("titled-2", repo, { session_id: "s/with slash" }));
    const c = await call("create_codex_worker", dispatchArgs("derived-1", join(home, "workspace"), { session_id: "no-title", goal: { objective: "第一路的目标" } }));
    const d = await call("create_codex_worker", dispatchArgs("loose", join(home, "workspace")));
    for (const w of [a, b, c, d]) await waitFor(call, w.id, (t) => t.status === "completed");
    ids = { a: a.id, b: b.id, c: c.id, d: d.id };
  });
  // A ghost row written by a dispatch that died: no pid, blank created_at.
  const db = new DatabaseSync(join(home, "data", "supervisor.sqlite"));
  db.prepare(`INSERT INTO tasks (id, title, worker, status, cwd, project_root, sandbox, prompt, created_at, updated_at, run_log, pid, session_id)
              VALUES ('ghost-1', 'ghost', 'codex', 'running', ?, ?, 'workspace-write', 'x', '', '', '/tmp/none', 0, 'no-title')`).run(home, home);
  db.close();
  web = await startWebServer({ SUPERVISOR_HOME: home });
});
after(() => web?.close());

test("overview groups by session, uses the recorded title or derives one, and settles the ghost", async () => {
  const { status, body } = await web.get("/api/overview");
  assert.equal(status, 200);
  assert.equal(body.total_workers, 5);
  const byId = Object.fromEntries(body.sessions.map((s) => [s.id, s]));
  assert.equal(byId["s/with slash"].title, "有标题的批次");
  assert.equal(byId["s/with slash"].title_derived, false);
  assert.equal(byId["s/with slash"].note, "一句说明");
  assert.equal(byId["s/with slash"].worker_count, 2);
  assert.equal(byId["no-title"].title, "第一路的目标", "derived from the goals when nobody set a title");
  assert.equal(byId["no-title"].title_derived, true);
  assert.equal(byId["no-title"].counts.lost, 1, "the ghost row is reconciled on read");
  assert.equal(byId.none.unsessioned, true);
  assert.equal(byId.none.worker_count, 1);
  assert.equal(body.active_workers, 0);
});

test("a session id with a slash round-trips through the URL", async () => {
  const { status, body } = await web.get(`/api/sessions/${encodeURIComponent("s/with slash")}`);
  assert.equal(status, 200);
  assert.equal(body.workers.length, 2);
  const row = body.workers.find((w) => w.id === ids.a);
  assert.equal(row.changed_file_count, 2, "the list count is the live git diff, not the stored event count");
  assert.equal(row.branch, `codex/${ids.a}`);
  assert.ok(row.duration_ms >= 0);
  assert.equal(row.prompt, undefined, "the list never carries the prompt");
});

test("worker detail carries the live diff, reports, commands, token usage and event kinds", async () => {
  const { body } = await web.get(`/api/workers/${ids.a}`);
  assert.equal(body.id, ids.a);
  assert.deepEqual(body.changed_files.map((f) => basename(f)).sort(), ["committed.txt", "uncommitted.txt"]);
  assert.equal(body.reports.length, 1);
  assert.match(body.reports[0], /committed one file/);
  assert.equal(body.commands.length, 1);
  assert.equal(body.usage.turns, 1);
  assert.ok(body.event_kinds.some((k) => k.kind === "turn.completed"));
  assert.equal(typeof body.prompt, "string");
});

test("events honour limit and kinds", async () => {
  const all = await web.get(`/api/workers/${ids.a}/events?limit=1000`);
  assert.ok(all.body.events.length >= 4);
  const one = await web.get(`/api/workers/${ids.a}/events?limit=1`);
  assert.equal(one.body.events.length, 1);
  const only = await web.get(`/api/workers/${ids.a}/events?kinds=turn.completed`);
  assert.ok(only.body.events.every((e) => e.type === "turn.completed"));
  const capped = await web.get(`/api/workers/${ids.a}/events?limit=99999`);
  assert.ok(capped.body.events.length <= 1000);
});

test("unknown ids, unknown routes, wrong methods and path traversal are all refused", async () => {
  assert.equal((await web.get("/api/workers/nope")).status, 404);
  assert.equal((await web.get("/api/workers/nope/events")).status, 404);
  assert.equal((await web.get("/api/sessions/nope")).status, 404);
  assert.equal((await web.get("/api/nothing")).status, 404);
  assert.equal((await web.get("/api/overview", { method: "POST" })).status, 405);
  const traversal = await web.get("/..%2F..%2Fpackage.json");
  assert.ok(traversal.status === 200 || traversal.status === 503 || traversal.status === 403);
  assert.ok(typeof traversal.body !== "object" || !traversal.body.name, "must not serve files outside web/dist");
});

test("the version endpoint answers even with the update check disabled", async () => {
  const { status, body } = await web.get("/api/version");
  assert.equal(status, 200);
  assert.equal(body.source, "disabled");
  assert.equal(typeof body.installed.version, "string");
});

// ---- the entry: which store, and what a taken port says

import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { repoRoot } from "./helpers.js";

async function runEntry({ cwd, env, port }) {
  const child = spawn(process.execPath, [join(repoRoot, "src", "web-server.js")], {
    cwd,
    env: { ...process.env, SUPERVISOR_HOME: "", CODEX_SUPERVISOR_NO_UPDATE_CHECK: "1", ...env, SUPERVISOR_WEB_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (err += c));
  const started = Date.now();
  while (Date.now() - started < 6000 && !out.includes("web view on") && child.exitCode === null) {
    await new Promise((r) => setTimeout(r, 60));
  }
  return { child, out: () => out, err: () => err, stop: () => child.kill("SIGTERM") };
}

test("without SUPERVISOR_HOME the entry reads the nearest .mcp.json above cwd", async () => {
  const projectHome = await tempHome("supervisor-mcpjson-store-");
  const project = join(await tempHome("supervisor-mcpjson-"), "proj");
  await mkdir(join(project, "deep", "er"), { recursive: true });
  await writeFile(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { "codex-supervisor": { command: "node", env: { SUPERVISOR_HOME: projectHome } } } }));
  const port = 17000 + Math.floor(Math.random() * 2000);
  const run = await runEntry({ cwd: join(project, "deep", "er"), env: {}, port });
  try {
    assert.match(run.out(), /web view on/);
    assert.ok(run.out().includes(projectHome), `must open the store named in .mcp.json, got: ${run.out()}`);
    assert.match(run.out(), /from .*\.mcp\.json/);
    const overview = await (await fetch(`http://127.0.0.1:${port}/api/overview`)).json();
    assert.equal(overview.store, projectHome);
  } finally {
    run.stop();
  }
});

test("SUPERVISOR_HOME in the environment wins over .mcp.json", async () => {
  const envHome = await tempHome("supervisor-envhome-");
  const project = join(await tempHome("supervisor-mcpjson-"), "proj");
  await mkdir(project, { recursive: true });
  await writeFile(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { "codex-supervisor": { env: { SUPERVISOR_HOME: "/nowhere/else" } } } }));
  const port = 17000 + Math.floor(Math.random() * 2000);
  const run = await runEntry({ cwd: project, env: { SUPERVISOR_HOME: envHome }, port });
  try {
    assert.ok(run.out().includes(envHome), run.out());
    assert.match(run.out(), /\(SUPERVISOR_HOME\)/);
  } finally {
    run.stop();
  }
});

test("a taken port is reported in one sentence with the way out, exit code 1", async () => {
  const port = 17000 + Math.floor(Math.random() * 2000);
  const first = await runEntry({ cwd: home, env: { SUPERVISOR_HOME: home }, port });
  try {
    assert.match(first.out(), /web view on/);
    const second = await runEntry({ cwd: home, env: { SUPERVISOR_HOME: home }, port });
    const deadline = Date.now() + 6000;
    while (second.child.exitCode === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.equal(second.child.exitCode, 1);
    assert.match(second.err(), new RegExp(`port ${port} on 127\\.0\\.0\\.1 is already in use`));
    assert.match(second.err(), /SUPERVISOR_WEB_PORT=8080/);
    assert.doesNotMatch(second.err(), /at Server\.setupListenHandle/, "no stack trace for a taken port");
  } finally {
    first.stop();
  }
});

// ---- pagination

test("the overview and a session page with limit/offset and say whether there is more", async () => {
  const first = await web.get("/api/overview?limit=1&offset=0");
  assert.equal(first.body.sessions.length, 1);
  assert.equal(first.body.total_sessions, 3);
  assert.equal(first.body.has_more, true);
  const second = await web.get("/api/overview?limit=1&offset=1");
  assert.equal(second.body.sessions.length, 1);
  assert.notEqual(second.body.sessions[0].id, first.body.sessions[0].id, "offset moves to the next session");
  const last = await web.get("/api/overview?limit=2&offset=2");
  assert.equal(last.body.sessions.length, 1);
  assert.equal(last.body.has_more, false);
  const beyond = await web.get("/api/overview?limit=5&offset=50");
  assert.equal(beyond.body.sessions.length, 0);
  assert.equal(beyond.body.has_more, false);
  assert.equal(beyond.body.total_workers, 5, "totals describe the whole store, not the page");

  const page = await web.get(`/api/sessions/${encodeURIComponent("s/with slash")}?limit=1&offset=0`);
  assert.equal(page.body.workers.length, 1);
  assert.equal(page.body.worker_count, 2, "the session summary counts every worker");
  assert.equal(page.body.has_more, true);
  assert.equal(page.body.workers[0].id, ids.a, "workers come in dispatch order");
  const next = await web.get(`/api/sessions/${encodeURIComponent("s/with slash")}?limit=1&offset=1`);
  assert.equal(next.body.workers[0].id, ids.b);
  assert.equal(next.body.has_more, false);

  const clamped = await web.get("/api/overview?limit=99999&offset=-5");
  assert.equal(clamped.body.limit, 200);
  assert.equal(clamped.body.offset, 0);
  const garbage = await web.get("/api/overview?limit=abc&offset=xyz");
  assert.equal(garbage.body.limit, 20);
  assert.equal(garbage.body.offset, 0);
});
