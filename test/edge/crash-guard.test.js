// One promise nobody awaited used to end the MCP server, and every call after
// that answered "Connection closed" with nothing to say why.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tempHome } from "./helpers.js";

const guard = pathToFileURL(join(import.meta.dirname, "../../src/infra/crash-guard.js")).href;

function runScript(home, body, options = "{}") {
  const script = `import { installCrashGuard } from ${JSON.stringify(guard)}; installCrashGuard("test", ${options}); ${body}`;
  return new Promise((resolveRun) => {
    execFile(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, SUPERVISOR_HOME: home } },
      (error, stdout) => resolveRun({ code: error?.code ?? 0, stdout }));
  });
}

const entries = async (home) => (await readFile(join(home, "data", "crash.log"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));

test("an unhandled rejection is written down and the process keeps serving", async () => {
  const home = await tempHome("supervisor-crash-");
  const run = await runScript(home, `Promise.reject(new Error("nobody awaited this")); setTimeout(() => console.log("still here"), 50);`);
  assert.equal(run.code, 0);
  assert.match(run.stdout, /still here/);
  const [entry] = await entries(home);
  assert.equal(entry.kind, "unhandled_rejection");
  assert.match(entry.error, /nobody awaited this/);
});

test("a thrown exception is written down and the process exits", async () => {
  const home = await tempHome("supervisor-crash-");
  const run = await runScript(home, `setTimeout(() => { throw new Error("broken invariant"); }, 10); setTimeout(() => console.log("should not print"), 200);`);
  assert.equal(run.code, 1);
  assert.doesNotMatch(run.stdout, /should not print/);
  const [entry] = await entries(home);
  assert.equal(entry.kind, "uncaught_exception");
  assert.equal(entry.role, "test");
});

// The run host's state is in memory. Alive after a rejection it would pin its row at running.
test("a process that asks for it exits on an unhandled rejection", async () => {
  const home = await tempHome("supervisor-crash-");
  const run = await runScript(home, `Promise.reject(new Error("lost the run")); setTimeout(() => console.log("should not print"), 300);`, "{ exitOnRejection: true }");
  assert.equal(run.code, 1);
  assert.doesNotMatch(run.stdout, /should not print/);
  assert.equal((await entries(home))[0].kind, "unhandled_rejection");
});
