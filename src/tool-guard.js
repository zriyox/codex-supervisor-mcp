#!/usr/bin/env node
import { realpathSync, existsSync } from "node:fs";
import { resolve, dirname, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

function canonical(path) {
  const suffix = [];
  let parent = resolve(path);
  while (!existsSync(parent)) {
    const next = dirname(parent);
    if (next === parent) throw new Error("path has no existing ancestor");
    suffix.unshift(relative(next, parent)); parent = next;
  }
  return resolve(realpathSync(parent), ...suffix);
}

function inside(path, owner) {
  const part = relative(owner, path);
  return !isAbsolute(part) && part !== ".." && !part.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
}

export function evaluateToolUse(event, policy) {
  const deny = (reason) => ({ allow: false, reason });
  if (!policy || !Array.isArray(policy.ownedPaths) || !policy.cwd) return deny("missing supervisor guard policy");
  // Who needs the shell allowlist? It exists to stop a writing worker from
  // going around ownedPaths. Two shapes have no landable write boundary left:
  // the read-only sandbox denies every file write, temp directory included, and
  // a workspace-write worker with no ownedPaths can only write its own
  // throwaway worktree, its temp dir and the OS cache dir while land refuses
  // everything it produced. Both are what a research worker looks like, and
  // the allowlist would only stop it from running curl, gh or python.
  // danger-full-access keeps the allowlist: there the sandbox is gone.
  const landsNothing = policy.sandbox === "read-only"
    || (policy.sandbox === "workspace-write" && policy.ownedPaths.length === 0);
  const readOnly = policy.sandbox === "read-only";
  const tool = event.tool_name;
  const input = event.tool_input;
  const command = typeof input === "string" ? input : input?.command;
  if (tool === "Bash") {
    if (typeof command !== "string") return deny("invalid shell input");
    const normalized = command.replace(/\\\r?\n/g, "").replace(/\s+/g, " ").trim();
    for (const forbidden of policy.forbid ?? []) {
      if (normalized.toLowerCase().includes(forbidden.toLowerCase())) return deny(`forbidden command: ${forbidden}`);
    }
    // Reading is never exclusive: no branch below looks at another worker's
    // ownedPaths, so two workers may read the same file at the same time.
    if (landsNothing) return { allow: true, reason: readOnly
      ? "read-only sandbox: every write is denied by the OS, so shell commands need no allowlist"
      : "no landable path: writes stay in this worker's own worktree" };
    // Validation lines are a dispatcher's explicit executable contract, just
    // like acceptance. They can have side effects and are never inferred from
    // the model's own report. Arbitrary shell programs are not path sandboxes.
    if ((policy.allowedCommands ?? []).some((entry) => entry.trim() === command.trim())) return { allow: true, reason: "declared validation command" };
    if (!/[;&|<>`$()\n\r]/.test(command) && !/--(?:pre|ext-diff|output|exec)(?:=|\s|$)/.test(command)
      && /^(?:pwd|ls|cat|head|tail|rg|wc|git (?:status|diff|show|log|rev-parse))(?:\s|$)/.test(command.trim())) return { allow: true, reason: "read command" };
    return deny("undeclared shell command; use apply_patch for edits or a declared validation command");
  }
  if (tool === "apply_patch") {
    if (typeof command !== "string" || !command.startsWith("*** Begin Patch")) return deny("invalid patch input");
    const paths = [...command.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)].map((match) => match[1]);
    if (!paths.length) return deny("patch has no recognized file paths");
    if (readOnly) return deny("read-only worker: the sandbox denies every write, including the temp directory; report the change instead of editing");
    try {
      // With no ownedPaths the worker may still keep scratch notes, but only
      // inside its own worktree, which is never landed.
      const owners = policy.ownedPaths.length ? policy.ownedPaths.map(canonical) : [canonical(policy.worktree ?? policy.cwd)];
      for (const path of paths) {
        const target = canonical(resolve(event.cwd ?? policy.cwd, path));
        if (!owners.some((owner) => inside(target, owner))) return deny(policy.ownedPaths.length
          ? `outside ownedPaths: ${path}`
          : `outside this worker's own worktree: ${path}`);
      }
    } catch (error) { return deny(`cannot prove patch ownership: ${error.message}`); }
    return { allow: true, reason: policy.ownedPaths.length ? "owned patch" : "scratch patch in the worker's own worktree" };
  }
  return { allow: true, reason: "tool is outside the Bash/apply_patch policy" };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  let decision;
  try { decision = evaluateToolUse(JSON.parse(input), JSON.parse(process.env.CODEX_SUPERVISOR_GUARD_POLICY ?? "null")); }
  catch (error) { decision = { allow: false, reason: `invalid supervisor guard input: ${error.message}` }; }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse",
    permissionDecision: decision.allow ? "allow" : "deny", permissionDecisionReason: decision.reason } }) + "\n");
}
