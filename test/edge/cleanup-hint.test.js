import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { cleanupHint, cleanupThreshold } from "../../src/cleanup-hint.js";
import { tempHome, withMcp } from "./helpers.js";

test("the hint appears only once the store holds enough worktrees", async () => {
  const list = () => Promise.resolve(["a", "b", "c"]);
  assert.equal(await cleanupHint({ list, root: "/store", threshold: 5 }), null);
  const hint = await cleanupHint({ list, root: "/store", threshold: 3 });
  assert.equal(hint.worktrees, 3);
  assert.equal(hint.threshold, 3);
  assert.match(hint.command, /SUPERVISOR_HOME=\/store npm run cleanup -- --dry-run/);
  assert.match(hint.apply, /npm run cleanup -- --apply/);
  assert.match(hint.note, /push-verified/);
  assert.equal(await cleanupHint({ list: () => Promise.reject(new Error("gone")), threshold: 1 }), null, "a missing directory is not an error");
  assert.equal(cleanupThreshold("0"), 0, "0 disables the hint");
  assert.equal(cleanupThreshold("nonsense"), 50, "a bad value falls back to the default");
  assert.equal(cleanupThreshold("7"), 7);
});

// The whole point of the hint is that a batch cannot silently grow to hundreds
// of worktrees: every collection round carries the number and the command.
test("check_workers reports the cleanup backlog and its command", async () => {
  const home = await tempHome("supervisor-cleanup-hint-");
  await mkdir(join(home, "worktrees", "one"), { recursive: true });
  await mkdir(join(home, "worktrees", "two"), { recursive: true });
  await withMcp({ SUPERVISOR_HOME: home, SUPERVISOR_CLEANUP_HINT: "2" }, async ({ call }) => {
    const reply = await call("check_workers", {});
    assert.ok(reply.cleanup, JSON.stringify(reply).slice(0, 300));
    assert.equal(reply.cleanup.worktrees, 2);
    assert.match(reply.cleanup.command, /npm run cleanup -- --dry-run/);
  });
  await withMcp({ SUPERVISOR_HOME: home, SUPERVISOR_CLEANUP_HINT: "0" }, async ({ call }) => {
    assert.equal((await call("check_workers", {})).cleanup, undefined, "the switch turns the hint off");
  });
});

