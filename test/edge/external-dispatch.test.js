import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tempHome, withMcp, dispatchArgs, waitFor, makeRepo } from "./helpers.js";

test("shared output declaration reserves paths and records preserved baseline in result and diff", async () => {
  const home=await tempHome("supervisor-external-dispatch-");const {dir}=await makeRepo(join(home,"repo"));
  const shared=join(home,"shared.md");await writeFile(shared,"user draft\n");
  const options={sandbox:"workspace-write",ownedPaths:["result.txt"],externalOutputs:[{path:shared}],acceptance:['node -e "process.exit(0)"']};
  await withMcp({SUPERVISOR_HOME:home,FAKE_CODEX_STEP_MS:"100"},async({call})=>{
    const worker=await call("create_codex_worker",dispatchArgs("shared",dir,options));
    const conflict=await call("create_codex_worker",dispatchArgs("collision",dir,{...options,ownedPaths:["other.txt"]}));
    assert.equal(conflict.error,"ownership_conflict");
    await writeFile(shared,"user draft\nnew worker content\n");
    await waitFor(call,worker.id,row=>row.exit_code===0);
    const result=await call("get_worker_result",{task_id:worker.id});
    assert.equal(result.external_outputs[0].changed,true);
    assert.equal(result.external_outputs[0].before.content,"user draft\n");
    assert.match(result.external_outputs[0].after.content,/user draft/);
    assert.match(result.external_outputs[0].integration,/not_cherry_pick/);
    const diff=await call("get_worker_diff",{task_id:worker.id});assert.equal(diff.external_outputs[0].changed,true);
  });
});
