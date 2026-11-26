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
export function storedForm(event, { bodyInLog = false } = {}) {
  const full = JSON.stringify(event);
  const hash = sha256(full);
  const bytes = Buffer.byteLength(full, "utf8");
  if (!bodyInLog || bytes <= EVENT_INLINE_BYTES || keptWhole(event)) return { payload: full, sha256: hash };
  const clipped = { ...truncateEventStrings(event, CLIPPED_STRING_BYTES), body: { stored: "jsonl", bytes, sha256: hash } };
  return { payload: JSON.stringify(clipped), sha256: hash };
}

const isClipped = (event) => event?.body?.stored === "jsonl" && typeof event.body.sha256 === "string";

// Puts the full bodies back from the log. An event whose line cannot be found
// stays clipped and says so, instead of failing the read.
export async function restoreEventBodies(events, logPath) {
  const wanted = new Set(events.filter(isClipped).map((event) => event.body.sha256));
  if (wanted.size === 0) return events;
  const found = new Map();
  if (logPath) {
    try {
      const lines = createInterface({ input: createReadStream(logPath, { encoding: "utf8" }), crlfDelay: Infinity });
      for await (const line of lines) {
        if (Buffer.byteLength(line, "utf8") <= EVENT_INLINE_BYTES) continue;
        const hash = sha256(line);
        if (wanted.has(hash)) found.set(hash, line);
        if (found.size === wanted.size) break;
      }
    } catch {
      // a log that is gone leaves the events clipped, marked below
    }
  }
  return events.map((event) => {
    if (!isClipped(event)) return event;
    const line = found.get(event.body.sha256);
    return line ? JSON.parse(line) : { ...event, body: { ...event.body, missing: true } };
  });
}
