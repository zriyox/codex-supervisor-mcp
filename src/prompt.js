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

// The acceptance commands are shown to the worker. Hiding them would not
// stop a worker from gaming a check (it can see the tests in the tree
// anyway) and would stop it from running them before it reports, which is
// the cheapest fix loop there is. The supervisor runs them again after the
// worker exits regardless of what the worker says.
export function buildAcceptanceBlock(acceptance, { resume = false } = {}) {
  const commands = Array.isArray(acceptance) ? acceptance.filter(Boolean) : [];
  if (commands.length === 0) return "";
  if (resume) {
    return `Acceptance is unchanged; run it before you report: ${commands.map((check) => typeof check === "string" ? check : JSON.stringify(check)).join(" ; ")}`;
  }
  return [
    "Acceptance: when you exit, the supervisor runs these commands in this directory and each must exit 0:",
    ...commands.map((command) => `- ${typeof command === "string" ? command : JSON.stringify(command)}`),
    "Run them yourself before you report and put their exit codes under Verification. Do not edit what they test to make them pass; if a check is wrong, say why under Not done / risks."
  ].join("\n");
}

export function buildReportPreamble({ resume = false, acceptance = null } = {}) {
  const acceptanceBlock = buildAcceptanceBlock(acceptance, { resume });
  const withAcceptance = (text) => (acceptanceBlock ? `${text}\n\n${acceptanceBlock}` : text);
  if (resume) {
    return withAcceptance("Report as before using the required JSON schema: result string, verification string[] (every command you ran to check, with exit codes), not_done string[] (remaining work and risks). Under 2000 characters, no list of changed files, quote raw errors verbatim.");
  }
  return withAcceptance([
    "Final report (your last message), under 2000 characters, in the language of the task. Quoted command output does not count toward the limit.",
    "Return JSON with exactly result:string, verification:string[], not_done:string[]; --output-schema enforces these fields. Cover the following content in those fields.",
    "Write that JSON value on its own: no markdown code fences and nothing before or after it.",
    "Keep each verification entry concise: command name, exit code and key evidence; avoid embedding long quoted shell source. Ensure arrays and the object are fully closed and all strings use valid JSON escaping.",
    "1. Result: what is done, in two or three sentences. Say plainly what is not done.",
    "2. Verification: every command you ran to check the work, its exit code, and the output lines that prove the result. Write \"not verified\" if you ran none.",
    "3. Not done / risks: what you skipped, what you are unsure of, what the reviewer should look at first.",
    "Do not list the files you changed; the supervisor reads the diff.",
    "Never call a failure an environment problem without quoting the raw error verbatim.",
    "If the task specifies content or language, preserve it inside these JSON fields."
  ].join("\n"));
}

export function withGoalPreamble(prompt, goalOptions) {
  const preamble = buildGoalPreamble(goalOptions);
  return preamble ? `${preamble}\n\n${prompt}` : prompt;
}

// The whole frame: goal in front, task text, report format at the end.
export function frameWorkerPrompt(prompt, goalOptions, { acceptance = null } = {}) {
  return `${withGoalPreamble(prompt, goalOptions)}\n\n${buildReportPreamble({ resume: Boolean(goalOptions?.resume), acceptance })}`;
}

// Claude's native /goal owns its Stop condition. MCP cannot silently replace
// it, so return a concrete current-policy condition for the host's goal UI.
// The condition references the current revision instead of copying long or
// soon-stale commands into the host's independently stored Stop hook.
export function buildHostGoalSync(session) {
  const id = JSON.stringify(String(session.id));
  const condition = [
    `For supervisor session ${id}, read get_session_works and use its current objective, default_acceptance, approval_state and policy_revision (at least ${session.policy_revision ?? 0}).`,
    "Use the latest explicit human instruction and approved failure baseline; superseded goals and checks must not be revived.",
    "Stop when the current approved objective is verified and all required worker results are collected, checked and integrated as requested.",
    "If approval_state is waiting_user, stop after clearly reporting the blocker, attempted checks, options and recommendation and asking for the required decision; do not auto-resume or repeat unchanged waiting reports.",
    "Report the policy revision and actual evidence. A worker exit, acceptance green, push or publish alone is not proof that the whole objective is done."
  ].join(" ");
  return { revision: session.policy_revision ?? 0, approval_state: session.approval_state ?? "approved", condition,
    claude_command: `/goal ${condition}`, requires_host_action: true,
    instruction: "If a native Claude goal is active, replace its condition through /goal with this current-policy condition; ProposeGoal may propose it for host approval where available. MCP has not modified or disabled the host Stop hook." };
}
