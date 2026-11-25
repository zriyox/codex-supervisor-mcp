// The pid on a worker's row is often a launcher; the binary it started can
// outlive it and still hold the session. Recovery asks about the whole group.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { isGroupAlive } from "../../src/infra/store/tasks.js";

test("a process group counts as alive until its last member is gone", { skip: process.platform === "win32" }, async () => {
  // The leader starts a child that outlives it, as a launcher script does.
  const leader = spawn(process.execPath, ["-e", `
    const { spawn } = require("node:child_process");
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    console.log(child.pid);
    setTimeout(() => {}, 60000);
  `], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  const [line] = await once(leader.stdout, "data");
  const survivor = Number(String(line).trim());
  process.kill(leader.pid, "SIGKILL");
  await once(leader, "exit");

  assert.equal(isGroupAlive(leader.pid), true, "the leader is gone but its child is not");
  process.kill(survivor, "SIGKILL");
  for (let waited = 0; waited < 3000 && isGroupAlive(leader.pid); waited += 50) await new Promise((done) => setTimeout(done, 50));
  assert.equal(isGroupAlive(leader.pid), false);
  assert.equal(isGroupAlive(null), false);
});
