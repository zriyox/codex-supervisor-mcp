import { isGoalNeedingAttention } from "./status.js";

function providerFailure(text) {
  if (!/provider|upstream_status|upstream status|cc switch|responses endpoint/i.test(text)) return null;
  const status = Number(text.match(/(?:upstream_status|upstream status|unexpected status|HTTP)\D{0,8}(\d{3})/i)?.[1] ?? 0);
  const retryable = status === 429 || status >= 500 || /timeout|temporar|rate.?limit/i.test(text);
  return { source: "provider", code: status ? `provider_http_${status}` : "provider_error", retryable };
}

export function classifyFailure(task) {
  if (!task) return null;
  const error = String(task.error ?? "");
  const attention = String(task.attention_reason ?? "");

  const provider = providerFailure(error);
  if (provider) return provider;
  if (/did not record the process exit/i.test(error)) return { source: "supervisor_process", code: "exit_unrecorded", retryable: true };
  if (attention === "start_failed") return { source: "supervisor_process", code: "start_failed", retryable: true };
  if (/^workspaceSetup command failed:/i.test(error)) return { source: "workspace_setup", code: "setup_command_failed", retryable: true };
  if (/^workspaceSetup link /i.test(error)) return { source: "workspace_setup", code: "setup_link_failed", retryable: true };
  if (attention === "invalid_report" || /Invalid final worker report/i.test(error)) return { source: "model_output", code: "invalid_report", retryable: true };
  if (task.acceptance_results?.passed === false) return { source: "acceptance", code: "acceptance_failed", retryable: true };
  if (attention === "no_work" || attention === "two_stall") return { source: "worker_progress", code: attention, retryable: false };
  if (attention === "time_limit" || attention === "total_time_limit") return { source: "supervisor_process", code: attention, retryable: false };
  if (task.status === "lost") return { source: "supervisor_process", code: "worker_lost", retryable: true };
  if (task.status === "cancelled") return { source: "caller", code: "cancelled", retryable: true };
  if (/codex exited with code/i.test(error)) return { source: "worker_process", code: "process_exit_nonzero", retryable: true };
  if (isGoalNeedingAttention(task.goal_status)) return { source: "goal", code: `goal_${task.goal_status}`, retryable: false };
  if (task.status === "failed") return { source: "unknown", code: "failed", retryable: null };
  return null;
}
