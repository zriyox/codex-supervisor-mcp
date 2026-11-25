import { isGoalNeedingAttention } from "./status.js";

function providerFailure(text) {
  if (!/provider|upstream_status|upstream status|cc switch|responses endpoint/i.test(text)) return null;
  const status = Number(text.match(/(?:upstream_status|upstream status|unexpected status|HTTP)\D{0,8}(\d{3})/i)?.[1] ?? 0);
  const retryable = status === 429 || status >= 500 || /timeout|temporar|rate.?limit/i.test(text);
  return { source: "provider", code: status ? `provider_http_${status}` : "provider_error", retryable };
}

// "codex exited with code 1" says only that the process ended badly. The
// reason is whatever it last wrote to stderr, so that is read for the causes a
// caller acts on differently: fix the login, wait for the provider, fix the
// configuration. The last line is passed on either way.
const lastLine = (text) => text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1)?.slice(0, 300) ?? null;

function processExitFailure(stderr) {
  const detail = lastLine(stderr);
  const withDetail = (failure) => (detail ? { ...failure, detail } : failure);
  if (/\b401\b|unauthori[sz]ed|not logged in|login required|invalid api key|missing api key|\b403\b|forbidden/i.test(stderr)) {
    return withDetail({ source: "auth", code: "auth_failed", retryable: false });
  }
  const provider = providerFailure(stderr);
  if (provider) return withDetail(provider);
  if (/\b429\b|rate.?limit|too many requests/i.test(stderr)) return withDetail({ source: "provider", code: "provider_rate_limited", retryable: true });
  if (/ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|error sending request|connection (refused|reset|closed)|stream disconnected|dns error/i.test(stderr)) {
    return withDetail({ source: "provider", code: "provider_unreachable", retryable: true });
  }
  if (/config\.toml|unknown model|model .{0,80}(not found|does not exist|not supported)|unexpected argument|invalid value/i.test(stderr)) {
    return withDetail({ source: "runner_config", code: "config_invalid", retryable: false });
  }
  return withDetail({ source: "worker_process", code: "process_exit_nonzero", retryable: true });
}

export function classifyFailure(task) {
  if (!task) return null;
  const error = String(task.error ?? "");
  const attention = String(task.attention_reason ?? "");

  const provider = providerFailure(error);
  if (provider) return provider;
  if (/did not record the process exit/i.test(error)) return { source: "supervisor_process", code: "exit_unrecorded", retryable: true };
  if (attention === "start_failed") return { source: "supervisor_process", code: "start_failed", retryable: true };
  if (/^workspace\.setup command failed:/i.test(error)) return { source: "workspace_setup", code: "setup_command_failed", retryable: true };
  if (/^workspace\.setup link /i.test(error)) return { source: "workspace_setup", code: "setup_link_failed", retryable: true };
  if (attention === "invalid_report" || /Invalid final worker report/i.test(error)) return { source: "model_output", code: "invalid_report", retryable: true };
  if (task.acceptance_results?.passed === false) return { source: "acceptance", code: "acceptance_failed", retryable: true };
  if (attention === "no_work" || attention === "two_stall") return { source: "worker_progress", code: attention, retryable: false };
  if (task.status === "timed_out" || attention === "run_time_limit" || attention === "total_time_limit") {
    return { source: "time_limit", code: attention || "time_limit", retryable: false };
  }
  if (task.status === "lost") return { source: "supervisor_process", code: "worker_lost", retryable: true };
  if (task.status === "cancelled") return { source: "caller", code: "cancelled", retryable: true };
  if (/codex exited with code/i.test(error)) return processExitFailure(String(task.stderr_tail ?? ""));
  if (isGoalNeedingAttention(task.goal_status)) return { source: "goal", code: `goal_${task.goal_status}`, retryable: false };
  if (task.status === "failed") return { source: "unknown", code: "failed", retryable: null };
  return null;
}
