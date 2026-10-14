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

test("a dead dispatcher claim does not release a still-running acceptance owner's paths", async () => {
  const home=await tempHome("supervisor-acceptance-owner-race-");
  await withMcp({SUPERVISOR_HOME:home},async({call})=>{
    const args=dispatchArgs("settling",join(home,"workspace"),{sandbox:"workspace-write",ownedPaths:["same.txt"]});
    const task=await call("create_codex_worker",args);await waitFor(call,task.id,row=>row.exit_code===0);
    const db=new DatabaseSync(join(home,"data","supervisor.sqlite"));db.exec("PRAGMA busy_timeout=15000");
    db.prepare("INSERT INTO run_claims VALUES(?,?,?)").run(task.id,"dead-claim",999999);
    db.prepare("UPDATE tasks SET acceptance_results=?,exit_code=NULL WHERE id=?").run(JSON.stringify({status:"running",supervisor_pid:process.pid}),task.id);
    try {assert.equal((await call("create_codex_worker",args)).error,"ownership_conflict");}
    finally{db.prepare("UPDATE tasks SET acceptance_results=NULL,exit_code=0 WHERE id=?").run(task.id);db.prepare("DELETE FROM run_claims WHERE task_id=?").run(task.id);db.close();}
  });
});
