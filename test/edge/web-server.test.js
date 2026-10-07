// The read-only web API over a store with several sessions, a ghost row,
// explicit and derived titles, odd ids, and hostile paths.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
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
  assert.deepEqual(body.changed_files.map((f) => f.split("/").pop()).sort(), ["committed.txt", "uncommitted.txt"]);
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
