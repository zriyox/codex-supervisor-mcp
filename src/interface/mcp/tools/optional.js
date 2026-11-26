// Tools most batches never need: the fact ledger, independent review and raw
// artifacts. They are registered only when AGENT_SUPERVISOR_TOOLS=all.
import { z } from "zod";
import { getArtifactOp, getFactOp, promoteWorkerFactOp, revokeWorkerFactOp, searchWorkerFactsOp } from "../handlers/facts.js";
import { createIndependentVerifierOp, getIndependentReviewOp, recordIndependentFindingOp, resolveIndependentFindingOp } from "../handlers/review.js";
import { defineTool, run } from "./run.js";

const FACT_ACTIONS = {
  search: (args) => run(searchWorkerFactsOp, { task_id: args.task_id, query: args.query, limit: args.limit, cursor: args.cursor }),
  get: (args) => run(getFactOp, { fact_id: args.fact_id }),
  promote: (args) => run(promoteWorkerFactOp, { fact_id: args.fact_id, scope: args.scope, watchedPaths: args.watched_paths, expiresAt: args.expires_at }),
  revoke: (args) => run(revokeWorkerFactOp, { fact_id: args.fact_id, reason: args.reason })
};

export const factsTool = defineTool("facts", {
  title: "Read and manage verified facts",
  description: "The ledger of what workers established. search: verified facts visible to a worker (its own, its dependencies', and repository facts whose watched paths and base still match). get: one fact with its versions. promote: the main thread turns a worker's candidate into a verified fact. revoke: withdraw one, with a reason. A worker cannot promote its own claims.",
  inputSchema: {
    action: z.enum(["search", "get", "promote", "revoke"]),
    task_id: z.string().optional().describe("search"),
    fact_id: z.string().optional().describe("get, promote, revoke"),
    query: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional(),
    cursor: z.string().optional(),
    scope: z.enum(["work_item", "repo_verified"]).optional().describe("promote"),
    watched_paths: z.array(z.string()).optional().describe("promote to repo_verified: paths whose change expires the fact"),
    expires_at: z.string().optional(),
    reason: z.string().optional().describe("revoke")
  }
}, (args) => FACT_ACTIONS[args.action](args));

const REVIEW_ACTIONS = {
  start: (args) => run(createIndependentVerifierOp, { task_id: args.task_id, title: args.title }),
  record: (args) => run(recordIndependentFindingOp, { verifier_task_id: args.verifier_task_id, verdict: args.verdict, reason: args.reason }),
  resolve: (args) => run(resolveIndependentFindingOp, { verifier_task_id: args.verifier_task_id, resolution: args.resolution }),
  get: (args) => run(getIndependentReviewOp, { verifier_task_id: args.verifier_task_id })
};

export const reviewTool = defineTool("review", {
  title: "Have settled work checked independently",
  description: "start: dispatch a read-only, offline verifier that sees the goal and the worktree but not the worker's own report. record: store its verdict. resolve: store how a finding was closed. get: the whole trail.",
  inputSchema: {
    action: z.enum(["start", "record", "resolve", "get"]),
    task_id: z.string().optional().describe("start: the worker to verify"),
    verifier_task_id: z.string().optional().describe("record, resolve, get"),
    title: z.string().optional(),
    verdict: z.enum(["passes", "fails", "inconclusive"]).optional(),
    reason: z.string().optional(),
    resolution: z.string().optional()
  }
}, (args) => REVIEW_ACTIONS[args.action](args));

export const getArtifactTool = defineTool("get_artifact", {
  title: "Read a stored evidence artifact",
  description: "One artifact the supervisor kept (a push proof, a review finding), by the id found in get_worker evidence.",
  inputSchema: { artifact_id: z.string(), max_chars: z.number().int().min(0).max(1000000).optional() }
}, (args) => run(getArtifactOp, { artifact_id: args.artifact_id, maxChars: args.max_chars }));
