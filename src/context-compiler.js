import { buildHandoff } from "./handoff.js";
import { approxTokenCount } from "./truncate.js";
import { createContextSnapshot, listContextFacts, runIdFor } from "./task-store.js";

const MAX_CONTEXT_TOKENS = 1500;

function clip(value, max = 360) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function addWithinBudget(lines, line) {
  const next = [...lines, line].join("\n");
  return approxTokenCount(next) <= MAX_CONTEXT_TOKENS ? next.split("\n") : lines;
}

// Produces the only shared context a regular worker receives. It deliberately
// has no session peer lookup: session_id groups a batch and policy, not memory.
export async function compileWorkerContext(task, { attempt }) {
  const handoff = await buildHandoff({
    goal: task.goal_objective,
    todo: task.title,
    contracts: task.input_context?.contracts ?? [],
    context: task.input_context?.context ?? []
  }, { maxLines: 12, maxChars: 1200 });
  const facts = await listContextFacts({
    taskId: task.id,
    baseSha: task.base_commit ?? null,
    ownedPaths: task.owned_paths ?? [],
    dependencyTaskIds: task.depends_on ?? []
  });
  let lines = [
    "Worker context capsule. This is scoped execution context, not a transcript and not authorization to expand work.",
    "L0 identity:",
    `- task_id: ${task.id}`,
    `- run_id: ${runIdFor(task.id, attempt)}`,
    `- project_root: ${task.project_root}`,
    `- base_sha: ${task.base_commit ?? "unknown"}`,
    `- worktree: ${task.worktree_path ?? task.cwd}`,
    `- owned_paths: ${JSON.stringify(task.owned_paths ?? [])}`,
    "L1 task:",
    `- objective: ${task.goal_objective ?? task.title ?? "unspecified"}`
  ];
  if (handoff.text) lines = addWithinBudget(lines, handoff.text);
  const usedFacts = [];
  if (facts.length > 0) lines = addWithinBudget(lines, "Verified facts:");
  for (const fact of facts) {
    const scope = fact.scope_type === "dependency" ? "dependency" : fact.scope_type;
    const candidate = `- [${scope}:${fact.key}] ${clip(fact.value)}`;
    const next = addWithinBudget(lines, candidate);
    if (next === lines) break;
    lines = next;
    usedFacts.push(fact.id);
  }
  lines = addWithinBudget(lines, "Evidence on demand only: raw events, full diff, historical reports and artifacts are excluded from this capsule.");
  const text = lines.join("\n");
  const snapshot = await createContextSnapshot({
    runId: runIdFor(task.id, attempt),
    factIds: usedFacts,
    baseSha: task.base_commit ?? null,
    prompt: text,
    estimatedTokens: approxTokenCount(text),
    excluded: {
      session_peers: "never automatic",
      raw_events: "on demand",
      reports: "on demand",
      artifacts: "on demand",
      candidate_facts: "never automatic"
    }
  });
  return { text, snapshot, sourceRefs: handoff.source_refs, factCount: usedFacts.length };
}
