import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { repoRoot } from "./helpers.js";
import { CodexRunnerAdapter } from "../../src/runner-adapter.js";

test("CodexRunnerAdapter exposes the worker lifecycle contract", () => {
  const adapter = new CodexRunnerAdapter({ env: { ...process.env, CODEX_BIN: join(repoRoot, "src", "test-fixtures", "fake-codex.js") } });
  const capability = adapter.capabilityPreflight();
  assert.equal(capability.ok, true, capability.error);
  assert.equal(adapter.name, "codex");
  assert.deepEqual(adapter.startArgs({ cwd: "/repo/worktree", sandbox: "workspace-write", model: "test-model", reasoningEffort: "high", skipGitRepoCheck: true }), [
    "exec", "--json", "--cd", "/repo/worktree", "--sandbox", "workspace-write", "--skip-git-repo-check", "--model", "test-model", "-c", 'model_reasoning_effort="high"', "-"
  ]);
  assert.deepEqual(adapter.resumeArgs({ thread_id: "thread-1", sandbox: "read-only", model: null, reasoning_effort: "low", skip_git_repo_check: true }), [
    "exec", "resume", "--json", "-c", 'sandbox_mode="read-only"', "-c", 'model_reasoning_effort="low"', "--skip-git-repo-check", "thread-1", "-"
  ]);
  assert.deepEqual(adapter.forkSideArgs({ forkThreadId: null, workerThreadId: "thread-1", model: "test-model" }), [
    "exec", "fork", "--json", "--skip-git-repo-check", "-c", 'sandbox_mode="read-only"', "-m", "test-model", "thread-1", "-"
  ]);
  assert.deepEqual(adapter.forkSideArgs({ forkThreadId: "fork-1", workerThreadId: "thread-1", model: null }), [
    "exec", "resume", "--json", "--skip-git-repo-check", "-c", 'sandbox_mode="read-only"', "fork-1", "-"
  ]);
  const parsed = adapter.parseEvent({ status: "running", phase: "thinking", commands: [], changed_files: [] }, {
    type: "item.completed",
    item: { type: "command_execution", command: "git status --short", exit_code: 0, status: "completed" }
  });
  assert.equal(parsed.phase, "command");
  assert.equal(parsed.commands[0].command, "git status --short");
});
