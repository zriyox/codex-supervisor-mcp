import { git } from "../../../app/land-chain.js";
import { appendTaskEvent, countVerifiedFacts, getArtifact, getFact, getFactEffectiveState, getTask, getTaskForWorkItem, isFactRevoked, latestContextSnapshotForTask, listArtifactsForTask, listContextFacts, promoteCandidateFact, readArtifact, readTaskEventRecords, revokeFact, runIdFor } from "../../../infra/store/task-store.js";
import { clip, errorResult, textResult } from "../result.js";
import { z } from "zod";

export const getContextSnapshotMetaTool = [
  "get_context_snapshot_meta",
  {
    title: "Get worker context snapshot metadata",
    description: "Read the latest worker-only context snapshot metadata for one task. Returns fact IDs, token estimate and excluded categories, never the capsule text or raw history.",
    inputSchema: { task_id: z.string().min(1) }
  },
  async ({ task_id }) => {
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
];

export const getFactTool = [
  "get_fact",
  {
    title: "Get one verified or candidate fact",
    description: "Read one fact by ID for audit. Facts are never automatically expanded into the main thread's context.",
    inputSchema: { fact_id: z.string().uuid() }
  },
  async ({ fact_id }) => {
    const fact = await getFact(fact_id);
    if (!fact) return textResult({ error: "fact_not_found", fact_id });
    return textResult({ fact, effective_state: await getFactEffectiveState(fact_id) ?? fact.state });
  }
];

export const getArtifactTool = [
  "get_artifact",
  {
    title: "Get one retained evidence artifact",
    description: "Read one supervisor-managed artifact by ID for audit. This is explicit evidence retrieval and never expands a worker context capsule into the main thread.",
    inputSchema: { artifact_id: z.string().uuid(), maxChars: z.number().int().min(0).max(100000).default(12000) }
  },
  async ({ artifact_id, maxChars }) => {
    const artifact = await getArtifact(artifact_id);
    if (!artifact) return textResult({ error: "artifact_not_found", artifact_id });
    return textResult({ artifact: await readArtifact(artifact_id, maxChars) });
  }
];

export const promoteWorkerFactTool = [
  "promote_worker_fact",
  {
    title: "Promote a candidate worker fact",
    description: "Explicitly promote one candidate fact after main-thread review. The worker cannot call this: promotion writes a new verified fact with an audit event; repo scope requires watched paths.",
    inputSchema: {
      fact_id: z.string().uuid(),
      scope: z.enum(["work_item", "repo_verified"]).default("work_item"),
      watchedPaths: z.array(z.string().min(1)).max(100).optional(),
      expiresAt: z.string().datetime().optional()
    }
  },
  async ({ fact_id, scope, watchedPaths, expiresAt }) => {
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
];

export const revokeWorkerFactTool = [
  "revoke_worker_fact",
  {
    title: "Revoke a candidate or verified worker fact",
    description: "Explicitly revoke one candidate or verified fact after audit. Revoked facts are excluded from search and worker capsules; the revocation is appended to the worker event log.",
    inputSchema: { fact_id: z.string().uuid(), reason: z.string().min(1).max(2000) }
  },
  async ({ fact_id, reason }) => {
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
];

export const getWorkerEvidenceTool = [
  "get_worker_evidence",
  {
    title: "Get a worker evidence index",
    description: "Return bounded event metadata and retained artifact IDs for one worker. It does not return raw history, prompts or a worker context capsule; use get_artifact or get_codex_worker_events for a selected item.",
    inputSchema: { task_id: z.string().min(1), limit: z.number().int().min(1).max(100).default(30) }
  },
  async ({ task_id, limit }) => {
    const task = await getTask(task_id);
    if (!task) return textResult({ error: "task_not_found", task_id });
    const events = await readTaskEventRecords(task_id, limit);
    const artifacts = await listArtifactsForTask(task_id, limit);
    return textResult({
      task_id,
      events: events.map((event) => ({ id: event.id, run_id: event.run_id, type: event.event_type, actor: event.actor, payload_sha256: event.payload_sha256, created_at: event.created_at })),
      artifacts: artifacts.map((artifact) => ({ id: artifact.id, run_id: artifact.run_id, type: artifact.type, sha256: artifact.sha256, security_class: artifact.security_class, retention: artifact.retention, created_at: artifact.created_at }))
    });
  }
];

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

export const searchWorkerFactsTool = [
  "search_worker_facts",
  {
    title: "Search verified worker facts in scope",
    description: "Search only verified facts relevant to one task: its own work, explicit dependencies and path-matched repository facts. Returns compact summaries, coverage and a cursor; never raw events, reports, prompts or worker capsules.",
    inputSchema: {
      task_id: z.string().min(1),
      query: z.string().max(500).default(""),
      limit: z.number().int().min(1).max(50).default(20),
      cursor: z.string().min(1).optional()
    }
  },
  async ({ task_id, query, limit, cursor }) => {
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
];
