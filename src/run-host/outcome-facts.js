// A finished run's report becomes a candidate fact; acceptance passing turns
// it into the work item's verified outcome.
import { appendTaskEvent } from "../infra/store/events.js";
import { getWorkItemForTask, recordFact } from "../infra/store/facts.js";
import { updateWorkItemDelivery } from "../infra/store/records.js";

async function recordOutcomeFacts({ task, runId, report, reportEventId = null, acceptanceEventId = null, acceptancePassed = false }) {
  if (!report?.valid) return;
  const workItem = await getWorkItemForTask(task.id);
  if (!workItem) return;
  const validForManifestHash = task.run_evidence?.workspace?.after_manifest?.sha256 ?? null;
  const candidate = await recordFact({
    workItemId: workItem.id,
    scopeType: "run",
    scopeId: runId,
    key: "worker_outcome",
    value: report.report,
    state: "candidate",
    sourceEventId: reportEventId,
    validForSha: task.base_commit ?? null,
    validForContentHash: task.input_context?.content_hash ?? null,
    validForManifestHash,
    watchedPaths: task.owned_paths ?? []
  });
  if (!acceptancePassed || report.format === "text") return;
  await recordFact({
    workItemId: workItem.id,
    scopeType: "work_item",
    scopeId: workItem.id,
    key: "accepted_outcome",
    value: report.report,
    state: "verified",
    sourceEventId: acceptanceEventId,
    validForSha: task.base_commit ?? null,
    validForContentHash: task.input_context?.content_hash ?? null,
    validForManifestHash,
    watchedPaths: task.owned_paths ?? [],
    supersedesId: candidate.id,
    verifiedBy: "supervisor.acceptance"
  });
  await updateWorkItemDelivery(task.id, "verified");
}

// Fact projection is secondary evidence: a failure is recorded and reported,
// and never turns completed work into lost work.
export async function projectOutcomeFacts(run, finalRecord, { acceptanceEventId = null, acceptancePassed = false } = {}) {
  try {
    await recordOutcomeFacts({
      task: finalRecord,
      runId: run.runId,
      report: finalRecord.run_evidence?.structured_report,
      reportEventId: run.rawReportEventId,
      acceptanceEventId,
      acceptancePassed
    });
  } catch (error) {
    await appendTaskEvent(finalRecord.id, { type: "supervisor.fact_record_failed", error: error.message, run: run.live.run_count },
      { runId: run.runId, actor: "supervisor" }).catch(() => null);
    process.stderr.write(`[agent-supervisor] fact projection failed for ${finalRecord.id}: ${error.message}\n`);
  }
}
