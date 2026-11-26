// A worker's output is written twice: the raw line to its JSONL log and the
// event to the store. Nearly all of the store's size was the second copy of
// command output. A large event from the worker now keeps only a clipped copy
// in the store, marked with the hash of the full line; the JSONL is the one
// place the full body lives, and it is read back from there on request.
//
// Kept whole whatever their size: the worker's messages and turn events, which
// the state machine and the result readers query, and everything the
// supervisor writes itself, which is in no log.
import { truncateEventStrings } from "../../domain/truncate.js";
import { extractAgentMessage } from "./runner-readers.js";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

export const EVENT_INLINE_BYTES = 2048;
const CLIPPED_STRING_BYTES = 1024;
// The marker is the supervisor's, named so it cannot be taken for a field of the worker's event.
export const CLIP_KEY = "supervisor_clipped";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

function keptWhole(event) {
  if (String(event.type ?? "").startsWith("turn.") || event.type === "thread.started") return true;
  try {
    return extractAgentMessage(event) != null;
  } catch {
    return true; // an event the runner cannot read is not ours to cut
  }
}

// Returns what goes in the store for one event: { payload, sha256 }, where
// sha256 is always the hash of the full line as the log has it.
export function storedForm(event, { bodyInLog = false, offset = null } = {}) {
  const full = JSON.stringify(event);
  const hash = sha256(full);
  const bytes = Buffer.byteLength(full, "utf8");
  if (!bodyInLog || bytes <= EVENT_INLINE_BYTES || keptWhole(event)) return { payload: full, sha256: hash };
  const clipped = JSON.stringify({ ...truncateEventStrings(event, CLIPPED_STRING_BYTES), [CLIP_KEY]: { stored: "jsonl", bytes, sha256: hash, offset } });
  // An event made of many small strings does not shrink; marking it would only cost a log read later.
  if (Buffer.byteLength(clipped, "utf8") > bytes / 2) return { payload: full, sha256: hash };
  return { payload: clipped, sha256: hash };
}

const isClipped = (event) => event?.[CLIP_KEY]?.stored === "jsonl" && typeof event[CLIP_KEY].sha256 === "string";

// Collects the wanted lines from the log, reading from `start`.
async function scanLog(logPath, start, wanted, found) {
  const lines = createInterface({ input: createReadStream(logPath, { encoding: "utf8", start }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (Buffer.byteLength(line, "utf8") <= EVENT_INLINE_BYTES) continue;
    const hash = sha256(line);
    if (wanted.has(hash)) found.set(hash, line);
    if (found.size === wanted.size) break;
  }
}

// Puts the full bodies back from the log. The recorded offset says where to
// start, so reading the newest events does not mean reading the whole log; a
// line that is not where it was recorded is looked for once from the top. An
// event whose line cannot be found stays clipped and says so.
export async function restoreEventBodies(events, logPath) {
  const clipped = events.filter(isClipped);
  if (clipped.length === 0) return events;
  const wanted = new Set(clipped.map((event) => event[CLIP_KEY].sha256));
  const found = new Map();
  if (logPath) {
    try {
      const offsets = clipped.map((event) => event[CLIP_KEY].offset);
      const start = offsets.every((offset) => Number.isInteger(offset) && offset >= 0) ? Math.min(...offsets) : 0;
      await scanLog(logPath, start, wanted, found);
      if (found.size < wanted.size && start > 0) await scanLog(logPath, 0, wanted, found);
    } catch {
      // a log that is gone leaves the events clipped, marked below
    }
  }
  return events.map((event) => {
    if (!isClipped(event)) return event;
    const line = found.get(event[CLIP_KEY].sha256);
    return line ? JSON.parse(line) : { ...event, [CLIP_KEY]: { ...event[CLIP_KEY], missing: true } };
  });
}
