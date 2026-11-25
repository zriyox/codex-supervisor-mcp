import { runAcceptance } from "../../../app/acceptance.js";
import { createCodexWorker } from "../../../app/dispatch.js";
import { createFollowupWorker } from "../../../app/followup.js";
import { resumeCodexWorker } from "../../../app/resume.js";
import { readPreflightResult } from "../../../domain/worker-preflight.js";
import { runGit } from "../../../infra/git.js";
import { getTask } from "../../../infra/store/tasks.js";
import { baseBehind } from "../../../infra/worktree.js";
import { errorResult, textResult } from "../result.js";
import { acceptanceInput, workspaceSetupInput } from "../schemas.js";
import { withUpdate } from "../update-state.js";
import { receipt } from "../views/task.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";

export const checkAcceptanceOp = {
  input: z.object({
      cwd: z.string().min(1), acceptance: acceptanceInput,
      baseRef: z.string().min(1).optional(), timeoutMs: z.number().int().min(1000).max(1800000).default(600000)
    }),
  handler: async ({ cwd, acceptance, baseRef = "HEAD", timeoutMs }) => {
    let base;
    try {
      base = runGit(cwd, ["rev-parse", "--verify", `${baseRef}^{commit}`], { timeout: 10000 });
    } catch {
      return textResult({ error: "invalid_base_ref", phase: "preflight", reason: `workspace.base_ref does not resolve in ${cwd}`, proves_worker_completion: false });
    }
    try {
      const commands = Array.isArray(acceptance) ? acceptance : [acceptance];
      const warnings = commands.filter((check) => typeof check === "string" && /(?:failures|errors)\s*=\s*\d/.test(check)).map(() => "failure-count checks do not prove baseline test identities or required execution; use structured evidence");
      const result = await runAcceptance(commands, { cwd, timeoutMs, baseCommit: base, taskId: `preflight-${randomUUID()}` });
      return textResult({ ...result, phase: "preflight", base_commit: base, proves_worker_completion: false, warnings });
    } catch (error) {
      return errorResult(error);
    }
  }
};

export const preflightCodexWorkerOp = {
  input: z.object({
      title: z.string().optional(),
      cwd: z.string().min(1),
      sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).default("workspace-write"),
      model: z.string().optional(),
      reasoningEffort: z.enum(["minimal", "low", "medium", "high"]).default("high"),
      skipGitRepoCheck: z.boolean().default(true),
      ownedPaths: z.array(z.string().min(1)),
      forbid: z.array(z.string().min(1)).max(100).optional(),
      allowedCommands: z.array(z.string().min(1)).max(100).optional(),
      context: z.array(z.object({ path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() })).max(20).optional(),
      contracts: z.array(z.string().min(1).max(2000)).max(20).optional(),
      networkAccess: z.boolean().default(false),
      writableRoots: z.array(z.string().min(1)).max(20).optional(),
      maxRunMs: z.number().int().min(1000).max(86400000).optional(),
      maxTotalMs: z.number().int().min(1000).max(604800000).optional(),
      baseRef: z.string().min(1).optional(),
      workspaceKind: z.enum(["git_worktree", "read_only_in_place", "scratch", "in_place_write"]).optional(),
      inPlaceAuthorization: z.string().min(1).max(2000).optional(),
      workspaceSetup: workspaceSetupInput.optional(),
      probeCommands: z.array(z.string().min(1)).min(1).max(20)
    }),
  handler: async (input) => {
    try {
      const task = [
        "Runtime environment preflight. Do not edit files, create files, install packages, dispatch workers or call MCP tools.",
        "Run every command below exactly once, in the listed order, without wrapping it in another shell command.",
        "If any command is denied, missing, times out or exits nonzero, stop and quote the raw error under Not done / risks.",
        "Commands:",
        ...input.probeCommands.map((command) => `- ${command}`)
      ].join("\n");
      const record = await createCodexWorker({
        ...input,
        title: input.title ? `Preflight: ${input.title}` : "Runtime environment preflight",
        task,
        goal: { objective: `Prove the requested Codex worker runtime environment before dispatching ${input.title ?? "the dependent worker"}` },
        acceptance: null,
        preflight: { probeCommands: input.probeCommands }
      });
      return textResult(withUpdate({ ...receipt(record), preflight: { status: "running", probe_commands: input.probeCommands } }));
    } catch (error) {
      return errorResult(error);
    }
  }
};

export const getWorkerPreflightOp = {
  input: z.object({ task_id: z.string().min(1) }),
  handler: async ({ task_id }) => {
    const task = await getTask(task_id);
    if (!task) return textResult({ error: "task_not_found", task_id });
    return textResult(readPreflightResult(task));
  }
};

export const createCodexWorkerOp = {
  input: z.object({
      title: z.string().optional(),
      task: z.string().min(1),
      cwd: z.string().min(1),
      session_id: z.string().min(1).optional(),
      // What this batch is about, in one line, so a reader of the store sees
      // "给 12 个接口补单测" instead of a bare session id. Set it on
      // the first dispatch of a session; later dispatches may omit it.
      session_title: z.string().min(1).max(120).optional(),
      session_note: z.string().min(1).max(2000).optional(),
      sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).default("workspace-write"),
      model: z.string().optional(),
      reasoningEffort: z.enum(["minimal", "low", "medium", "high"]).default("high"),
      skipGitRepoCheck: z.boolean().default(true),
      // Empty is the promise that nothing lands: a read-only verifier, or a
      // research worker that reads, fetches and reports but merges nothing.
      ownedPaths: z.array(z.string().min(1)),
      forbid: z.array(z.string().min(1)).max(100).optional(),
      allowedCommands: z.array(z.string().min(1)).max(100).optional(),
      context: z.array(z.object({ path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() })).max(20).optional(),
      contracts: z.array(z.string().min(1).max(2000)).max(20).optional(),
      externalOutputs: z.array(z.object({ path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() })).max(20).optional(),
      networkAccess: z.boolean().default(false),
      // Extra absolute directories the sandbox may write. The OS cache
      // directory is already writable; this is for toolchains that keep a
      // cache somewhere else (~/.m2, ~/.gradle, a vendored mirror).
      writableRoots: z.array(z.string().min(1)).max(20).optional(),
      maxRunMs: z.number().int().min(1000).max(86400000).optional(),
      maxTotalMs: z.number().int().min(1000).max(604800000).optional(),
      goal: z.object({
        objective: z.string().min(1),
        tokenBudget: z.number().int().positive().optional()
      }),
      dependsOn: z.array(z.string().min(1)).optional(),
      // Which commit the worktree is cut from. Defaults to the repository's
      // HEAD; pass a branch, tag or sha to build on work that is not on the
      // main line yet (for example another worker's branch).
      baseRef: z.string().min(1).optional(),
      workspaceKind: z.enum(["git_worktree", "read_only_in_place", "scratch", "in_place_write"]).optional(),
      inPlaceAuthorization: z.string().min(1).max(2000).optional(),
      workspaceSetup: workspaceSetupInput.optional(),
      // A successful preflight_worker task id. When present, this worker
      // is refused unless base commit and the complete runtime contract match.
      preflight_id: z.string().min(1).optional(),
      // Shell commands that decide whether the work is done. The supervisor
      // runs them in the worktree after codex exits; each must exit 0.
      acceptance: acceptanceInput.optional(),
      acceptanceTimeoutMs: z.number().int().min(1000).max(1800000).optional()
    }),
  handler: async (input) => {
    try {
      const record = await createCodexWorker({
        ...input,
        preflightId: input.preflight_id ?? null,
        sessionId: input.session_id ?? null,
        sessionTitle: input.session_title ?? null,
        sessionNote: input.session_note ?? null
      });
      return textResult(withUpdate(receipt(record)));
    } catch (error) {
      return errorResult(error);
    }
  }
};

export const createCodexFollowupWorkerOp = {
  input: z.object({
      task_id: z.string().min(1),
      followup_prompt: z.string().min(1),
      session_id: z.string().min(1).optional(),
      session_title: z.string().min(1).max(120).optional(),
      session_note: z.string().min(1).max(2000).optional(),
      title: z.string().optional(),
      cwd: z.string().optional(),
      sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional(),
      model: z.string().optional(),
      reasoningEffort: z.enum(["minimal", "low", "medium", "high"]).default("high"),
      ownedPaths: z.array(z.string().min(1)).optional(),
      forbid: z.array(z.string().min(1)).max(100).optional(),
      allowedCommands: z.array(z.string().min(1)).max(100).optional(),
      context: z.array(z.object({ path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() })).max(20).optional(),
      contracts: z.array(z.string().min(1).max(2000)).max(20).optional(),
      externalOutputs: z.array(z.object({ path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() })).max(20).optional(),
      networkAccess: z.boolean().optional(),
      writableRoots: z.array(z.string().min(1)).max(20).optional(),
      maxRunMs: z.number().int().min(1000).max(86400000).optional(),
      maxTotalMs: z.number().int().min(1000).max(604800000).optional(),
      workspaceKind: z.enum(["git_worktree", "read_only_in_place", "scratch", "in_place_write"]).optional(),
      inPlaceAuthorization: z.string().min(1).max(2000).optional(),
      workspaceSetup: workspaceSetupInput.optional(),
      goal: z
        .object({
          objective: z.string().min(1),
          tokenBudget: z.number().int().positive().optional()
        })
        .optional(),
      baseRef: z.string().min(1).optional(),
      // Left out, the parent's acceptance commands are inherited; given, they
      // replace them, and an empty list clears them.
      acceptance: acceptanceInput.optional(),
      acceptanceTimeoutMs: z.number().int().min(1000).max(1800000).optional()
    }),
  handler: async ({ task_id, followup_prompt, session_id, session_title, session_note, ...options }) => {
    try {
      const record = await createFollowupWorker({
          taskId: task_id,
          followupPrompt: followup_prompt,
          sessionId: session_id ?? null,
          sessionTitle: session_title ?? null,
          sessionNote: session_note ?? null,
          ...options
        });
      return textResult(receipt(record));
    } catch (error) {
      return errorResult(error);
    }
  }
};

export const resumeCodexWorkerOp = {
  input: z.object({
      task_id: z.string().min(1),
      prompt: z.string().min(1),
      rebaseOnto: z.string().min(1).optional(),
      context: z.array(z.object({ path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() })).max(20).optional(),
      // Replaces the stored acceptance commands for this and later runs; an
      // empty list clears them. Left out, the stored commands stay.
      acceptance: acceptanceInput.optional()
    }),
  handler: async ({ task_id, prompt, rebaseOnto, acceptance, context }) => {
    try {
      const record = await resumeCodexWorker({ taskId: task_id, prompt, rebaseOnto: rebaseOnto ?? null, acceptance, context });
      return textResult({ ...receipt(record), rebase: record.rebase ?? null, base_behind: baseBehind(record.project_root, record.base_commit) });
    } catch (error) {
      return errorResult(error);
    }
  }
};
