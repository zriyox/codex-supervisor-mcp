import { git } from "../../../app/land-chain.js";
import { appendTaskEvent, readTaskEventRecords } from "../../../infra/store/events.js";
import { countVerifiedFacts, getFact, getFactEffectiveState, getTaskForWorkItem, isFactRevoked, latestContextSnapshotForTask, listContextFacts, promoteCandidateFact, revokeFact } from "../../../infra/store/facts.js";
import { getArtifact, listArtifactsForTask, readArtifact } from "../../../infra/store/records.js";
import { getTask } from "../../../infra/store/tasks.js";
import { runIdFor } from "../../../infra/store/db.js";
import { clip, errorResult, textResult } from "../result.js";
import { z } from "zod";

export const getContextSnapshotMetaOp = {
  input: z.object({ task_id: z.string().min(1) }),
  handler: async ({ task_id }) => {
    const task = await getTask(task_id);
    if (!task) return textResult({ error: "task_not_found", task_id });
    const snapshot = await latestContextSnapshotForTask(task_id);
    if (!snapshot) return textResult({ task_id, snapshot: null });
    return textResult({
      task_id,
      snapshot: {
        id: snapshot.id,
        run_id: snapshot.run_id,
        recipient: snapshot.recipient,
        fact_ids: JSON.parse(snapshot.fact_versions),
        base_sha: snapshot.base_sha,
        prompt_sha256: snapshot.prompt_sha256,
        estimated_tokens: snapshot.estimated_tokens,
        excluded: JSON.parse(snapshot.excluded_json),
        created_at: snapshot.created_at
      }
    });
  }
};

export const getFactOp = {
  input: z.object({ fact_id: z.string().uuid() }),
  handler: async ({ fact_id }) => {
    const fact = await getFact(fact_id);
    if (!fact) return textResult({ error: "fact_not_found", fact_id });
    return textResult({ fact, effective_state: await getFactEffectiveState(fact_id) ?? fact.state });
  }
};

export const getArtifactOp = {
  input: z.object({ artifact_id: z.string().uuid(), maxChars: z.number().int().min(0).max(100000).default(12000) }),
  handler: async ({ artifact_id, maxChars }) => {
    const artifact = await getArtifact(artifact_id);
    if (!artifact) return textResult({ error: "artifact_not_found", artifact_id });
    return textResult({ artifact: await readArtifact(artifact_id, maxChars) });
  }
};

export const promoteWorkerFactOp = {
  input: z.object({
      fact_id: z.string().uuid(),
      scope: z.enum(["work_item", "repo_verified"]).default("work_item"),
      watchedPaths: z.array(z.string().min(1)).max(100).optional(),
      expiresAt: z.string().datetime().optional()
    }),
  handler: async ({ fact_id, scope, watchedPaths, expiresAt }) => {
    try {
      const source = await getFact(fact_id);
      if (!source) return textResult({ error: "fact_not_found", fact_id });
      if (await isFactRevoked(fact_id)) return textResult({ error: "fact_already_revoked", fact_id });
      const task = await getTaskForWorkItem(source.work_item_id);
      if (!task) return textResult({ error: "fact_task_not_found", fact_id });
      const event = await appendTaskEvent(task.id, { type: "supervisor.fact_promoted", source_fact_id: fact_id, scope, watched_paths: watchedPaths ?? source.watched_paths ?? [], expires_at: expiresAt ?? null }, {
        runId: runIdFor(task.id, task.run_count ?? 1), actor: "main_thread"
      });
      const fact = await promoteCandidateFact({
        factId: fact_id,
        scopeType: scope,
        watchedPaths,
        expiresAt: expiresAt ?? null,
        sourceEventId: event.id,
        verifiedBy: "main_thread"
      });
      return textResult({ fact, source_fact_id: fact_id });
    } catch (error) {
      return errorResult(error);
    }
  }
};

export const revokeWorkerFactOp = {
  input: z.object({ fact_id: z.string().uuid(), reason: z.string().min(1).max(2000) }),
  handler: async ({ fact_id, reason }) => {
    try {
      const source = await getFact(fact_id);
      if (!source) return textResult({ error: "fact_not_found", fact_id });
      const task = await getTaskForWorkItem(source.work_item_id);
      if (!task) return textResult({ error: "fact_task_not_found", fact_id });
      const revoked = await revokeFact(fact_id);
      await appendTaskEvent(task.id, { type: "supervisor.fact_revoked", fact_id, reason }, {
        runId: runIdFor(task.id, task.run_count ?? 1), actor: "main_thread"
      });
      return textResult({ fact: revoked, reason });
    } catch (error) {
      return errorResult(error);
    }
  }
};

export const getWorkerEvidenceOp = {
  input: z.object({ task_id: z.string().min(1), limit: z.number().int().min(1).max(100).default(30) }),
  handler: async ({ task_id, limit }) => {
    const task = await getTask(task_id);
    if (!task) return textResult({ error: "task_not_found", task_id });
    const events = await readTaskEventRecords(task_id, limit);
    const artifacts = await listArtifactsForTask(task_id, limit);
    return textResult({
      task_id,
      events: events.map((event) => ({
        id: event.id, run_id: event.run_id, type: event.event_type, actor: event.actor,
        payload_sha256: event.payload_sha256, created_at: event.created_at
      })),
      artifacts: artifacts.map((artifact) => ({
        id: artifact.id, run_id: artifact.run_id, type: artifact.type, sha256: artifact.sha256,
        security_class: artifact.security_class, retention: artifact.retention, created_at: artifact.created_at
      }))
    });
  }
};

function decodeFactCursor(cursor, taskId, query) {
  if (!cursor) return 0;
  try {
    const payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (payload.task_id !== taskId || payload.query !== query || !Number.isInteger(payload.offset) || payload.offset < 0) throw new Error("mismatch");
    return payload.offset;
  } catch {
    const error = new Error("fact cursor does not match this task and query");
    error.code = "invalid_fact_cursor";
    throw error;
  }
}

function encodeFactCursor(taskId, query, offset) {
  return Buffer.from(JSON.stringify({ task_id: taskId, query, offset })).toString("base64url");
}

function factFreshForTask(task, fact) {
  if (!fact.valid_for_sha || !task.base_commit) return true;
  try {
    git(task.project_root, ["merge-base", "--is-ancestor", fact.valid_for_sha, task.base_commit]);
    return true;
  } catch {
    return false;
  }
}

export const searchWorkerFactsOp = {
  input: z.object({
      task_id: z.string().min(1),
      query: z.string().max(500).default(""),
      limit: z.number().int().min(1).max(50).default(20),
      cursor: z.string().min(1).optional()
    }),
  handler: async ({ task_id, query, limit, cursor }) => {
    const task = await getTask(task_id);
    if (!task) return textResult({ error: "task_not_found", task_id });
    try {
      const normalizedQuery = query.trim().toLocaleLowerCase();
      const offset = decodeFactCursor(cursor, task_id, normalizedQuery);
      const scoped = (await listContextFacts({
        taskId: task_id,
        baseSha: task.base_commit ?? null,
        ownedPaths: task.owned_paths ?? [],
        dependencyTaskIds: task.depends_on ?? []
      })).filter((fact) => factFreshForTask(task, fact));
      const matching = scoped.filter((fact) => !normalizedQuery || `${fact.key}\n${JSON.stringify(fact.value)}`.toLocaleLowerCase().includes(normalizedQuery));
      const page = matching.slice(offset, offset + limit);
      const nextOffset = offset + page.length;
      const totalVerified = await countVerifiedFacts();
      return textResult({
        task_id,
        facts: page.map((fact) => ({
          id: fact.id,
          key: fact.key,
          summary: clip(typeof fact.value === "string" ? fact.value : JSON.stringify(fact.value), 360),
          state: fact.state,
          scope: fact.scope_type,
          valid_for_sha: fact.valid_for_sha ?? null,
          freshness: "current",
          source_refs: [
            ...(fact.source_event_id ? [`event:${fact.source_event_id}`] : []),
            ...(fact.source_artifact_id ? [`artifact:${fact.source_artifact_id}`] : [])
          ]
        })),
        coverage: {
          scope: "current_work+explicit_dependencies+path_matched_repo_facts",
          included_count: scoped.length,
          matched_count: matching.length,
          omitted: [
            { reason: "other_verified_scopes_excluded", count: Math.max(0, totalVerified - scoped.length) },
            { reason: "candidate_and_nonverified_facts_excluded", count: null }
          ]
        },
        next_cursor: nextOffset < matching.length ? encodeFactCursor(task_id, normalizedQuery, nextOffset) : null
      });
    } catch (error) {
      return errorResult(error);
    }
  }
};
