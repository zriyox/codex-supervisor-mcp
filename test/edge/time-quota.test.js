import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { dispatchArgs, tempHome, withMcp, waitFor } from "./helpers.js";

test("worker time quota stops the run independently of waits and never triggers an automatic retry", async () => {
  const home=await tempHome("supervisor-time-quota-");
  await withMcp({SUPERVISOR_HOME:home,FAKE_CODEX_SCENARIO:"hang"},async({call})=>{
    const worker=await call("create_codex_worker",dispatchArgs("time limited",join(home,"workspace"),{maxRunMs:1000}));
    const final=await waitFor(call,worker.id,row=>row.attention_reason==="run_time_limit");
    assert.match(final.error,/time quota/);assert.ok(["lost","failed"].includes(final.status));
    const changes=await call("check_workers",{});assert.equal(changes.recoveries.length,0);
    assert.ok(changes.attention.some(entry=>entry.reason==="run_time_limit"));
    const readonly=await call("create_codex_worker",dispatchArgs("read network",join(home,"workspace"),{sandbox:"read-only",ownedPaths:[],networkAccess:true}));
    assert.match(readonly.message,/read-only sandbox has no network/);
    const unsandboxed=await call("create_codex_worker",dispatchArgs("no sandbox network",join(home,"workspace"),{sandbox:"danger-full-access",networkAccess:true}));
    assert.match(unsandboxed.message,/only for the sandboxed workers/);
  });
});
