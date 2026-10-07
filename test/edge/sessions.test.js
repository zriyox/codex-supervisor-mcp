// What a session is about: titles and notes set at dispatch or afterwards,
// kept across later dispatches, visible through get_session_works.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { dispatchArgs, tempHome, withMcp } from "./helpers.js";

test("session_title and session_note at dispatch are recorded and later dispatches keep them", async () => {
  const home = await tempHome("supervisor-sessions-");
  const ws = join(home, "workspace");
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const first = await call("create_codex_worker", dispatchArgs("s1-a", ws, { session_id: "batch-1", session_title: "给 12 个接口补单测", session_note: "四路并行，每路三个接口" }));
    assert.ok(first.id, JSON.stringify(first));
    const second = await call("create_codex_worker", dispatchArgs("s1-b", ws, { session_id: "batch-1" }));
    assert.ok(second.id);
    const works = await call("get_session_works", { session_id: "batch-1" });
    assert.equal(works.title, "给 12 个接口补单测");
    assert.equal(works.note, "四路并行，每路三个接口");
    assert.equal(works.count, 2);
  });
});

test("describe_session updates only the fields given and creates the row if missing", async () => {
  const home = await tempHome("supervisor-sessions-");
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const created = await call("describe_session", { session_id: "later", title: "先起个名" });
    assert.equal(created.title, "先起个名");
    assert.equal(created.note, null);
    const noted = await call("describe_session", { session_id: "later", note: "补一句说明" });
    assert.equal(noted.title, "先起个名", "a note-only update keeps the title");
    assert.equal(noted.note, "补一句说明");
    const renamed = await call("describe_session", { session_id: "later", title: "改名" });
    assert.equal(renamed.title, "改名");
    assert.equal(renamed.note, "补一句说明", "a title-only update keeps the note");
    const works = await call("get_session_works", { session_id: "later" });
    assert.equal(works.title, "改名");
    assert.equal(works.count, 0, "a described session can exist before any worker");
  });
});

test("a title without a session_id is ignored instead of inventing a session", async () => {
  const home = await tempHome("supervisor-sessions-");
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const created = await call("create_codex_worker", dispatchArgs("loose", join(home, "workspace"), { session_title: "孤儿标题" }));
    assert.ok(created.id);
    assert.equal(created.session_id, null);
    const search = await call("search_works", { query: "loose" });
    assert.equal(search.works[0].session_id, null);
  });
});

test("unicode, emoji, a 120-character title and a 2000-character note survive; longer is refused", async () => {
  const home = await tempHome("supervisor-sessions-");
  const title = "🚀 单测 — " + "字".repeat(112);
  const note = "n".repeat(2000);
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    assert.equal(title.length, 120);
    const ok = await call("describe_session", { session_id: "limits", title, note });
    assert.equal(ok.title, title);
    assert.equal(ok.note.length, 2000);
    const tooLong = await call("describe_session", { session_id: "limits", title: "x".repeat(121) });
    assert.ok(typeof tooLong === "string" || tooLong.error, "a 121-character title must be rejected by the schema");
    const still = await call("get_session_works", { session_id: "limits" });
    assert.equal(still.title, title, "a rejected update leaves the row untouched");
  });
});

test("a follow-up inherits the parent's session and may set its title", async () => {
  const home = await tempHome("supervisor-sessions-");
  const ws = join(home, "workspace");
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    const parent = await call("create_codex_worker", dispatchArgs("parent", ws, { session_id: "chain" }));
    await call("wait_codex_workers", { task_ids: [parent.id], timeoutMs: 10000 });
    const child = await call("create_codex_followup_worker", { task_id: parent.id, followup_prompt: "go on", session_title: "接力批次" });
    assert.equal(child.session_id, "chain");
    const works = await call("get_session_works", { session_id: "chain" });
    assert.equal(works.title, "接力批次");
    assert.equal(works.count, 2);
  });
});
