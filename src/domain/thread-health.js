const DEFAULT_HANDOFF_TOKEN_THRESHOLD = 300000;
const LONG_THREAD_RATIO = 0.75;

export function handoffTokenThreshold(env = process.env) {
  const raw = env.CODEX_SUPERVISOR_HANDOFF_TOKEN_THRESHOLD;
  if (raw == null || raw === "") return DEFAULT_HANDOFF_TOKEN_THRESHOLD;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_HANDOFF_TOKEN_THRESHOLD;
  return value;
}

export function threadHealth(task, { threshold = handoffTokenThreshold() } = {}) {
  if (threshold === 0) return { state: "disabled", threshold: 0, tokens_used: task?.goal_tokens_used ?? 0, next_step: null };
  const tokens = Number(task?.goal_tokens_used ?? 0);
  if (!Number.isFinite(tokens) || tokens <= 0) return { state: "ok", threshold, tokens_used: 0, next_step: null };
  if (tokens >= threshold) {
    return {
      state: "handoff_recommended",
      threshold,
      tokens_used: tokens,
      next_step: "Start a fresh 1000-1500-token handoff with create_codex_followup_worker; keep this thread as evidence"
    };
  }
  if (tokens >= Math.floor(threshold * LONG_THREAD_RATIO)) {
    return {
      state: "getting_long",
      threshold,
      tokens_used: tokens,
      next_step: "Finish this bounded step, then create a follow-up worker instead of extending the thread"
    };
  }
  return { state: "ok", threshold, tokens_used: tokens, next_step: null };
}
