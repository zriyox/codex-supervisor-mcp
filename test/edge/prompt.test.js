import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGoalPreamble } from "../../src/prompt.js";

test("a worker may not invent a goal token budget", () => {
  const withoutBudget = buildGoalPreamble({ objective: "finish the gate" });
  assert.match(withoutBudget, /Do not set a token_budget/);
  assert.doesNotMatch(withoutBudget, /token_budget \d+/);
});

test("an explicit goal token budget is passed through exactly", () => {
  const budgeted = buildGoalPreamble({ objective: "finish the gate", tokenBudget: 24000 });
  assert.match(budgeted, /token_budget 24000/);
  assert.match(budgeted, /Use only the token budget given above/);
});
