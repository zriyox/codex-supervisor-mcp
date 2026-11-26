import { z } from "zod";
import { cancelCodexWorkerOp } from "../handlers/delivery.js";
import { checkAcceptanceOp, createCodexFollowupWorkerOp, createCodexWorkerOp, preflightCodexWorkerOp, resumeCodexWorkerOp } from "../handlers/dispatch.js";
import { defineTool, run } from "./run.js";
import { acceptanceCommands, acceptanceShape, contextShape, dispatchOptions, group, limitsShape, only, sandboxShape, workspaceShape } from "./shapes.js";

const effort = z.enum(["minimal", "low", "medium", "high"]).optional();

export const preflightWorkerTool = defineTool("preflight_worker", {
  title: "Check a worker's environment before dispatch",
  description: "Prove the environment before spending a worker. probe_commands starts a short probe worker under the same workspace, sandbox and guard and returns its id: read it with get_worker include preflight, then pass it as preflight_id to create_worker with the same arguments. acceptance alone runs those commands in cwd now and returns their results.",
  inputSchema: {
    cwd: z.string(),
    probe_commands: z.array(z.string()).min(1).max(20).optional().describe("Commands the probe must run"),
    acceptance: acceptanceShape,
    owned_paths: z.array(z.string()).optional().describe("Required with probe_commands"),
    title: z.string().optional(),
    runner: z.string().optional(),
    model: z.string().optional(),
    reasoning_effort: effort,
    workspace: workspaceShape,
    sandbox: sandboxShape,
    context: contextShape,
    limits: limitsShape
  }
}, async (args) => {
  const check = args.acceptance
    ? await run(checkAcceptanceOp, {
        cwd: args.cwd, acceptance: acceptanceCommands(args.acceptance.commands), baseRef: args.workspace?.base_ref, timeoutMs: args.acceptance.timeout_ms
      })
    : null;
  if (!args.probe_commands) return check ?? { error: "invalid_arguments", message: "give probe_commands, acceptance, or both" };
  if (check?.error) return check;
  const probe = await run(preflightCodexWorkerOp, only(preflightCodexWorkerOp, { ...dispatchOptions(args), probeCommands: args.probe_commands }));
  return check ? { ...probe, acceptance_check: check } : probe;
});

export const createWorkerTool = defineTool("create_worker", {
  title: "Dispatch a worker",
  description: "Start a worker on one verifiable piece of work in its own git worktree and branch. It never commits or pushes. task is the whole brief: background, spec, write set, verify command, output format. followup_of continues a finished worker from its branch with its settings. runner: codex (default) or claude.",
  inputSchema: {
    task: z.string(),
    cwd: z.string().optional().describe("Repository. Required unless followup_of"),
    owned_paths: z.array(z.string()).optional().describe("Paths it may change; overlap with an active worker is refused. Required unless followup_of"),
    goal: group("{objective, token_budget}. Required unless followup_of"),
    title: z.string().optional(),
    followup_of: z.string().optional(),
    depends_on: z.array(z.string()).optional().describe("Tasks that must land first"),
    preflight_id: z.string().optional().describe("Passed preflight id"),
    runner: z.string().optional(),
    model: z.string().optional(),
    reasoning_effort: effort,
    session: group("{id, title, note}: one id per batch"),
    workspace: workspaceShape,
    sandbox: sandboxShape,
    context: contextShape,
    acceptance: acceptanceShape,
    limits: limitsShape
  }
}, async (args) => {
  const options = dispatchOptions(args);
  if (args.followup_of) {
    return run(createCodexFollowupWorkerOp, only(createCodexFollowupWorkerOp, { ...options, task_id: args.followup_of, followup_prompt: args.task }));
  }
  for (const name of ["cwd", "owned_paths", "goal"]) {
    if (args[name] === undefined) return { error: "invalid_arguments", message: `${name} is required unless followup_of is given` };
  }
  return run(createCodexWorkerOp, only(createCodexWorkerOp, { ...options, task: args.task, preflight_id: args.preflight_id, dependsOn: args.depends_on }));
});

export const resumeWorkerTool = defineTool("resume_worker", {
  title: "Continue a worker",
  description: "Continue the same worker session with a new instruction, in its worktree; the thread keeps its history. Use it to fix what review found before landing. rebase_onto first moves the worktree onto a newer commit and refuses on conflict. A worktree removed by cleanup is restored from the worker's branch.",
  inputSchema: {
    task_id: z.string(),
    prompt: z.string(),
    rebase_onto: z.string().optional().describe("Commit or branch to rebase the worktree onto before continuing"),
    context_files: z.array(z.object({ path: z.string(), sha256: z.string().optional() })).max(20).optional().describe("Replaces the worker's context files"),
    acceptance: acceptanceShape.describe("Replaces the stored acceptance commands; an empty list clears them")
  }
}, (args) => run(resumeCodexWorkerOp, {
  task_id: args.task_id, prompt: args.prompt, rebaseOnto: args.rebase_onto, context: args.context_files,
  acceptance: acceptanceCommands(args.acceptance?.commands)
}));

export const cancelWorkerTool = defineTool("cancel_worker", {
  title: "Stop a worker",
  description: "Stop a running worker or its acceptance run. Its worktree and what it changed so far stay.",
  inputSchema: { task_id: z.string() }
}, (args) => run(cancelCodexWorkerOp, { task_id: args.task_id }));
