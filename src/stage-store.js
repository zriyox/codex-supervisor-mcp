import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stagesDir } from "./paths.js";

function validate(taskId, stage, detail) {
  if (!/^codex-[A-Za-z0-9-]+$/.test(String(taskId ?? ""))) throw new Error("invalid task id for stage checkpoint");
  const name = String(stage ?? "").trim();
  if (!name || name.length > 200) throw new Error("stage must be 1-200 characters");
  const note = detail == null ? null : String(detail).trim();
  if (note && note.length > 1000) throw new Error("stage detail must be at most 1000 characters");
  return { name, note };
}

export function stagePath(taskId) {
  validate(taskId, "stage", null);
  return join(stagesDir, `${taskId}.json`);
}

export function writeStage(taskId, stage, detail = null) {
  const value = validate(taskId, stage, detail);
  mkdirSync(stagesDir, { recursive: true });
  const destination = stagePath(taskId);
  const staging = `${destination}.tmp-${process.pid}-${Date.now()}`;
  const payload = { task_id: taskId, stage: value.name, detail: value.note, updated_at: new Date().toISOString() };
  writeFileSync(staging, JSON.stringify(payload, null, 2));
  renameSync(staging, destination);
  return payload;
}

export function readStage(taskId) {
  let path;
  try { path = stagePath(taskId); } catch { return null; }
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

export function clearStage(taskId) {
  try { rmSync(stagePath(taskId), { force: true }); } catch { /* invalid legacy task id */ }
}
