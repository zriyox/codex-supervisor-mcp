// Worker prompt framing.
//
// Codex exposes goal tools (create_goal / get_goal / update_goal) to every
// thread, but the model does not create a goal on its own. A worker therefore
// starts with no native goal unless we ask for one, which is why the supervisor
// prepends this block instead of only recording the goal on its own side.
//
// create_goal fails when an unfinished goal already exists, so the resume path
// must not ask for one: that thread already has its goal.

function oneLine(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function buildGoalPreamble({ objective, tokenBudget = null, resume = false }) {
  const goal = oneLine(objective);
  if (!goal) return "";
  if (resume) {
    return [
      `This thread already has a goal: ${goal}`,
      "Do not call create_goal; it fails while an unfinished goal exists.",
      'Call update_goal with status "complete" when the objective is achieved and no required work remains.',
      'If the same blocker repeats for three consecutive turns and you cannot make progress, call update_goal with status "blocked" instead.'
    ].join("\n");
  }
  const budget = tokenBudget ? ` and token_budget ${tokenBudget}` : "";
  return [
    "Do this first, before any other work:",
    `Call the create_goal tool with objective exactly "${goal}"${budget}.`,
    "That goal is how your supervisor tracks this work; do not skip it.",
    'When the objective is achieved and no required work remains, call update_goal with status "complete".',
    'If the same blocker repeats for three consecutive turns and you cannot make progress, call update_goal with status "blocked" instead.'
  ].join("\n");
}

export function withGoalPreamble(prompt, goalOptions) {
  const preamble = buildGoalPreamble(goalOptions);
  return preamble ? `${preamble}\n\n${prompt}` : prompt;
}
