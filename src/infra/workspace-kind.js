import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { lstat, mkdir, readdir, readlink, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, relative, resolve } from "node:path";
import { scratchDir } from "./paths.js";

export const WORKSPACE_KINDS = ["git_worktree", "read_only_in_place", "scratch", "in_place_write"];
const MAX_MANIFEST_ENTRIES = 20000;

function workspaceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isInside(root, path) {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !rel.includes(`..${process.platform === "win32" ? "\\" : "/"}`));
}

export function isGitCheckout(cwd) {
  try {
    return execFileSync(process.env.GIT_BIN?.trim() || "git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15000
    }).trim() === "true";
  } catch {
    return false;
  }
}

function selectedKind({ sourceRoot, workspaceKind, sandbox }) {
  if (workspaceKind != null && !WORKSPACE_KINDS.includes(workspaceKind)) {
    throw workspaceError("invalid_workspace_kind", `workspaceKind must be one of ${WORKSPACE_KINDS.join(", ")}`);
  }
  if (workspaceKind) return workspaceKind;
  if (isGitCheckout(sourceRoot)) return "git_worktree";
  if (sandbox === "read-only") return "read_only_in_place";
  throw workspaceError("workspace_kind_required", "a non-Git worker that can write must declare workspaceKind: scratch or in_place_write; the supervisor never writes a user directory by default");
}

function validateKind({ kind, sourceRoot, sandbox, ownedPaths, networkAccess, acceptance, externalOutputs, inPlaceAuthorization, isPreflight }) {
  if (kind === "git_worktree") {
    if (!isGitCheckout(sourceRoot)) throw workspaceError("git_worktree_requires_git", "workspaceKind git_worktree requires a Git checkout with a resolvable commit; use read_only_in_place, scratch or explicitly authorized in_place_write for a non-Git directory");
    return;
  }
  if (kind === "read_only_in_place") {
    if (sandbox !== "read-only" || ownedPaths.length !== 0 || networkAccess) {
      throw workspaceError("invalid_read_only_workspace", "read_only_in_place requires sandbox read-only, ownedPaths: [] and networkAccess: false");
    }
    if (externalOutputs.length) throw workspaceError("invalid_read_only_workspace", "read_only_in_place cannot declare externalOutputs");
    return;
  }
  if (kind === "scratch") {
    if (sandbox !== "workspace-write" || ownedPaths.length !== 0) {
      throw workspaceError("invalid_scratch_workspace", "scratch requires sandbox workspace-write and ownedPaths: []; it never lands project changes");
    }
    if (externalOutputs.length) throw workspaceError("invalid_scratch_workspace", "scratch cannot write externalOutputs; keep generated material inside the supervisor scratch directory");
    return;
  }
  if (isGitCheckout(sourceRoot)) {
    throw workspaceError("in_place_write_requires_non_git", "in_place_write is only for an explicitly authorized non-Git directory; use git_worktree for a Git checkout");
  }
  if (sandbox !== "workspace-write" || ownedPaths.length === 0 || !String(inPlaceAuthorization ?? "").trim()) {
    throw workspaceError("invalid_in_place_workspace", "in_place_write requires sandbox workspace-write, nonempty ownedPaths and an explicit inPlaceAuthorization");
  }
  if (!isPreflight && (!Array.isArray(acceptance) || acceptance.length === 0)) {
    throw workspaceError("in_place_acceptance_required", "in_place_write requires explicit acceptance; file changes in a user directory cannot be accepted by worker exit status alone");
  }
  for (const path of ownedPaths) {
    if (!isInside(sourceRoot, resolve(sourceRoot, path))) {
      throw workspaceError("in_place_path_outside_root", `in_place_write ownedPath escapes the authorized source root: ${path}`);
    }
  }
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function manifestEntry(root, absolute, entries) {
  if (entries.length >= MAX_MANIFEST_ENTRIES) {
    throw workspaceError("workspace_manifest_too_large", `workspace manifest exceeds ${MAX_MANIFEST_ENTRIES} entries; narrow the declared in-place paths before dispatching`);
  }
  const path = relative(root, absolute) || ".";
  let info;
  try {
    info = await lstat(absolute);
  } catch (error) {
    if (error.code === "ENOENT") {
      entries.push({ path, type: "missing" });
      return;
    }
    throw error;
  }
  if (info.isFile()) {
    entries.push({ path, type: "file", bytes: info.size, sha256: await sha256File(absolute) });
    return;
  }
  if (info.isSymbolicLink()) {
    entries.push({ path, type: "symlink", target: await readlink(absolute) });
    return;
  }
  if (info.isDirectory()) {
    entries.push({ path, type: "directory" });
    const children = await readdir(absolute);
    for (const child of children.sort((left, right) => left.localeCompare(right))) {
      await manifestEntry(root, join(absolute, child), entries);
    }
    return;
  }
  entries.push({ path, type: "other" });
}

export async function captureWorkspaceManifest(sourceRoot, paths) {
  const root = resolve(sourceRoot);
  const entries = [];
  for (const path of [...new Set(paths.map((path) => resolve(root, path)))].sort((left, right) => left.localeCompare(right))) {
    await manifestEntry(root, path, entries);
  }
  const canonical = JSON.stringify(entries);
  return {
    algorithm: "sha256",
    root,
    paths: paths.map((path) => resolve(root, path)),
    entry_count: entries.length,
    sha256: createHash("sha256").update(canonical).digest("hex"),
    entries
  };
}

export async function prepareWorkspace({ cwd, workspaceKind = null, sandbox, ownedPaths, networkAccess, acceptance, externalOutputs = [], inPlaceAuthorization = null, taskId, isPreflight = false }) {
  const sourceRoot = resolve(cwd);
  if (!existsSync(sourceRoot)) throw workspaceError("workspace_source_missing", `workspace source directory does not exist: ${sourceRoot}`);
  const kind = selectedKind({ sourceRoot, workspaceKind, sandbox });
  validateKind({ kind, sourceRoot, sandbox, ownedPaths, networkAccess, acceptance, externalOutputs, inPlaceAuthorization, isPreflight });
  if (kind !== "scratch") {
    const manifestPaths = kind === "in_place_write" ? ownedPaths : [];
    return {
      kind,
      sourceRoot,
      executionCwd: sourceRoot,
      manifestPaths,
      beforeManifest: manifestPaths.length ? await captureWorkspaceManifest(sourceRoot, manifestPaths) : null,
      landable: kind === "git_worktree",
      cleanable: kind === "git_worktree"
    };
  }
  const executionCwd = join(scratchDir, taskId);
  await mkdir(scratchDir, { recursive: true });
  await rm(executionCwd, { recursive: true, force: true });
  await mkdir(executionCwd, { recursive: true });
  return {
    kind,
    sourceRoot,
    executionCwd,
    manifestPaths: [],
    beforeManifest: null,
    landable: false,
    cleanable: false,
    scratchPath: executionCwd
  };
}
