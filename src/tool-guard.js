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

const PATCH_PATH = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm;

function patchPaths(patchText) {
  return [...patchText.matchAll(PATCH_PATH)].map((match) => match[1]);
}

// Codex 0.162 runs a patch through the shell tool when the model has no
// separate apply_patch tool: the call arrives as
//
//   apply_patch <<'EOF'
//   *** Begin Patch
//   ...
//   *** End Patch
//   EOF
//
// Without this branch the guard denies it as an undeclared shell command and a
// worker on such a model can never edit a file. Only a quoted heredoc counts:
// an unquoted one would expand $() and backticks inside the body before the
// patch runs. Nothing may follow the closing delimiter, so an "EOF && rm -rf x"
// tail never qualifies.
const PATCH_HEREDOC = /^\s*(?:\S*\/)?apply_patch\s+<<-?\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\1\s*\r?\n([\s\S]*?)\r?\n\2\s*$/;

function patchFromHeredoc(command) {
  const match = command.match(PATCH_HEREDOC);
  if (!match) return null;
  const body = match[3];
  return body.includes("*** Begin Patch") && body.includes("*** End Patch") ? body : null;
}

// The one place a patch's targets are judged, shared by the native tool and the
// shell form so both enforce the same ownership.
function judgePatch(paths, { event, policy, readOnly, deny }) {
  if (readOnly) return deny("read-only worker: the sandbox denies every write, including the temp directory; report the change instead of editing");
  if (!paths.length) return deny("patch has no recognized file paths");
  try {
    // With no ownedPaths the worker may still keep scratch notes, but only
    // inside its own worktree, which is never landed.
    const owners = policy.ownedPaths.length ? policy.ownedPaths.map(canonical) : [canonical(policy.worktree ?? policy.cwd)];
    for (const path of paths) {
      const target = canonical(resolve(event.cwd ?? policy.cwd, path));
      if (!owners.some((owner) => inside(target, owner))) return deny(policy.ownedPaths.length
        ? "outside ownedPaths: " + path
        : "outside this worker's own worktree: " + path);
    }
  } catch (error) { return deny("cannot prove patch ownership: " + error.message); }
  return { allow: true, reason: policy.ownedPaths.length ? "owned patch" : "scratch patch in the worker's own worktree" };
}

// A writing worker may still look around between edits. These are the safe
// reads; anything that can write (sed -i, find -delete/-exec, jq -i, tee,
// redirects) stays out. The guard is not a filesystem sandbox, so a miss only
// costs an unowned file inside the worker's own worktree, which land refuses.
const SIMPLE_READ = /^(?:pwd|ls|cat|head|tail|rg|grep|wc|sort|uniq|cut|tr|file|stat|du|df|date|which|basename|dirname|realpath|jq|sed|find|tree|nl|od|strings|shasum|sha256sum|cksum|awk)(?:\s|$)/;
const VERSION_PROBE = /^(?:go|node|npm|npx|java|javac|mvn|gradle|python3?|pip3?|rustc|cargo|dotnet|php|ruby|deno|bun|tsc|cmake|make|git)\s+(?:-v|--version|version|-h|--help)(?:\s|$)/;
const GIT_READ = /^git\s+(?:status|diff|show|log|rev-parse|rev-list|grep|branch|remote|tag|describe|ls-files|blame|shortlog|cat-file|name-rev|for-each-ref|version|config\s+--get|worktree\s+list)(?:\s|$)/;

// Shell syntax that can chain, redirect or execute. A bare $VAR is allowed:
// an expansion is not re-parsed as syntax, which is what lets awk programs
// such as {print $1} through, while $(...) and ${...} stay out.
const SHELL_SYNTAX = /[;&<>()`\n\r]|\$\(|\$\{/;

function readOnlySegment(segment) {
  const text = segment.trim();
  if (!text) return false;
  if (/(?:^|\s)--(?:pre|ext-diff|output|exec)(?:=|\s|$)/.test(text)) return false;
  if (/^git(?:\s|$)/.test(text)) return GIT_READ.test(text);
  if (/^sed(?:\s|$)/.test(text)) return !/(?:^|\s)-i(?:\s|$)/.test(text);
  if (/^find(?:\s|$)/.test(text)) return !/(?:^|\s)-(?:exec|execdir|ok|okdir|delete|fprint|fprintf|fls)(?:\s|$)/.test(text);
  if (/^jq(?:\s|$)/.test(text)) return !/(?:^|\s)(?:-i|--in-place)(?:\s|$)/.test(text);
  if (/^go(?:\s|$)/.test(text)) return /^go\s+(?:env|version)(?:\s|$)/.test(text);
  return SIMPLE_READ.test(text) || VERSION_PROBE.test(text);
}

// A pipe only reads if every segment reads: "rg x | head" is fine, while
// "cat f | tee out" or "rg x | sh" is not. Any other metacharacter refuses too.
function isReadCommand(command) {
  const text = command.trim();
  if (SHELL_SYNTAX.test(text)) return false;
  return text.split("|").every((segment) => readOnlySegment(segment));
}


export function evaluateToolUse(event, policy) {
  const deny = (reason) => ({ allow: false, reason });
  if (!policy || !Array.isArray(policy.ownedPaths) || !policy.cwd) return deny("missing supervisor guard policy");
  // Who needs the shell allowlist? It exists to stop a writing worker from
  // going around ownedPaths. Two shapes have no landable write boundary left:
  // the read-only sandbox denies every file write, temp directory included, and
  // a workspace-write worker with no ownedPaths can only write its own throwaway
  // worktree, its temp dir and the OS cache dir while land refuses everything it
  // produced. Both are what a research worker looks like, and the allowlist would
  // only stop it from running curl, gh or python.
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
      if (normalized.toLowerCase().includes(forbidden.toLowerCase())) return deny("forbidden command: " + forbidden);
    }
    // The patch is judged before the shapes below: a read-only worker gets a
    // clearer refusal than the OS one, and a no-land worker still cannot patch
    // outside its own worktree.
    const shellPatch = patchFromHeredoc(command);
    if (shellPatch) return judgePatch(patchPaths(shellPatch), { event, policy, readOnly, deny });
    // Reading is never exclusive: no branch below looks at another worker's
    // ownedPaths, so two workers may read the same file at the same time.
    if (landsNothing) return { allow: true, reason: readOnly
      ? "read-only sandbox: every write is denied by the OS, so shell commands need no allowlist"
      : "no landable path: writes stay in this worker's own worktree" };
    // Validation lines are a dispatcher's explicit executable contract, just
    // like acceptance. They can have side effects and are never inferred from the
    // model's own report. Arbitrary shell programs are not path sandboxes.
    if ((policy.allowedCommands ?? []).some((entry) => entry.trim() === command.trim())) return { allow: true, reason: "declared validation command" };
    // A declaration ending in * is a prefix pattern, so a declared
    // "go test ./internal/*" covers "go test ./internal/service -run TestX".
    // Only a single command with no metacharacters: a prefix must not smuggle
    // in a second command behind a semicolon.
    if (!SHELL_SYNTAX.test(command)) {
      const prefixes = (policy.allowedCommands ?? []).map((entry) => entry.trim()).filter((entry) => entry.endsWith("*")).map((entry) => entry.slice(0, -1));
      if (prefixes.some((prefix) => prefix && command.trim().startsWith(prefix))) return { allow: true, reason: "declared command prefix" };
    }
    if (isReadCommand(command)) return { allow: true, reason: "read command" };
    return deny("undeclared shell command; edit with apply_patch (the tool, or apply_patch <<'EOF' ... EOF in the shell) or declare the command");
  }
  if (tool === "apply_patch") {
    if (typeof command !== "string" || !command.startsWith("*** Begin Patch")) return deny("invalid patch input");
    return judgePatch(patchPaths(command), { event, policy, readOnly, deny });
  }
  return { allow: true, reason: "tool is outside the Bash/apply_patch policy" };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  let decision;
  try { decision = evaluateToolUse(JSON.parse(input), JSON.parse(process.env.CODEX_SUPERVISOR_GUARD_POLICY ?? "null")); }
  catch (error) { decision = { allow: false, reason: "invalid supervisor guard input: " + error.message }; }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse",
    permissionDecision: decision.allow ? "allow" : "deny", permissionDecisionReason: decision.reason } }) + "\n");
}

