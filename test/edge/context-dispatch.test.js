import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tempHome, withMcp, dispatchArgs, waitFor } from "./helpers.js";

test("uncommitted input references are pinned and resume rejects drift until a new input is supplied", async () => {
  const home = await tempHome("supervisor-context-");
  const input = join(home, "uncommitted.md");await writeFile(input,"current input");
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_SCENARIO: "echo-prompt" }, async ({ call }) => {
    const worker = await call("create_codex_worker", dispatchArgs("read input", join(home,"workspace"), { ownedPaths: [], context: [{ path: input }], contracts: ["Do not modify the input"] }));
    await waitFor(call,worker.id,row=>row.exit_code===0);
    const result = await call("get_worker_result",{task_id:worker.id,maxChars:0});
    assert.match(result.reports[0],/Handoff/);assert.ok(result.reports[0].includes(input));
    assert.match(result.input_context.source_refs[0].sha256,/^[a-f0-9]{64}$/);
    await writeFile(input,"changed input");
    const refused = await call("resume_codex_worker",{task_id:worker.id,prompt:"same input"});
    assert.match(refused.message ?? refused.reason ?? "",/context source changed/);
    const resumed = await call("resume_codex_worker",{task_id:worker.id,prompt:"new input authorized",context:[{path:input}]});
    assert.equal(resumed.run_count,2);
    await waitFor(call,worker.id,row=>row.exit_code===0&&row.run_count===2);
  });
});
