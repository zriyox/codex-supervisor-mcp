import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildHandoff } from "../../src/handoff.js";
import { tempHome } from "./helpers.js";

test("handoff is bounded while uncommitted inputs have absolute refs and hashes", async () => {
  const home = await tempHome("supervisor-handoff-");
  const path = join(home, "uncommitted.md");await writeFile(path,"actual input");
  const result = await buildHandoff({ goal: "work", todo: "step", context: [{ path }], peers: Array(30).fill({ title: "peer", status: "completed", last_message: "x".repeat(500) }) });
  assert.ok(result.text.length <= 1800);assert.ok(result.text.split("\n").length <= 16);
  assert.equal(result.truncated,true);assert.match(result.text,/truncated/);
  assert.equal(result.source_refs[0].path,path);assert.match(result.source_refs[0].sha256,/^[a-f0-9]{64}$/);
  await assert.rejects(buildHandoff({context:[{path,sha256:"old"}]}),/source changed/);
  await assert.rejects(buildHandoff({context:[{path:"relative.md"}]}),/absolute/);
});
