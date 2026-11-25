import { z } from "zod";
import { getWorkerPreflightOp } from "../handlers/dispatch.js";
import { getContextSnapshotMetaOp, getWorkerEvidenceOp } from "../handlers/facts.js";
import { describeSessionOp, getCodexWorkerEventsOp, getCodexWorkerStatusOp, getSessionWorksOp, searchWorksOp } from "../handlers/overview.js";
import { askCodexWorkerOp, getWorkerDiffOp, getWorkerGoalOp, getWorkerResultOp, getWorkerSummaryOp } from "../handlers/results.js";
import { asData, defineTool, isFailure, run } from "./run.js";
import { acceptanceCommands } from "./shapes.js";

const PARTS = ["status", "result", "goal", "events", "evidence", "context", "preflight", "prompt"];

// A read that found the worker returns its row, which always has a status;
// "task_not_found" and the like do not. Only the former is data.
const row = async (reading) => {
  const payload = await reading;
  return payload?.status === undefined ? payload : asData(payload);
};

// Each part of a worker and the operation that reads it.
const READERS = {
  status: (args) => row(run(getCodexWorkerStatusOp, { task_id: args.task_id, includePrompt: args.include.includes("prompt") })),
  result: (args) => row(run(getWorkerResultOp, {
    task_id: args.task_id, maxChars: args.max_chars, limit: args.result_limit, includeFiles: args.include_files
  })),
  goal: (args) => run(getWorkerGoalOp, { task_id: args.task_id }),
  events: (args) => run(getCodexWorkerEventsOp, { task_id: args.task_id, limit: args.event_limit, kinds: args.event_kinds, maxChars: args.max_chars }),
  evidence: (args) => run(getWorkerEvidenceOp, { task_id: args.task_id }),
  context: (args) => run(getContextSnapshotMetaOp, { task_id: args.task_id }),
  preflight: (args) => row(run(getWorkerPreflightOp, { task_id: args.task_id }))
};

export const getWorkerTool = defineTool("get_worker", {
  title: "Read one worker",
  description: "One worker, in the parts you ask for. No include: a one-paragraph summary; one part: that part; several: an object keyed by part. result: its report, the supervisor's acceptance verdict and the commands it really ran. status: live state. events: the raw stream. goal: objective and token use. preflight: a probe's verdict. evidence, context: what was recorded and given. prompt: the task text. A report is a claim; acceptance and get_worker_diff are the evidence.",
  inputSchema: {
    task_id: z.string(),
    include: z.array(z.enum(PARTS)).default([]),
    max_chars: z.number().int().min(0).max(1000000).optional().describe("Cap on report or event text; default 6000 for result"),
    event_limit: z.number().int().min(1).max(1000).optional(),
    event_kinds: z.array(z.string()).optional(),
    result_limit: z.number().int().min(1).max(20).optional().describe("Earlier runs too"),
    include_files: z.boolean().optional().describe("List changed files")
  }
}, async (args) => {
  const wanted = args.include.includes("prompt") && !args.include.includes("status") ? [...args.include, "status"] : args.include;
  const parts = wanted.filter((part) => READERS[part]);
  if (parts.length === 0) return row(run(getWorkerSummaryOp, { task_id: args.task_id }));
  // One part comes back as itself; several come back keyed by part.
  if (parts.length === 1) return READERS[parts[0]]({ ...args, include: wanted });
  const out = { task_id: args.task_id };
  for (const part of parts) {
    const payload = await READERS[part]({ ...args, include: wanted });
    if (isFailure(payload)) return payload;
    out[part] = payload;
  }
  return out;
});

export const getWorkerDiffTool = defineTool("get_worker_diff", {
  title: "Read what a worker changed",
  description: "The worker's actual changes against its base, committed or not. Without file: the list of files with line counts and hunk counts. With file: that file's patch, paged by hunk (cursor from the previous page). Read this before landing; it is what the worker did, whatever it reported.",
  inputSchema: {
    task_id: z.string(),
    file: z.string().optional(),
    hunk: z.number().int().min(0).optional().describe("Start at this hunk of the file"),
    page_size: z.number().int().min(1).max(20).default(4).describe("Hunks per page"),
    cursor: z.string().optional(),
    max_chars: z.number().int().min(0).max(1000000).optional().describe("With no file: return every patch in one reply, capped at this size"),
    paths: z.array(z.string()).optional().describe("Limit the diff to these paths")
  }
}, (args) => run(getWorkerDiffOp, {
  task_id: args.task_id, file: args.file, hunk: args.hunk, pageSize: args.page_size, cursor: args.cursor, maxChars: args.max_chars, paths: args.paths
}));

export const askWorkerTool = defineTool("ask_worker", {
  title: "Ask a worker a side question",
  description: "Ask the worker why it did something without touching its work: its thread is forked into a read-only session with no network and no MCP tools, and the fork answers. Follow-up questions continue that fork; fresh starts a new one from the worker's current thread, end deletes it.",
  inputSchema: {
    task_id: z.string(),
    question: z.string().optional(),
    timeout_ms: z.number().int().min(1000).max(600000).default(110000),
    max_chars: z.number().int().min(0).max(1000000).default(8000),
    fresh: z.boolean().default(false),
    end: z.boolean().default(false)
  }
}, (args) => run(askCodexWorkerOp, {
  task_id: args.task_id, question: args.question, timeoutMs: args.timeout_ms, maxChars: args.max_chars, fresh: args.fresh, end: args.end
}));

export const findWorksTool = defineTool("find_works", {
  title: "Find earlier work",
  description: "Every worker of one session, or a substring search over titles, goals, prompts and last messages, newest first. Use it before dispatching to see whether the work was already done, and after a restart to pick a batch up again.",
  inputSchema: {
    session_id: z.string().optional(),
    query: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional()
  }
}, (args) => {
  if (args.session_id) return run(getSessionWorksOp, { session_id: args.session_id });
  if (args.query) return run(searchWorksOp, { query: args.query, limit: args.limit });
  return { error: "invalid_arguments", message: "give session_id or query" };
});

export const describeSessionTool = defineTool("describe_session", {
  title: "Describe a batch",
  description: "Record what a session is for and the rules its workers share: a title and note, an objective, acceptance commands added to every worker of the session, and an approval state. waiting_user stops dispatch, resume and landing in the session until it is approved again.",
  inputSchema: {
    session_id: z.string(),
    title: z.string().max(120).optional(),
    note: z.string().max(2000).optional(),
    objective: z.string().max(5000).optional(),
    default_acceptance: z.array(z.union([z.string(), z.record(z.string(), z.unknown())])).max(10).optional(),
    approval_state: z.enum(["approved", "waiting_user"]).optional(),
    expected_revision: z.number().int().nonnegative().optional().describe("Refuse the change if the session policy moved past this revision")
  }
}, (args) => run(describeSessionOp, { ...args, default_acceptance: acceptanceCommands(args.default_acceptance) }));
