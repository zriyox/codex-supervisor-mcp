import { createHash, randomUUID } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import { ACTIVE_STATUSES } from "./status.js";
import { worktreesDir } from "./paths.js";
import { readTasks } from "./task-store.js";

export const CLEANUP_PLAN_TTL_MS = 15 * 60 * 1000;

function git(cwd, args) {
  return execFileSync(process.env.GIT_BIN?.trim() || "git", ["--no-optional-locks", "-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 15000,
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function directoryBytes(path) {
  try {
    const output = execFileSync("du", ["-sk", path], { encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    const kib = Number(output.split(/\s+/)[0]);
    return Number.isFinite(kib) ? kib * 1024 : 0;
  } catch {
    return 0;
  }
}

async function taskVerdict(task, tasks) {
  if (task.status !== "completed") return { verdict: "blocked", reasons: ["worker is unfinished, failed, cancelled or lost"] };
  if (task.acceptance_results && task.acceptance_results.passed !== true) return { verdict: "blocked", reasons: ["acceptance is not passed"] };
  if (tasks.some((other) => ACTIVE_STATUSES.has(other.status) && (other.depends_on ?? []).includes(task.id))) return { verdict: "blocked", reasons: ["an active dependent still needs this work"] };
  if (!task.worktree_path || !task.project_root) return { verdict: "review", reasons: ["no registered isolated worktree"] };
  if (!task.landed_at || !task.landed_head) return { verdict: "blocked", reasons: ["work has not been landed"] };
  if (!task.push_verified_at) return { verdict: "blocked", reasons: ["remote delivery has not been verified"] };
  try {
    const path = resolve(task.worktree_path);
    if (path !== resolve(worktreesDir, task.id)) return { verdict: "review", reasons: ["worktree is outside its managed task directory"] };
    const info = await lstat(path);
    if (info.isSymbolicLink()) return { verdict: "review", reasons: ["worktree is a symlink"] };
    if (await realpath(path) !== await realpath(resolve(worktreesDir, task.id))) return { verdict: "review", reasons: ["worktree realpath is unexpected"] };
    const branch = git(path, ["symbolic-ref", "--short", "HEAD"]);
    if (branch !== `codex/${task.id}`) return { verdict: "review", reasons: ["worktree branch ownership is unexpected"] };
    const registrations = git(task.project_root, ["worktree", "list", "--porcelain", "-z"]).split("\0").filter((line) => line.startsWith("worktree "));
    let registered = false;
    for (const line of registrations) if (await realpath(line.slice(9)) === await realpath(path)) registered = true;
    if (!registered) return { verdict: "review", reasons: ["git worktree registration is missing"] };
    if (git(path, ["status", "--porcelain", "--untracked-files=all"])) return { verdict: "blocked", reasons: ["worktree has uncommitted or untracked files"] };
    if (git(path, ["ls-files", "--others", "--ignored", "--exclude-standard"])) return { verdict: "blocked", reasons: ["worktree has ignored artifacts"] };
    if (task.attention_reason) return { verdict: "blocked", reasons: [`unresolved attention: ${task.attention_reason}`] };
    if (task.run_evidence?.external_outputs?.length) return { verdict: "blocked", reasons: ["shared output evidence is retained"] };
    return {
      verdict: "safe",
      reasons: ["acceptance passed", "landed", "remote delivery verified", "worktree clean", "no active dependent"],
      fingerprint: hash(JSON.stringify({ path, branch, head: git(path, ["rev-parse", "HEAD"]), landed: task.landed_head, push: task.push_verified_at }))
    };
  } catch (error) {
    return { verdict: "review", reasons: [`cleanup proof failed: ${error.message.split("\n")[0]}`] };
  }
}

export async function createCleanupPlan({ taskIds = null, projectRoot = null, now = Date.now() } = {}) {
  const tasks = await readTasks();
  const selected = tasks.filter((task) => (!taskIds || taskIds.includes(task.id)) && (!projectRoot || resolve(task.project_root) === resolve(projectRoot)));
  const items = [];
  for (const task of selected) {
    const result = await taskVerdict(task, tasks);
    const bytes = result.verdict === "safe" ? await directoryBytes(task.worktree_path) : 0;
    items.push({ task_id: task.id, verdict: result.verdict, reasons: result.reasons, fingerprint: result.fingerprint ?? null, reclaimable_bytes: bytes, eligible_after: result.verdict === "safe" ? new Date(now).toISOString() : null });
  }
  const summary = {
    safe: items.filter((item) => item.verdict === "safe").length,
    review: items.filter((item) => item.verdict === "review").length,
    blocked: items.filter((item) => item.verdict === "blocked").length,
    reclaimable_bytes: items.reduce((sum, item) => sum + item.reclaimable_bytes, 0)
  };
  return {
    id: randomUUID(),
    project_root: projectRoot ? resolve(projectRoot) : null,
    generated_at: new Date(now).toISOString(),
    expires_at: new Date(now + CLEANUP_PLAN_TTL_MS).toISOString(),
    policy: "explicit_apply_keep_evidence_and_branch",
    summary,
    items
  };
}

export async function removePlannedWorktree(task, fingerprint) {
  const result = await taskVerdict(task, await readTasks());
  if (result.verdict !== "safe") throw new Error(`worktree is no longer safe: ${result.reasons.join("; ")}`);
  if (result.fingerprint !== fingerprint) throw new Error("worktree changed since cleanup plan; create a new plan");
  git(task.project_root, ["worktree", "remove", task.worktree_path]);
  try { git(task.project_root, ["worktree", "prune"]); } catch { /* best effort */ }
}
