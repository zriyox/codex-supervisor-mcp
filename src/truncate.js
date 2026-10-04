// Port of Codex's output truncation so supervisor output reads the same way
// Codex's own tool output does.
//
// Rust source: codex-rs/utils/string/src/truncate.rs
//              codex-rs/utils/output-truncation/src/lib.rs
//
// Truncation keeps the head and the tail and drops the middle, then reports
// how much was dropped. The budget is measured in UTF-8 bytes, exactly like
// TruncationPolicy::Bytes.

const APPROX_BYTES_PER_TOKEN = 4;

export function approxTokenCount(text) {
  const len = Buffer.byteLength(text, "utf8");
  return Math.floor((len + APPROX_BYTES_PER_TOKEN - 1) / APPROX_BYTES_PER_TOKEN);
}

export function approxBytesForTokens(tokens) {
  return tokens * APPROX_BYTES_PER_TOKEN;
}

function splitBudget(budget) {
  const left = Math.floor(budget / 2);
  return [left, budget - left];
}

function formatTruncationMarker(useTokens, removedCount) {
  return useTokens ? `…${removedCount} tokens truncated…` : `…${removedCount} chars truncated…`;
}

function removedUnits(useTokens, removedBytes, removedChars) {
  if (!useTokens) return removedChars;
  return Math.floor((removedBytes + APPROX_BYTES_PER_TOKEN - 1) / APPROX_BYTES_PER_TOKEN);
}

export function splitString(s, beginningBytes, endBytes) {
  const buf = Buffer.from(s, "utf8");
  const len = buf.length;
  const tailStartTarget = Math.max(0, len - endBytes);
  let prefixEnd = 0;
  let suffixStart = len;
  let removedChars = 0;
  let suffixStarted = false;
  let byteOffset = 0;

  for (const ch of s) {
    const size = Buffer.byteLength(ch, "utf8");
    const startByte = byteOffset;
    const endByte = byteOffset + size;
    byteOffset = endByte;

    if (endByte <= beginningBytes) {
      prefixEnd = endByte;
      continue;
    }
    if (startByte >= tailStartTarget) {
      if (!suffixStarted) {
        suffixStart = startByte;
        suffixStarted = true;
      }
      continue;
    }
    removedChars += 1;
  }

  if (suffixStart < prefixEnd) suffixStart = prefixEnd;
  return {
    removedChars,
    before: buf.subarray(0, prefixEnd).toString("utf8"),
    after: buf.subarray(suffixStart).toString("utf8")
  };
}

function truncateWithByteEstimate(s, maxBytes, useTokens) {
  if (s === "") return "";
  const totalBytes = Buffer.byteLength(s, "utf8");

  if (maxBytes === 0) {
    return formatTruncationMarker(useTokens, removedUnits(useTokens, totalBytes, [...s].length));
  }
  if (totalBytes <= maxBytes) return s;

  const [leftBudget, rightBudget] = splitBudget(maxBytes);
  const { removedChars, before, after } = splitString(s, leftBudget, rightBudget);
  const marker = formatTruncationMarker(
    useTokens,
    removedUnits(useTokens, totalBytes - maxBytes, removedChars)
  );
  return before + marker + after;
}

export function truncateMiddleChars(s, maxBytes) {
  return truncateWithByteEstimate(s, maxBytes, false);
}

export function truncateMiddleWithTokenBudget(s, maxTokens) {
  if (s === "") return { text: "", originalTokenCount: null };
  if (maxTokens > 0 && Buffer.byteLength(s, "utf8") <= approxBytesForTokens(maxTokens)) {
    return { text: s, originalTokenCount: null };
  }
  const truncated = truncateWithByteEstimate(s, approxBytesForTokens(maxTokens), true);
  if (truncated === s) return { text: truncated, originalTokenCount: null };
  return { text: truncated, originalTokenCount: approxTokenCount(s) };
}

function lineCount(s) {
  if (s === "") return 0;
  const parts = s.split("\n");
  return s.endsWith("\n") ? parts.length - 1 : parts.length;
}

export function formattedTruncateText(content, byteBudget) {
  if (Buffer.byteLength(content, "utf8") <= byteBudget) return content;
  const originalTokenCount = approxTokenCount(content);
  const totalLines = lineCount(content);
  const result = truncateMiddleChars(content, byteBudget);
  return `Warning: truncated output (original token count: ${originalTokenCount})\nTotal output lines: ${totalLines}\n\n${result}`;
}

// Truncate every oversized string inside an event, keeping the event a valid
// object so the caller still gets structured JSON back.
export function truncateEventStrings(value, byteBudget) {
  if (typeof value === "string") {
    return Buffer.byteLength(value, "utf8") > byteBudget ? formattedTruncateText(value, byteBudget) : value;
  }
  if (Array.isArray(value)) return value.map((item) => truncateEventStrings(item, byteBudget));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = truncateEventStrings(entry, byteBudget);
    }
    return out;
  }
  return value;
}
