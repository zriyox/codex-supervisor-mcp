import { artifactsDir } from "../paths.js";
import { decodeJson, ensureFilesystem, openDb } from "./db.js";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export async function recordJsonArtifact({ runId, type, value, securityClass = "internal", retention = "permanent" }) {
  await ensureFilesystem();
  if (!runId || !type) throw new Error("artifact requires runId and type");
  const id = randomUUID();
  const content = JSON.stringify(value, null, 2);
  const sha256 = createHash("sha256").update(content).digest("hex");
  const path = join(artifactsDir, `${id}.json`);
  await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
  const now = new Date().toISOString();
  openDb().prepare(`
    INSERT INTO artifacts (id, run_id, type, uri, sha256, security_class, retention, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, runId, type, path, sha256, securityClass, retention, now);
  return { id, run_id: runId, type, uri: path, sha256, security_class: securityClass, retention, created_at: now };
}

export async function getArtifact(artifactId) {
  await ensureFilesystem();
  return openDb().prepare("SELECT * FROM artifacts WHERE id = ?").get(artifactId) ?? null;
}

export async function readArtifact(artifactId, maxChars = 12000) {
  const artifact = await getArtifact(artifactId);
  if (!artifact) return null;
  const artifactPath = relative(artifactsDir, resolve(artifact.uri));
  if (!artifactPath || artifactPath === ".." || artifactPath.startsWith(`..${sep}`) || isAbsolute(artifactPath)) {
    return { ...artifact, content: null, reason: "artifact_uri_not_managed" };
  }
  let content;
  try {
    content = await readFile(artifact.uri, "utf8");
  } catch (error) {
    return { ...artifact, content: null, reason: `artifact_unreadable: ${error.code ?? error.message}` };
  }
  const truncated = content.length > maxChars;
  return { ...artifact, content: truncated ? `${content.slice(0, maxChars)}…` : content, truncated };
}

export async function listArtifactsForTask(taskId, limit = 50) {
  await ensureFilesystem();
  return openDb().prepare(`
    SELECT a.* FROM artifacts a JOIN runs r ON r.id = a.run_id
    WHERE r.task_id = ? ORDER BY a.created_at DESC LIMIT ?
  `).all(taskId, limit);
}

export async function createReviewAssignment({ subjectTaskId, verifierTaskId, subjectRunId = null, subjectBaseSha = null, subjectFingerprint = null }) {
  await ensureFilesystem();
  const now = new Date().toISOString();
  const id = randomUUID();
  openDb().prepare(`
    INSERT INTO review_findings (id, subject_task_id, verifier_task_id, subject_run_id, subject_base_sha, subject_fingerprint, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(id, subjectTaskId, verifierTaskId, subjectRunId, subjectBaseSha, subjectFingerprint, now, now);
  return { id, subject_task_id: subjectTaskId, verifier_task_id: verifierTaskId, subject_run_id: subjectRunId, subject_base_sha: subjectBaseSha, subject_fingerprint: subjectFingerprint, status: "pending", created_at: now, updated_at: now };
}

export async function getReviewByVerifierTask(verifierTaskId) {
  await ensureFilesystem();
  return openDb().prepare("SELECT * FROM review_findings WHERE verifier_task_id = ?").get(verifierTaskId) ?? null;
}

export async function recordReviewFinding({ verifierTaskId, verdict, reason, evidenceArtifactId = null, findingEventId = null }) {
  await ensureFilesystem();
  if (!['passes', 'fails', 'inconclusive'].includes(verdict)) throw new Error("review verdict must be passes, fails or inconclusive");
  const now = new Date().toISOString();
  const result = openDb().prepare(`
    UPDATE review_findings
    SET status = 'recorded', verdict = ?, reason = ?, evidence_artifact_id = ?, finding_event_id = ?, updated_at = ?
    WHERE verifier_task_id = ? AND status = 'pending'
  `).run(verdict, reason, evidenceArtifactId, findingEventId, now, verifierTaskId);
  if (result.changes === 0) return null;
  return getReviewByVerifierTask(verifierTaskId);
}

export async function resolveReviewFinding({ verifierTaskId, resolution, resolvedBy = 'main_thread' }) {
  await ensureFilesystem();
  const now = new Date().toISOString();
  const result = openDb().prepare(`
    UPDATE review_findings
    SET status = 'resolved', resolution = ?, resolved_at = ?, resolved_by = ?, updated_at = ?
    WHERE verifier_task_id = ? AND status = 'recorded'
  `).run(resolution, now, resolvedBy, now, verifierTaskId);
  if (result.changes === 0) return null;
  return getReviewByVerifierTask(verifierTaskId);
}

export async function updateWorkItemDelivery(taskId, deliveryState) {
  await ensureFilesystem();
  if (!["draft", "verified", "landed", "push_verified", "cleanup_eligible", "cleanup_removed", "needs_attention"].includes(deliveryState)) {
    throw new Error("invalid delivery state");
  }
  const result = openDb().prepare("UPDATE work_items SET delivery_state = ?, updated_at = ? WHERE task_id = ?")
    .run(deliveryState, new Date().toISOString(), taskId);
  return result.changes > 0;
}

export async function saveCleanupPlan(plan) {
  await ensureFilesystem();
  const dbInstance = openDb();
  dbInstance.exec("BEGIN IMMEDIATE");
  try {
    dbInstance.prepare(`
      INSERT INTO cleanup_plans (id, project_root, generated_at, expires_at, policy, summary_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(plan.id, plan.project_root, plan.generated_at, plan.expires_at, plan.policy, JSON.stringify(plan.summary));
    const insert = dbInstance.prepare(`
      INSERT INTO cleanup_plan_items (id, plan_id, task_id, verdict, reasons_json, fingerprint, reclaimable_bytes, eligible_after, applied_at, applied_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
    `);
    for (const item of plan.items) {
      item.id = item.id ?? randomUUID();
      insert.run(item.id, plan.id, item.task_id, item.verdict, JSON.stringify(item.reasons), item.fingerprint, item.reclaimable_bytes, item.eligible_after);
      if (item.verdict === "safe") {
        dbInstance.prepare("UPDATE work_items SET delivery_state = 'cleanup_eligible', updated_at = ? WHERE task_id = ? AND delivery_state = 'push_verified'")
          .run(new Date().toISOString(), item.task_id);
      } else {
        dbInstance.prepare("UPDATE work_items SET delivery_state = 'push_verified', updated_at = ? WHERE task_id = ? AND delivery_state = 'cleanup_eligible'")
          .run(new Date().toISOString(), item.task_id);
      }
    }
    dbInstance.exec("COMMIT");
  } catch (error) {
    dbInstance.exec("ROLLBACK");
    throw error;
  }
}

export async function getCleanupPlan(planId) {
  await ensureFilesystem();
  const plan = openDb().prepare("SELECT * FROM cleanup_plans WHERE id = ?").get(planId);
  if (!plan) return null;
  const items = openDb().prepare("SELECT * FROM cleanup_plan_items WHERE plan_id = ? ORDER BY task_id").all(planId).map((item) => ({
    ...item,
    reasons: decodeJson(item.reasons_json, [])
  }));
  return { ...plan, summary: decodeJson(plan.summary_json, {}), items };
}

export async function markCleanupPlanItemApplied(itemId, actor = "main_thread") {
  await ensureFilesystem();
  const now = new Date().toISOString();
  openDb().prepare("UPDATE cleanup_plan_items SET applied_at = ?, applied_by = ? WHERE id = ? AND applied_at IS NULL")
    .run(now, actor, itemId);
  return now;
}

export async function readCleanupHistory(taskId = null, limit = 100) {
  await ensureFilesystem();
  const rows = taskId
    ? openDb().prepare(`SELECT i.*, p.generated_at, p.expires_at, p.policy FROM cleanup_plan_items i JOIN cleanup_plans p ON p.id = i.plan_id WHERE i.task_id = ? ORDER BY p.generated_at DESC LIMIT ?`).all(taskId, limit)
    : openDb().prepare(`SELECT i.*, p.generated_at, p.expires_at, p.policy FROM cleanup_plan_items i JOIN cleanup_plans p ON p.id = i.plan_id ORDER BY p.generated_at DESC LIMIT ?`).all(limit);
  return rows.map((row) => ({ ...row, reasons: decodeJson(row.reasons_json, []) }));
}
