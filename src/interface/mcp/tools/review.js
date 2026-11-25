import { createCodexWorker } from "../../../app/dispatch.js";
import { appendTaskEvent } from "../../../infra/store/events.js";
import { createReviewAssignment, getReviewByVerifierTask, recordJsonArtifact, recordReviewFinding, resolveReviewFinding } from "../../../infra/store/records.js";
import { getTask } from "../../../infra/store/tasks.js";
import { runIdFor } from "../../../infra/store/db.js";
import { errorResult, textResult } from "../result.js";
import { isSettled } from "../../../app/settled.js";
import { receipt } from "../views/task.js";
import { createHash } from "node:crypto";
import { z } from "zod";

export const createIndependentVerifierTool = [
  "create_independent_verifier",
  {
    title: "Create an independent read-only verifier",
    description: "Create a fresh read-only verifier for one settled worker. It receives the target objective and current worktree path, never the target report or candidate facts, has no network and cannot dispatch workers. The review relation is persisted for later finding and resolution.",
    inputSchema: { task_id: z.string().min(1), title: z.string().min(1).max(120).optional() }
  },
  async ({ task_id, title }) => {
    try {
      const subject = await getTask(task_id);
      if (!subject) return textResult({ error: "task_not_found", task_id });
      if (!isSettled(subject)) return textResult({ error: "review_subject_active", task_id, reason: "wait for the worker and any acceptance to settle before independent review" });
      const sourceRoot = subject.worktree_path ?? subject.project_root;
      const verifier = await createCodexWorker({
        title: title ?? `Independent review: ${subject.title ?? subject.id}`,
        task: [
          "Independently verify the target worker's objective from the current source tree and Git state.",
          `Target task ID: ${subject.id}`,
          `Target objective: ${subject.goal_objective ?? subject.title ?? "unspecified"}`,
          `Inspect root: ${sourceRoot}`,
          "Do not trust or request the target worker's report. Do not inspect candidate facts. Do not edit files, use network, create workers or call MCP tools.",
          "Return whether the stated objective is met, the exact evidence you inspected, and any unresolved gap."
        ].join("\n"),
        cwd: sourceRoot,
        workspaceKind: "read_only_in_place",
        sandbox: "read-only",
        ownedPaths: [],
        networkAccess: false,
        goal: { objective: `Independently verify worker ${subject.id} without relying on its self-report` }
      });
      const fingerprint = createHash("sha256").update(JSON.stringify({
        task_id: subject.id,
        run: subject.run_count ?? 0,
        base_sha: subject.base_commit ?? null,
        worktree: sourceRoot,
        updated_at: subject.updated_at ?? null,
        changed_files: subject.changed_files ?? []
      })).digest("hex");
      const review = await createReviewAssignment({
        subjectTaskId: subject.id,
        verifierTaskId: verifier.id,
        subjectRunId: runIdFor(subject.id, subject.run_count ?? 1),
        subjectBaseSha: subject.base_commit ?? null,
        subjectFingerprint: fingerprint
      });
      return textResult({ ...receipt(verifier), review });
    } catch (error) {
      return errorResult(error);
    }
  }
];

export const recordIndependentFindingTool = [
  "record_independent_finding",
  {
    title: "Record an independent verifier finding",
    description: "After a verifier settles, record its passes/fails/inconclusive verdict with a concise reason. The supervisor stores a retained finding artifact and appends an event to the reviewed worker; this does not change the reviewed worker's delivery state automatically.",
    inputSchema: { verifier_task_id: z.string().min(1), verdict: z.enum(["passes", "fails", "inconclusive"]), reason: z.string().min(1).max(4000) }
  },
  async ({ verifier_task_id, verdict, reason }) => {
    try {
      const review = await getReviewByVerifierTask(verifier_task_id);
      if (!review) return textResult({ error: "review_not_found", verifier_task_id });
      if (review.status !== "pending") return textResult({ error: "review_not_pending", verifier_task_id, status: review.status });
      const verifier = await getTask(verifier_task_id);
      if (!verifier || !isSettled(verifier)) return textResult({ error: "verifier_not_settled", verifier_task_id });
      const subject = await getTask(review.subject_task_id);
      if (!subject) return textResult({ error: "review_subject_not_found", task_id: review.subject_task_id });
      const artifact = await recordJsonArtifact({
        runId: runIdFor(verifier.id, verifier.run_count ?? 1),
        type: "independent_review_finding",
        value: { review_id: review.id, subject_task_id: subject.id, verifier_task_id, verdict, reason, verifier_run: verifier.run_count ?? 1, recorded_at: new Date().toISOString() },
        securityClass: "internal"
      });
      const event = await appendTaskEvent(subject.id, { type: "supervisor.independent_finding", review_id: review.id, verifier_task_id, verdict, reason, artifact_id: artifact.id }, {
        runId: review.subject_run_id ?? runIdFor(subject.id, subject.run_count ?? 1), actor: "main_thread"
      });
      const recorded = await recordReviewFinding({ verifierTaskId: verifier_task_id, verdict, reason, evidenceArtifactId: artifact.id, findingEventId: event.id });
      return textResult({ review: recorded, artifact_id: artifact.id });
    } catch (error) {
      return errorResult(error);
    }
  }
];

export const resolveIndependentFindingTool = [
  "resolve_independent_finding",
  {
    title: "Resolve an independent verifier finding",
    description: "Record how a previously recorded independent finding was resolved. This is an audit transition only; it does not hide the finding or alter worker code.",
    inputSchema: { verifier_task_id: z.string().min(1), resolution: z.string().min(1).max(4000) }
  },
  async ({ verifier_task_id, resolution }) => {
    try {
      const review = await resolveReviewFinding({ verifierTaskId: verifier_task_id, resolution });
      if (!review) return textResult({ error: "review_not_recorded", verifier_task_id });
      const subject = await getTask(review.subject_task_id);
      if (subject) await appendTaskEvent(subject.id, { type: "supervisor.independent_finding_resolved", review_id: review.id, verifier_task_id, resolution }, {
        runId: review.subject_run_id ?? runIdFor(subject.id, subject.run_count ?? 1), actor: "main_thread"
      });
      return textResult({ review });
    } catch (error) {
      return errorResult(error);
    }
  }
];

export const getIndependentReviewTool = [
  "get_independent_review",
  {
    title: "Get one independent review relation",
    description: "Read the persisted subject/verifier/finding/resolution relation for a verifier task. Use get_artifact for the retained finding evidence.",
    inputSchema: { verifier_task_id: z.string().min(1) }
  },
  async ({ verifier_task_id }) => {
    const review = await getReviewByVerifierTask(verifier_task_id);
    return textResult(review ? { review } : { error: "review_not_found", verifier_task_id });
  }
];
