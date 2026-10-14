import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tempHome, withMcp, dispatchArgs, waitFor } from "./helpers.js";
import { DatabaseSync } from "node:sqlite";

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

test("a live resume claim reserves ownership before its new running row is written", async () => {
  const home=await tempHome("supervisor-resume-owner-race-");
  await withMcp({SUPERVISOR_HOME:home},async({call})=>{
    const args=dispatchArgs("claimed",join(home,"workspace"),{sandbox:"workspace-write",ownedPaths:["same.txt"]});
    const task=await call("create_codex_worker",args);await waitFor(call,task.id,row=>row.exit_code===0);
    const db=new DatabaseSync(join(home,"data","supervisor.sqlite"));
    db.exec("PRAGMA busy_timeout=15000");
    db.prepare("INSERT INTO run_claims VALUES(?,?,?)").run(task.id,"test-claim",process.pid);
    try {assert.equal((await call("create_codex_worker",args)).error,"ownership_conflict");}
    finally {db.prepare("DELETE FROM run_claims WHERE task_id=?").run(task.id);db.close();}
  });
});
