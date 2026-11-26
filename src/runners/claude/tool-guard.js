#!/usr/bin/env node
// PreToolUse hook for a Claude Code worker. Claude Code has no OS sandbox, so
// this hook is all that confines a worker: a file tool may only write what the
// worker owns, and the shell runs reads and the commands the dispatcher
// declared. A declared command is trusted as written; it is not sandboxed.
import { evaluateToolUse } from "../codex/tool-guard.js";
import { fileURLToPath } from "node:url";

const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

export function evaluateClaudeToolUse(event, policy) {
  const deny = (reason) => ({ allow: false, reason });
  if (!policy || !Array.isArray(policy.ownedPaths) || !policy.cwd) return deny("missing supervisor guard policy");
  const tool = event.tool_name;
  if (FILE_TOOLS.has(tool)) {
    const path = event.tool_input?.file_path ?? event.tool_input?.notebook_path;
    if (typeof path !== "string" || !path) return deny("the edit names no file");
    // Judged exactly as a one-file patch is for a Codex worker.
    return evaluateToolUse({ ...event, tool_name: "apply_patch", tool_input: { command: `*** Begin Patch\n*** Update File: ${path}\n*** End Patch` } }, policy);
  }
  if (tool === "Bash") {
    // The shared rules accept a patch written through the shell and judge it by
    // the sandbox; the override below would hide that this worker is read-only.
    if (policy.sandbox === "read-only" && /\bapply_patch\b/.test(String(event.tool_input?.command ?? ""))) {
      return deny("read-only worker: only read commands run; report the change instead of making it");
    }
    // With an OS sandbox a worker that lands nothing may run anything, since
    // the sandbox stops its writes. Here nothing would, so the allowlist
    // always applies: that is what danger-full-access means to the shared rules.
    const decision = evaluateToolUse(event, { ...policy, sandbox: "danger-full-access" });
    if (decision.allow || !/^undeclared shell command/.test(decision.reason)) return decision;
    return deny(policy.sandbox === "read-only"
      ? "read-only worker: only read commands run; report the change instead of making it"
      : "undeclared shell command; edit files with the Edit or Write tool, or have the dispatcher declare the command in sandbox.allowed_commands");
  }
  // Reading tools and the structured report are not writes.
  return { allow: true, reason: "tool is outside the write policy" };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  let decision;
  try { decision = evaluateClaudeToolUse(JSON.parse(input), JSON.parse(process.env.AGENT_SUPERVISOR_GUARD_POLICY ?? "null")); }
  catch (error) { decision = { allow: false, reason: "invalid supervisor guard input: " + error.message }; }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse",
    permissionDecision: decision.allow ? "allow" : "deny", permissionDecisionReason: decision.reason } }) + "\n");
}
