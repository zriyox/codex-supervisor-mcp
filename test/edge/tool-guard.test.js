import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateToolUse } from "../../src/tool-guard.js";

test("patch ownership checks every file, rename destination, traversal and symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "supervisor-guard-"));
  await mkdir(join(root, "owned")); await mkdir(join(root, "outside"));
  const policy = { cwd: root, ownedPaths: [join(root, "owned")] };
  const patch = (lines) => evaluateToolUse({ tool_name: "apply_patch", cwd: root,
    tool_input: { command: `*** Begin Patch\n${lines}\n*** End Patch` } }, policy);
  assert.equal(patch("*** Add File: owned/a.txt\n+yes").allow, true);
  for (const lines of ["*** Update File: owned/a.txt\n*** Move to: outside/a.txt", "*** Add File: owned/../../escape.txt", "*** Add File: owned/a.txt\n+yes\n*** Delete File: outside/x.txt"]) assert.equal(patch(lines).allow, false);
  await symlink(join(root, "outside"), join(root, "owned", "link"), process.platform === "win32" ? "junction" : "dir");
  assert.equal(patch("*** Add File: owned/link/escape.txt").allow, false);
});

test("shell red lines override validation declarations and unknown shell writes are denied", () => {
  const policy = { cwd: tmpdir(), ownedPaths: [], forbid: ["go vet", "--drop"], allowedCommands: ["npm test", "go vet ./..."] };
  const shell = (command) => evaluateToolUse({ tool_name: "Bash", tool_input: { command } }, policy);
  for (const line of ["go vet ./...", "go \\\n vet ./...", "echo yes; go vet ./...", "db --drop", "printf yes > outside.txt", "node -e 'writeSomething()'", "rg --pre=external a", "git diff --output=outside.txt", "find . -exec rm x {} +"]) assert.equal(shell(line).allow, false, line);
  assert.equal(shell("npm test").allow, true);
  assert.equal(shell("git status --short").allow, true);
  assert.equal(shell("cat /absolute/input.md").allow, true);
  assert.equal(evaluateToolUse({}, null).allow, false);
});

// A worker is not always an editor. Reading, searching and fetching are the
// whole job for a research worker, and neither shape below can land a change.
test("a read-only worker may run any read command, keeps the red lines and cannot patch", () => {
  const policy = { cwd: tmpdir(), sandbox: "read-only", ownedPaths: [], forbid: ["rm -rf"], allowedCommands: [] };
  const shell = (command) => evaluateToolUse({ tool_name: "Bash", tool_input: { command } }, policy);
  for (const line of ["curl -s https://example.com", "gh api repos/o/r", "python3 -c 'print(1)'", "node -e 'console.log(1)'", "rg -n TODO .", "cat /absolute/input.md"]) {
    assert.equal(shell(line).allow, true, line);
  }
  assert.equal(shell("rm -rf build").allow, false, "the red lines still apply when the allowlist is lifted");
  const patch = evaluateToolUse({ tool_name: "apply_patch", cwd: policy.cwd,
    tool_input: { command: "*** Begin Patch\n*** Add File: a.txt\n+x\n*** End Patch" } }, policy);
  assert.equal(patch.allow, false);
  assert.match(patch.reason, /read-only/);
});

test("a workspace-write worker with no landable path may fetch and keep notes in its own worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "supervisor-research-"));
  const worktree = join(root, "worktree");
  const project = join(root, "project");
  await mkdir(worktree); await mkdir(project);
  const policy = { cwd: worktree, worktree, sandbox: "workspace-write", ownedPaths: [], forbid: ["--drop"] };
  const shell = (command) => evaluateToolUse({ tool_name: "Bash", tool_input: { command } }, policy);
  assert.equal(shell("curl -s https://example.com").allow, true, "fetching is the point of a research worker");
  assert.equal(shell("db --drop").allow, false, "red lines survive the looser shell");
  const patch = (path) => evaluateToolUse({ tool_name: "apply_patch", cwd: worktree,
    tool_input: { command: `*** Begin Patch\n*** Add File: ${path}\n+notes\n*** End Patch` } }, policy);
  assert.equal(patch("notes.md").allow, true, "scratch notes in its own worktree are allowed");
  assert.equal(patch("../project/notes.md").allow, false, "the user's checkout stays out of reach");
  assert.equal(patch("/etc/hosts").allow, false);
});

test("the allowlist is not lifted when the sandbox is gone", () => {
  const policy = { cwd: tmpdir(), sandbox: "danger-full-access", ownedPaths: [], allowedCommands: [] };
  const shell = (command) => evaluateToolUse({ tool_name: "Bash", tool_input: { command } }, policy);
  assert.equal(shell("curl -s https://example.com").allow, false, "without a sandbox only declared commands run");
});

test("reading a file another worker owns is never a conflict", async () => {
  const root = await mkdtemp(join(tmpdir(), "supervisor-shared-read-"));
  const shared = join(root, "shared");
  await mkdir(shared);
  const otherWorker = { cwd: root, sandbox: "workspace-write", ownedPaths: [shared], allowedCommands: ["npm test"] };
  const shell = (command) => evaluateToolUse({ tool_name: "Bash", tool_input: { command } }, otherWorker);
  assert.equal(shell(`cat ${join(shared, "types.ts")}`).allow, true);
  assert.equal(shell(`rg -n Foo ${shared}`).allow, true);
  assert.equal(shell("ls -la").allow, true);
  // Writing stays exclusive to the owner.
  const patch = evaluateToolUse({ tool_name: "apply_patch", cwd: root,
    tool_input: { command: `*** Begin Patch\n*** Update File: ${join(shared, "types.ts")}\n+x\n*** End Patch` } }, otherWorker);
  assert.equal(patch.allow, true, "the owner may edit what it owns");
  const stranger = { cwd: root, sandbox: "workspace-write", ownedPaths: [join(root, "other")], allowedCommands: [] };
  await mkdir(join(root, "other"), { recursive: true });
  assert.equal(evaluateToolUse({ tool_name: "apply_patch", cwd: root,
    tool_input: { command: `*** Begin Patch\n*** Update File: ${join(shared, "types.ts")}\n+x\n*** End Patch` } }, stranger).allow, false,
  "a second writer is still refused");
});
