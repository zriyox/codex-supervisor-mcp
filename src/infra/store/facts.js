import { runGit } from "../git.js";
import { buildHandoff } from "../handoff.js";
import { captureWorkspaceManifest } from "../workspace-kind.js";
import { decodeJson, ensureFilesystem, openDb } from "./db.js";
import { getTask } from "./tasks.js";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";

export async function getWorkItemForTask(taskId) {
  await ensureFilesystem();
  return openDb().prepare("SELECT * FROM work_items WHERE task_id = ?").get(taskId) ?? null;
}

export async function recordFact({
  workItemId,
  scopeType,
  scopeId,
  key,
  value,
  state = "candidate",
  sourceEventId = null,
  sourceArtifactId = null,
  validForSha = null,
  validForContentHash = null,
  validForManifestHash = null,
  watchedPaths = [],
  expiresAt = null,
  supersedesId = null,
  verifiedAt = null,
  verifiedBy = null
}) {
  await ensureFilesystem();
  if (!workItemId || !scopeType || !scopeId || !key) throw new Error("fact requires workItemId, scopeType, scopeId and key");
  if (!["candidate", "verified", "expired", "revoked"].includes(state)) throw new Error("invalid fact state");
  if (!Array.isArray(watchedPaths) || watchedPaths.some((path) => typeof path !== "string")) throw new Error("watchedPaths must be a string list");
  const now = new Date().toISOString();
  const id = randomUUID();
  openDb().prepare(`
    INSERT INTO facts (id, work_item_id, scope_type, scope_id, key, value_json, state, source_event_id, source_artifact_id, valid_for_sha, valid_for_content_hash, valid_for_manifest_hash, watched_paths, expires_at, supersedes_id, created_at, verified_at, verified_by)
    VALUES (@id, @work_item_id, @scope_type, @scope_id, @key, @value_json, @state, @source_event_id, @source_artifact_id, @valid_for_sha, @valid_for_content_hash, @valid_for_manifest_hash, @watched_paths, @expires_at, @supersedes_id, @created_at, @verified_at, @verified_by)
  `).run({
    id,
    work_item_id: workItemId,
    scope_type: scopeType,
    scope_id: scopeId,
    key,
    value_json: JSON.stringify(value),
    state,
    source_event_id: sourceEventId,
    source_artifact_id: sourceArtifactId,
    valid_for_sha: validForSha,
    valid_for_content_hash: validForContentHash,
    valid_for_manifest_hash: validForManifestHash,
    watched_paths: JSON.stringify(watchedPaths.map((path) => isAbsolute(path) ? resolve(path) : path)),
    expires_at: expiresAt,
    supersedes_id: supersedesId,
    created_at: now,
    verified_at: verifiedAt ?? (state === "verified" ? now : null),
    verified_by: verifiedBy ?? (state === "verified" ? "supervisor" : null)
  });
  return { id, work_item_id: workItemId, scope_type: scopeType, scope_id: scopeId, key, value, state, source_event_id: sourceEventId, source_artifact_id: sourceArtifactId, valid_for_sha: validForSha, valid_for_content_hash: validForContentHash, valid_for_manifest_hash: validForManifestHash, watched_paths: watchedPaths, supersedes_id: supersedesId, verified_by: verifiedBy ?? (state === "verified" ? "supervisor" : null), created_at: now };
}

function pathsOverlap(left, right) {
  const normalize = (path) => process.platform === "win32" ? path.replace(/\\/g, "/").toLowerCase() : path;
  const a = normalize(left).replace(/\/$/, "");
  const b = normalize(right).replace(/\/$/, "");
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function repoRelativePaths(projectRoot, paths) {
  return (paths ?? []).flatMap((path) => {
    if (typeof path !== "string" || !path.trim()) return [];
    const candidate = isAbsolute(path) ? relative(projectRoot, path) : path;
    const normalized = candidate.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
    return !normalized || normalized === ".." || normalized.startsWith("../") ? [] : [normalized];
  });
}

export const git = (cwd, args) => runGit(cwd, args, { timeout: 15000, stderr: "ignore" });

function shaCoversBase(projectRoot, validForSha, baseSha) {
  if (!validForSha || !baseSha) return true;
  try {
    git(projectRoot, ["merge-base", "--is-ancestor", validForSha, baseSha]);
    return true;
  } catch {
    return false;
  }
}

function watchedPathsChanged(projectRoot, validForSha, baseSha, watchedPaths) {
  if (!validForSha || !baseSha || watchedPaths.length === 0) return false;
  try {
    const relativePaths = repoRelativePaths(projectRoot, watchedPaths);
    if (relativePaths.length === 0) return true;
    return Boolean(git(projectRoot, ["diff", "--name-only", validForSha, baseSha, "--", ...relativePaths]));
  } catch {
    return true;
  }
}

async function currentWorkspaceManifest(task) {
  const metadata = task.workspace_metadata;
  if (!metadata?.source_root || !Array.isArray(metadata.manifest_paths) || metadata.manifest_paths.length === 0) return null;
  try {
    return await captureWorkspaceManifest(metadata.source_root, metadata.manifest_paths);
  } catch {
    return null;
  }
}

async function currentContextContentHash(task) {
  const context = task.input_context?.context ?? [];
  if (!Array.isArray(context) || context.length === 0) return null;
  try {
    return (await buildHandoff({ context }, { maxLines: 1, maxChars: 1 })).content_hash;
  } catch {
    return null;
  }
}

function markFactExpired(id) {
  openDb().prepare(`
    INSERT INTO facts (id, work_item_id, scope_type, scope_id, key, value_json, state, source_event_id, source_artifact_id,
      valid_for_sha, valid_for_content_hash, valid_for_manifest_hash, watched_paths, expires_at, supersedes_id, created_at, verified_at, verified_by)
    SELECT ?, source.work_item_id, source.scope_type, source.scope_id, source.key, source.value_json, 'expired', source.source_event_id, source.source_artifact_id,
      source.valid_for_sha, source.valid_for_content_hash, source.valid_for_manifest_hash, source.watched_paths, source.expires_at, source.id, ?, source.verified_at, source.verified_by
    FROM facts AS source
    WHERE source.id = ? AND source.state = 'verified'
      AND NOT EXISTS (SELECT 1 FROM facts AS transition WHERE transition.supersedes_id = source.id AND transition.state IN ('expired', 'revoked'))
  `).run(randomUUID(), new Date().toISOString(), id);
}

export async function listContextFacts({ taskId, baseSha, ownedPaths = [], dependencyTaskIds = [] }) {
  await ensureFilesystem();
  const workItem = await getWorkItemForTask(taskId);
  if (!workItem) return [];
  const task = await getTask(taskId);
  if (!task) return [];
  const dependencyItems = dependencyTaskIds.length === 0
    ? []
    : openDb().prepare(`SELECT id FROM work_items WHERE task_id IN (${dependencyTaskIds.map(() => "?").join(",")})`).all(...dependencyTaskIds).map((row) => row.id);
  const rows = openDb().prepare(`
    SELECT facts.* FROM facts
    WHERE state = 'verified'
      AND NOT EXISTS (SELECT 1 FROM facts AS transition WHERE transition.supersedes_id = facts.id AND transition.state IN ('expired', 'revoked'))
    ORDER BY created_at ASC
  `).all();
  const now = Date.now();
  const workspaceManifest = await currentWorkspaceManifest(task);
  const contextContentHash = await currentContextContentHash(task);
  const repo = openDb().prepare("SELECT canonical_remote FROM repos WHERE id = ?").get(workItem.repo_id);
  const canonicalRemote = repo?.canonical_remote ?? null;
  const ownedRelative = repoRelativePaths(task.project_root, ownedPaths);
  const visible = [];
  for (const row of rows) {
    const watched = decodeJson(row.watched_paths, []);
    const watchedRelative = repoRelativePaths(task.project_root, watched);
    const included = row.scope_type === "work_item" ? row.scope_id === workItem.id
      : row.scope_type === "dependency" ? dependencyItems.includes(row.scope_id)
        : row.scope_type === "repo_verified" && canonicalRemote && row.scope_id === canonicalRemote
          && watchedRelative.length > 0 && watchedRelative.some((path) => ownedRelative.some((owned) => pathsOverlap(path, owned)));
    if (!included) continue;
    if (row.expires_at && Date.parse(row.expires_at) <= now) {
      markFactExpired(row.id);
      continue;
    }
    if (!shaCoversBase(task.project_root, row.valid_for_sha, baseSha)) continue;
    if (watchedPathsChanged(task.project_root, row.valid_for_sha, baseSha, watchedRelative)) {
      if (row.scope_type === "work_item" && row.scope_id === workItem.id) markFactExpired(row.id);
      continue;
    }
    if (row.valid_for_manifest_hash && (!workspaceManifest || workspaceManifest.sha256 !== row.valid_for_manifest_hash)) {
      if (row.scope_type === "work_item" && row.scope_id === workItem.id && workspaceManifest) markFactExpired(row.id);
      continue;
    }
    if (row.valid_for_content_hash && contextContentHash !== row.valid_for_content_hash) {
      if (row.scope_type === "work_item" && row.scope_id === workItem.id) markFactExpired(row.id);
      continue;
    }
    visible.push({
      ...row,
      value: decodeJson(row.value_json, null),
      watched_paths: watched
    });
  }
  return visible;
}

export async function countVerifiedFacts() {
  await ensureFilesystem();
  return openDb().prepare(`
    SELECT COUNT(*) AS count FROM facts
    WHERE state = 'verified'
      AND NOT EXISTS (SELECT 1 FROM facts AS transition WHERE transition.supersedes_id = facts.id AND transition.state IN ('expired', 'revoked'))
  `).get().count;
}

export async function createContextSnapshot({ runId, recipient = "worker", factIds = [], baseSha = null, prompt, estimatedTokens, excluded = {} }) {
  await ensureFilesystem();
  if (!runId || typeof prompt !== "string") throw new Error("context snapshot requires runId and prompt");
  const now = new Date().toISOString();
  const id = randomUUID();
  openDb().prepare(`
    INSERT INTO context_snapshots (id, run_id, recipient, fact_versions, base_sha, prompt_sha256, estimated_tokens, excluded_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, runId, recipient, JSON.stringify(factIds), baseSha,
    createHash("sha256").update(prompt).digest("hex"), estimatedTokens, JSON.stringify(excluded), now);
  return { id, run_id: runId, recipient, fact_versions: factIds, base_sha: baseSha, estimated_tokens: estimatedTokens, created_at: now };
}

export async function latestContextSnapshotForTask(taskId) {
  await ensureFilesystem();
  return openDb().prepare(`
    SELECT s.* FROM context_snapshots s JOIN runs r ON r.id = s.run_id
    WHERE r.task_id = ? ORDER BY s.created_at DESC LIMIT 1
  `).get(taskId) ?? null;
}

export async function getFact(factId) {
  await ensureFilesystem();
  const row = openDb().prepare("SELECT * FROM facts WHERE id = ?").get(factId);
  if (!row) return null;
  return {
    ...row,
    value: decodeJson(row.value_json, null),
    watched_paths: decodeJson(row.watched_paths, [])
  };
}

export async function getTaskForWorkItem(workItemId) {
  await ensureFilesystem();
  return openDb().prepare("SELECT * FROM tasks WHERE id = (SELECT task_id FROM work_items WHERE id = ?)").get(workItemId) ?? null;
}

export async function isFactRevoked(factId) {
  await ensureFilesystem();
  return Boolean(openDb().prepare("SELECT 1 FROM facts WHERE supersedes_id = ? AND state = 'revoked'").get(factId));
}

export async function getFactEffectiveState(factId) {
  await ensureFilesystem();
  const transition = openDb().prepare(`
    SELECT state FROM facts WHERE supersedes_id = ? AND state IN ('revoked', 'expired')
    ORDER BY CASE state WHEN 'revoked' THEN 0 ELSE 1 END, created_at DESC LIMIT 1
  `).get(factId);
  return transition?.state ?? null;
}

export async function promoteCandidateFact({ factId, scopeType = "work_item", watchedPaths = null, expiresAt = null, sourceEventId = null, verifiedBy = "main_thread" }) {
  await ensureFilesystem();
  const source = await getFact(factId);
  if (!source) throw new Error(`fact not found: ${factId}`);
  if (await isFactRevoked(factId)) {
    const error = new Error(`fact ${factId} is already revoked`);
    error.code = "fact_already_revoked";
    throw error;
  }
  if (source.state !== "candidate") {
    const error = new Error(`only candidate facts may be promoted; ${factId} is ${source.state}`);
    error.code = "fact_not_candidate";
    throw error;
  }
  if (!['work_item', 'repo_verified'].includes(scopeType)) throw new Error("promotion scope must be work_item or repo_verified");
  const workItem = openDb().prepare("SELECT * FROM work_items WHERE id = ?").get(source.work_item_id);
  if (!workItem) throw new Error(`work item not found for fact: ${factId}`);
  const sourceTask = await getTaskForWorkItem(workItem.id);
  const paths = watchedPaths ?? source.watched_paths ?? [];
  const repo = openDb().prepare("SELECT canonical_remote FROM repos WHERE id = ?").get(workItem.repo_id);
  const canonicalRemote = repo?.canonical_remote ?? null;
  const normalizedRepoPaths = sourceTask ? repoRelativePaths(sourceTask.project_root, paths) : [];
  if (scopeType === "repo_verified" && paths.length === 0) {
    const error = new Error("repo_verified promotion requires watchedPaths so unrelated work cannot inherit it");
    error.code = "repo_fact_requires_paths";
    throw error;
  }
  if (scopeType === "repo_verified" && !canonicalRemote) {
    const error = new Error("repo_verified promotion requires a canonical origin remote; facts from an unrecognized or missing remote stay work-scoped");
    error.code = "repo_fact_requires_canonical_remote";
    throw error;
  }
  if (scopeType === "repo_verified" && normalizedRepoPaths.length === 0) {
    const error = new Error("repo_verified watchedPaths must stay inside the repository root");
    error.code = "repo_fact_paths_outside_root";
    throw error;
  }
  return recordFact({
    workItemId: source.work_item_id,
    scopeType,
    scopeId: scopeType === "repo_verified" ? canonicalRemote : workItem.id,
    key: source.key,
    value: source.value,
    state: "verified",
    sourceEventId,
    sourceArtifactId: source.source_artifact_id ?? null,
    validForSha: source.valid_for_sha ?? null,
    validForContentHash: source.valid_for_content_hash ?? null,
    validForManifestHash: source.valid_for_manifest_hash ?? null,
    watchedPaths: scopeType === "repo_verified" ? normalizedRepoPaths : paths,
    expiresAt: expiresAt ?? source.expires_at ?? null,
    supersedesId: source.id,
    verifiedBy
  });
}

export async function revokeFact(factId) {
  await ensureFilesystem();
  const source = await getFact(factId);
  if (!source) return null;
  if (!["candidate", "verified"].includes(source.state)) {
    const error = new Error(`only candidate or verified facts may be revoked; ${factId} is ${source.state}`);
    error.code = "fact_not_revocable";
    throw error;
  }
  if (await isFactRevoked(factId)) {
    const error = new Error(`fact ${factId} is already revoked`);
    error.code = "fact_already_revoked";
    throw error;
  }
  return recordFact({
    workItemId: source.work_item_id,
    scopeType: source.scope_type,
    scopeId: source.scope_id,
    key: source.key,
    value: source.value,
    state: "revoked",
    sourceEventId: source.source_event_id,
    sourceArtifactId: source.source_artifact_id,
    validForSha: source.valid_for_sha,
    validForContentHash: source.valid_for_content_hash,
    validForManifestHash: source.valid_for_manifest_hash,
    watchedPaths: source.watched_paths,
    expiresAt: source.expires_at,
    supersedesId: source.id,
    verifiedBy: "main_thread"
  });
}
