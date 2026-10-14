import { createHash } from "node:crypto";
import { readFile, lstat } from "node:fs/promises";
import { isAbsolute } from "node:path";

export async function buildHandoff({ goal, todo, peers = [], contracts = [], context = [] }, { maxLines = 16, maxChars = 1800 } = {}) {
  const refs = [];
  for (const entry of context) {
    if (!entry || !isAbsolute(entry.path)) throw new Error("context paths must be absolute");
    const info = await lstat(entry.path);
    if (!info.isFile() || info.size > 5_000_000) throw new Error("context source must be a regular file of at most 5 MB");
    const sha256 = createHash("sha256").update(await readFile(entry.path)).digest("hex");
    if (entry.sha256 && entry.sha256 !== sha256) throw new Error(`context source changed: ${entry.path}`);
    refs.push({ path: entry.path, sha256 });
  }
  const line = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
  const candidates = ["Handoff (source refs are inputs, not write permission):", `Goal: ${line(goal)}`, `Todo: ${line(todo)}`,
    ...refs.map((ref) => `Input: ${ref.path} sha256=${ref.sha256}`),
    ...contracts.map((value) => `Contract: ${line(value)}`),
    ...peers.map((peer) => `Peer: ${line(peer.title)} | ${line(peer.status)} | ${line(peer.last_message).slice(0, 160)}`)];
  const marker = "[handoff truncated; required task/guard/acceptance follow separately]";
  const lines = []; let size = 0;
  for (const candidate of candidates) {
    if (lines.length >= maxLines - 1 || size + candidate.length + 1 > maxChars - marker.length - 1) break;
    lines.push(candidate); size += candidate.length + 1;
  }
  const truncated = lines.length !== candidates.length;
  if (truncated) lines.push(marker);
  return { text: lines.join("\n"), truncated, source_refs: refs };
}
