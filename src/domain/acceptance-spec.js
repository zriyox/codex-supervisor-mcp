import { isAbsolute } from "node:path";
import { compareFailureBaseline } from "./acceptance-baseline.js";

export const MAX_ACCEPTANCE_COMMANDS = 10;

// One string or a list; blanks dropped; an empty list is "not configured".
export function normalizeAcceptance(value) {
  const list = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const commands = list.filter((entry) => entry != null && entry !== "").map((entry) => {
    if (typeof entry === "string") return entry.trim();
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.command !== "string" || !entry.command.trim()) throw new Error("acceptance requires a command string or structured check");
    if (typeof entry.reportPath !== "string" || !entry.reportPath || isAbsolute(entry.reportPath) || /^[A-Za-z]:|^\\\\/.test(entry.reportPath) || entry.reportPath.split(/[\\/]/).includes("..")) throw new Error("report_path must stay inside the worktree");
    const validation = compareFailureBaseline(entry.baseline, {
      complete: true, identity: entry.baseline?.identity,
      executed: [...new Set([...(entry.baseline?.required ?? []), ...(entry.baseline?.failures ?? []).map((item) => item?.test_id)])],
      skipped: [], failures: entry.baseline?.failures
    });
    // Validation errors concern the contract; diff results concern actual
    // failures, which do not exist at normalization time.
    if (validation.errors.length) throw new Error(`invalid acceptance baseline: ${validation.errors.join("; ")}`);
    return { command: entry.command.trim(), reportPath: entry.reportPath, baseline: structuredClone(entry.baseline) };
  }).filter(Boolean);
  if (commands.length === 0) return null;
  if (commands.length > MAX_ACCEPTANCE_COMMANDS) {
    const error = new Error(`acceptance lists ${commands.length} commands; at most ${MAX_ACCEPTANCE_COMMANDS} are run`);
    error.code = "too_many_acceptance_commands";
    throw error;
  }
  return commands;
}
