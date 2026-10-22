import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAcceptanceBlock, buildGoalPreamble, buildGuardPreamble } from "../../src/prompt.js";

test("a worker may not invent a goal token budget", () => {
  const withoutBudget = buildGoalPreamble({ objective: "finish the gate" });
  assert.match(withoutBudget, /Omit the token_budget field entirely/);
  assert.match(withoutBudget, /including 0, 1, or null, is denied/);
  assert.doesNotMatch(withoutBudget, /token_budget \d+/);
});

test("an explicit goal token budget is passed through exactly", () => {
  const budgeted = buildGoalPreamble({ objective: "finish the gate", tokenBudget: 24000 });
  assert.match(budgeted, /token_budget 24000/);
  assert.match(budgeted, /Include that token_budget exactly/);
});

test("the worker is told to use the supervisor acceptance CLI instead of its interactive shell", () => {
  const text = buildAcceptanceBlock(["npm test"]);
  assert.match(text, /CODEX_SUPERVISOR_ACCEPTANCE_CLI/);
  assert.match(text, /Do not retype the commands in zsh/);
  assert.match(text, /non-interactive Bash with errexit and pipefail/);
});

test("Git write workers leave commits and post-landing cleanliness to the dispatcher", () => {
  const text = buildGuardPreamble({ sandbox: "workspace-write", workspaceKind: "git_worktree", ownedPaths: ["src"] });
  assert.match(text, /Do not run git add, git commit or git commit --amend/);
  assert.match(text, /land_codex_worker.*commitMessage/);
  assert.match(text, /clean.*after landing/i);
  assert.match(text, /report.*conflict/i);
  assert.doesNotMatch(buildGuardPreamble({ sandbox: "read-only", ownedPaths: [] }), /land_codex_worker/);
});
