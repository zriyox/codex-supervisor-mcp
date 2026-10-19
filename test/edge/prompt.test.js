import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGoalPreamble } from "../../src/prompt.js";

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
