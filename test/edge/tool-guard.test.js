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
