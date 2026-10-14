import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tempHome, withMcp, dispatchArgs } from "./helpers.js";

test("two MCP dispatchers cannot reserve the same output concurrently", async () => {
  const home=await tempHome("supervisor-owner-race-");
  const env={SUPERVISOR_HOME:home,FAKE_CODEX_SCENARIO:"hang"};
  await withMcp(env,async({call:first})=>withMcp(env,async({call:second})=>{
    const args=dispatchArgs("same file",join(home,"workspace"),{sandbox:"workspace-write",ownedPaths:["same.txt"]});
    const replies=await Promise.all([first("create_codex_worker",args),second("create_codex_worker",args)]);
    try{
      assert.equal(replies.filter(row=>row.id).length,1);
      assert.equal(replies.filter(row=>row.error==="ownership_conflict").length,1);
    }finally{for(const row of replies)if(row.id)await first("cancel_codex_worker",{task_id:row.id});}
  }));
});
