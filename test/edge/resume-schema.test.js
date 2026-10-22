import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dispatchArgs, makeRepo, tempHome, waitFor, waitForRunHostExit, withMcp } from "./helpers.js";

for (const goalStatus of ["active", "paused", "blocked", "usage_limited", "budget_limited", "complete", "missing_database"]) test(`native goal ${goalStatus} uses a compatible resume schema`, async () => {
  const home = await tempHome("supervisor-resume-schema-");
  const { dir } = await makeRepo(join(home, "repo"));
  const codexHome = join(home, "codex");
  const argsLog = join(home, "codex-args.jsonl");
  await mkdir(codexHome);
  const threadId = "01a0fd0a-0000-7000-8000-000000000001";
  const withSchema = ["complete", "missing_database"].includes(goalStatus);
  if (goalStatus !== "missing_database") {
    const goals = new DatabaseSync(join(codexHome, "goals_1.sqlite"));
    goals.exec(`CREATE TABLE thread_goals (thread_id TEXT PRIMARY KEY,goal_id TEXT,objective TEXT,status TEXT,
      token_budget INTEGER,tokens_used INTEGER,time_used_seconds INTEGER,created_at_ms INTEGER,updated_at_ms INTEGER)`);
    goals.prepare("INSERT INTO thread_goals VALUES (?,?,?,?,?,?,?,?,?)").run(
      threadId, "goal", `${goalStatus} goal`, goalStatus, null, 12, 1, Date.now(), Date.now()
    );
    goals.close();
  }

  await withMcp({ SUPERVISOR_HOME: home, CODEX_HOME: codexHome, FAKE_CODEX_ARGS_LOG: argsLog }, async ({ call }) => {
    const worker = await call("create_codex_worker", dispatchArgs("schema resume", dir, {
      sandbox: "read-only", ownedPaths: [], acceptance: ['node -e "process.exit(0)"']
    }));
    const first = await waitFor(call, worker.id, (task) => task.status === "completed" && task.exit_code === 0);
    await waitForRunHostExit(home, worker.id);
    assert.equal(first.goal_status, goalStatus === "missing_database" ? null : goalStatus);

    const resumed = await call("resume_codex_worker", { task_id: worker.id, prompt: "continue without a schema mismatch" });
    assert.ok(!resumed.error, JSON.stringify(resumed));
    const second = await waitFor(call, worker.id, (task) => task.run_count === 2 && task.status === "completed" && task.exit_code === 0);
    await waitForRunHostExit(home, worker.id);
    assert.equal(second.thread_id, threadId);
    assert.equal(second.attention_reason, null, JSON.stringify(second));

    const db = new DatabaseSync(join(home, "data", "supervisor.sqlite"));
    const acceptedFacts = db.prepare("SELECT count(*) AS total FROM facts WHERE key='accepted_outcome' AND scope_id=?").get(`work-${worker.id}`).total;
    assert.equal(acceptedFacts, withSchema ? 2 : 1, "schema-free prose must remain candidate-only even when acceptance passes");
    db.prepare("UPDATE tasks SET status='lost', exit_code=NULL, error=?, attention_reason=NULL, run_evidence=NULL WHERE id=?")
      .run("Worker ended but its supervisor did not record the process exit", worker.id);
    db.close();
    const reconciled = (await call("list_codex_workers", { includeHistory: true })).find((task) => task.id === worker.id);
    assert.equal(reconciled.status, "completed", JSON.stringify(reconciled));
    assert.equal(reconciled.exit_code, 0);
    assert.equal(reconciled.attention_reason, null);
    const verify = new DatabaseSync(join(home, "data", "supervisor.sqlite"));
    const evidence = JSON.parse(verify.prepare("SELECT run_evidence FROM tasks WHERE id=?").get(worker.id).run_evidence);
    assert.equal(evidence.structured_report.format, withSchema ? "json_schema" : "text");
    verify.close();
  });

  const calls = (await readFile(argsLog, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
  assert.equal(calls.length, 2, JSON.stringify(calls));
  assert.equal(calls[0].args.includes("--output-schema"), true);
  assert.equal(calls[1].args.includes("resume"), true);
  assert.equal(calls[1].args.includes("--output-schema"), withSchema, JSON.stringify(calls[1]));
});
