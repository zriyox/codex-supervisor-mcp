import { test } from "node:test";
import assert from "node:assert/strict";
import { findOutsideOwnedChanges } from "../../src/owned-changes.js";

test("project ownership maps into the isolated worker checkout", () => {
  const task = { project_root: "/repo", worktree_path: "/workers/a", owned_paths: ["/repo/src", "/repo/one.js"] };
  const result = findOutsideOwnedChanges(task, ["/workers/a/src/a.js", "/workers/a/one.js", "/workers/a/src-other/a.js"]);
  assert.deepEqual(result.outside, ["/workers/a/src-other/a.js"]);
  assert.equal(result.owned.length, 2);
});

test("path traversal and absolute paths outside the worktree are rejected", () => {
  const task = { project_root: "/repo", worktree_path: "/workers/a", owned_paths: ["/repo/src"] };
  const result = findOutsideOwnedChanges(task, ["../secret", "/workers/a/src/../../secret", "/elsewhere/src/a.js"]);
  assert.equal(result.outside.length, 3);
});

test("Windows ownership handles separators and case without prefix confusion", () => {
  const task = { project_root: "C:\\Repo", worktree_path: "D:\\Workers\\A", owned_paths: ["c:\\repo\\src"] };
  const result = findOutsideOwnedChanges(task, ["d:\\workers\\a\\SRC\\one.js", "D:\\Workers\\A\\src2\\bad.js"], { platform: "win32" });
  assert.equal(result.owned.length, 1);
  assert.equal(result.outside.length, 1);
});

test("an empty read-only ownership list does not grant writes", () => {
  assert.deepEqual(findOutsideOwnedChanges({ project_root: "/repo", worktree_path: "/workers/a", owned_paths: [] }, ["a.js"]).outside, ["a.js"]);
});
