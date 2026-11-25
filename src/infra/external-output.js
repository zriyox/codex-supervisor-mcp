import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, dirname } from "node:path";
import { createHash } from "node:crypto";

export async function captureExternalOutputs(declarations, { checkBaseline = false } = {}) {
  if (!Array.isArray(declarations) || declarations.length > 20) throw new Error("externalOutputs must contain at most 20 files");
  const captured = [];
  for (const entry of declarations) {
    if (!entry || !isAbsolute(entry.path)) throw new Error("externalOutputs must use absolute file paths");
    let info;
    try { info = await lstat(entry.path); } catch (error) { if (error.code !== "ENOENT") throw error; }
    let snapshot = { path: entry.path, exists: false, sha256: null, content: null, truncated: false };
    if (info) {
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1_000_000) throw new Error("external output must be a regular file of at most 1 MB");
      const bytes = await readFile(entry.path);
      snapshot = { ...snapshot, exists: true, canonical_path: await realpath(entry.path), sha256: createHash("sha256").update(bytes).digest("hex"),
        content: bytes.includes(0) ? null : bytes.subarray(0, 3000).toString("utf8"), truncated: bytes.length > 3000 };
    } else { snapshot.canonical_parent = await realpath(dirname(entry.path)); }
    if (checkBaseline && entry.sha256 && snapshot.sha256 !== entry.sha256) throw new Error(`external output baseline changed: ${entry.path}`);
    captured.push(snapshot);
  }
  return captured;
}

export function compareExternalOutputs(before, after) {
  return before.map((old, index) => ({ path: old.path, before: old, after: after[index],
    changed: old.exists !== after[index]?.exists || old.sha256 !== after[index]?.sha256,
    integration: "shared_file_already_written_not_cherry_pick" }));
}
