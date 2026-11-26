// A dispatcher that died while creating a worktree left its lock behind, and
// nothing ever removed it: every later dispatch into that repository waited
// two minutes and failed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tempHome } from "./helpers.js";

test("a lock left by a dead process is taken over, a live holder's is waited for", async () => {
  const home = await tempHome("supervisor-lock-");
  process.env.SUPERVISOR_HOME = home;
  const { withWorktreeCreationLock } = await import("../../src/app/worktree-setup.js");
  const repo = join(home, "repo");
  const lock = join(home, "worktrees", `create-${createHash("sha256").update(resolve(repo)).digest("hex").slice(0, 24)}.lock`);
  await mkdir(lock, { recursive: true });
  // No process has this pid: the largest pid any supported system hands out is far below it.
  await writeFile(join(lock, "owner"), "2147483646");

  const started = Date.now();
  assert.equal(await withWorktreeCreationLock(repo, async () => "ran"), "ran");
  assert.ok(Date.now() - started < 5000, "the dead holder's lock was not waited out");

  // Which waiter gets a free lock first is not defined; that only one holds it is.
  let holders = 0;
  let most = 0;
  const hold = () => withWorktreeCreationLock(repo, async () => {
    holders += 1;
    most = Math.max(most, holders);
    await new Promise((done) => setTimeout(done, 150));
    holders -= 1;
  });
  await Promise.all([hold(), hold(), hold()]);
  assert.equal(most, 1);
});
  const second = withWorktreeCreationLock(repo, async () => order.push("second in"));
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first in", "first out", "second in"]);
});
