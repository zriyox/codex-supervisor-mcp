import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { dispatchArgs, makeRepo, tempHome, waitFor, withMcp } from "./helpers.js";

// A run can be correct and still end with a last message that is not the
// required JSON. That used to strand the worker: land refuses invalid_report
// and only a human could retry it. check_workers now re-asks once.
test("an invalid final report is retried once with a re-emit prompt", async () => {
  const home = await tempHome("supervisor-invalid-report-");
  const { dir: repo } = await makeRepo(join(home, "repo"));
  await withMcp({ SUPERVISOR_HOME: home, FAKE_CODEX_BAD_REPORT_ON_RUN: "1" }, async ({ call }) => {
    const worker = await call("create_codex_worker", { ...dispatchArgs("bad report", repo), sandbox: "workspace-write", ownedPaths: ["result.txt"] });
    assert.ok(worker.id, JSON.stringify(worker).slice(0, 300));
    const broken = await waitFor(call, worker.id, (task) => task.attention_reason === "invalid_report");
    assert.equal(broken.status, "failed", "the row says failed while the report is unusable");
    assert.match(broken.error ?? "", /Invalid final worker report/);
    const checked = await call("check_workers", {});
    assert.equal(checked.recoveries.length, 1, JSON.stringify(checked).slice(0, 400));
    assert.equal(checked.recoveries[0].reason, "invalid_report");
    assert.equal(checked.recoveries[0].run, 2);
    const fixed = await waitFor(call, worker.id, (task) => task.status === "completed" && task.exit_code !== null);
    assert.equal(fixed.attention_reason ?? null, null, "the retry produced a usable report");
    const again = await call("check_workers", {});
    assert.equal(again.recoveries.length, 0, "a second run is not retried a second time");
  });
});

