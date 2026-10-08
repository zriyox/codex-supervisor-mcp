// Worker prompt framing: what goes around the task text.
//
// Goal preamble, in front. Codex exposes goal tools (create_goal / get_goal /
// update_goal) to every thread, but the model does not create a goal on its
// own. A worker therefore starts with no native goal unless we ask for one,
// which is why the supervisor prepends this block instead of only recording
// the goal on its own side. create_goal fails when an unfinished goal already
// exists, so the resume path must not ask for one: that thread already has
// its goal.
//
// Report format, at the end. A worker's last message is what the supervisor
// reads back through get_worker_result. Left to itself a worker narrates
// the whole run and lists every file it touched, and one real report ran to
// four thousand tokens with the conclusion buried in the middle. The format
// asks for the three things a reviewer checks and nothing else: the result,
// the commands that prove it, and what was left out. Files are not listed
// because the supervisor reads the diff. It goes after the task text because
// a format instruction at the end of a long prompt is the one that is
// followed, and because "the task's own format wins" has to come after the
// task.

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

export const REPORT_SECTIONS = ["Result", "Verification", "Not done / risks"];

export function buildReportPreamble({ resume = false } = {}) {
  if (resume) {
    return "Report as before: Result / Verification (every command you ran to check, with exit codes) / Not done and risks. Under 2000 characters, no list of changed files, quote raw errors verbatim.";
  }
  return [
    "Final report (your last message), under 2000 characters, in the language of the task. Quoted command output does not count toward the limit.",
    "1. Result: what is done, in two or three sentences. Say plainly what is not done.",
    "2. Verification: every command you ran to check the work, its exit code, and the output lines that prove the result. Write \"not verified\" if you ran none.",
    "3. Not done / risks: what you skipped, what you are unsure of, what the reviewer should look at first.",
    "Do not list the files you changed; the supervisor reads the diff.",
    "Never call a failure an environment problem without quoting the raw error verbatim.",
    "If the task above specifies its own report format, use that format and still cover the three points."
  ].join("\n");
}

export function withGoalPreamble(prompt, goalOptions) {
  const preamble = buildGoalPreamble(goalOptions);
  return preamble ? `${preamble}\n\n${prompt}` : prompt;
}

// The whole frame: goal in front, task text, report format at the end.
export function frameWorkerPrompt(prompt, goalOptions) {
  return `${withGoalPreamble(prompt, goalOptions)}\n\n${buildReportPreamble({ resume: Boolean(goalOptions?.resume) })}`;
}
