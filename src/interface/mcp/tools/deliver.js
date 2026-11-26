import { z } from "zod";
import { applyCleanupOp, cleanupHistoryOp, cleanupPlanOp, landCodexWorkerOp, verifyDeliveryPushOp } from "../handlers/delivery.js";
import { defineTool, run } from "./run.js";

export const landWorkerTool = defineTool("land_worker", {
  title: "Land a worker's commits",
  description: "Cherry-pick the worker's commits onto the branch checked out where it was dispatched. commit_message first commits its uncommitted edits, which is how a sandboxed worker's work gets committed. Refused when acceptance failed or has not run, the target is dirty, or the diff leaves owned_paths; a conflict leaves the target as it was. Read get_worker_diff first.",
  inputSchema: {
    task_id: z.string(),
    commit_message: z.string().optional(),
    onto: z.string().optional().describe("Refuse unless the target is on this branch"),
    include_followup_parents: z.boolean().default(false).describe("Land the whole follow-up chain, root first"),
    commit_messages: z.record(z.string(), z.string()).optional().describe("Task id to commit message, for the chain"),
    ignore_acceptance: z.boolean().default(false).describe("Only when the user said so"),
    allow_outside_owned: z.boolean().default(false).describe("Only when the user said so")
  }
}, (args) => run(landCodexWorkerOp, {
  task_id: args.task_id, onto: args.onto, commitMessage: args.commit_message, includeFollowupParents: args.include_followup_parents,
  commitMessages: args.commit_messages, ignoreAcceptance: args.ignore_acceptance, allowOutsideOwned: args.allow_outside_owned
}));

export const verifyPushTool = defineTool("verify_push", {
  title: "Prove landed work is on the remote",
  description: "Fetch a remote branch and check the landed commit is reachable from it. It only verifies: it never pushes or deploys. Landing is local; this is the proof the work left the machine.",
  inputSchema: {
    task_id: z.string(),
    remote: z.string().default("origin"),
    branch: z.string().optional().describe("Default: the branch the work landed on")
  }
}, (args) => run(verifyDeliveryPushOp, args));

export const cleanupTool = defineTool("cleanup", {
  title: "Inspect or force worktree cleanup",
  description: "Cleanup is automatic during poll_workers: landed or unchanged work goes at once, unlanded work after a hold period, with uncommitted edits committed to the worker's branch first; branches and evidence stay. Use this to see why a worktree is still there (plan), remove SAFE ones now (apply, with plan_id and item_ids), or read what was removed (history).",
  inputSchema: {
    action: z.enum(["plan", "apply", "history"]),
    task_ids: z.array(z.string()).max(200).optional().describe("plan: limit to these workers; history: the first one"),
    project_root: z.string().optional(),
    plan_id: z.string().optional(),
    item_ids: z.array(z.string()).max(200).optional(),
    limit: z.number().int().min(1).max(500).optional()
  }
}, (args) => {
  if (args.action === "plan") return run(cleanupPlanOp, { task_ids: args.task_ids, project_root: args.project_root });
  if (args.action === "history") return run(cleanupHistoryOp, { task_id: args.task_ids?.[0], limit: args.limit });
  if (!args.plan_id || !args.item_ids?.length) return { error: "invalid_arguments", message: "apply needs plan_id and item_ids from a plan" };
  return run(applyCleanupOp, { plan_id: args.plan_id, item_ids: args.item_ids });
});
