// Ports the assertions from codex-rs/utils/string/src/truncate/tests.rs so the
// JS truncation is verified against Codex's own expected values.
import assert from "node:assert/strict";
import {
  approxTokenCount,
  splitString,
  formattedTruncateText,
  truncateEventStrings,
  truncateMiddleChars,
  truncateMiddleWithTokenBudget
} from "./truncate.js";

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

// Direct ports of the split_string cases in truncate/tests.rs.
check("split_string_works", () => {
  assert.deepEqual(splitString("hello world", 5, 5), { removedChars: 1, before: "hello", after: "world" });
  assert.deepEqual(splitString("abc", 0, 0), { removedChars: 3, before: "", after: "" });
});

check("split_string_handles_empty_string", () => {
  assert.deepEqual(splitString("", 4, 4), { removedChars: 0, before: "", after: "" });
});

check("split_string_only_keeps_prefix_when_tail_budget_is_zero", () => {
  assert.deepEqual(splitString("abcdef", 3, 0), { removedChars: 3, before: "abc", after: "" });
});

check("split_string_only_keeps_suffix_when_prefix_budget_is_zero", () => {
  assert.deepEqual(splitString("abcdef", 0, 3), { removedChars: 3, before: "", after: "def" });
});

check("split_string_handles_overlapping_budgets_without_removal", () => {
  assert.deepEqual(splitString("abcdef", 4, 4), { removedChars: 0, before: "abcd", after: "ef" });
});

check("split_string_respects_utf8_boundaries", () => {
  assert.deepEqual(splitString("😀abc😀", 5, 5), { removedChars: 1, before: "😀a", after: "c😀" });
  assert.deepEqual(splitString("😀😀😀😀😀", 1, 1), { removedChars: 5, before: "", after: "" });
  assert.deepEqual(splitString("😀😀😀😀😀", 7, 7), { removedChars: 3, before: "😀", after: "😀" });
});

check("truncate_middle_chars_matches_rust_split_budget", () => {
  assert.equal(truncateMiddleChars("hello world", 3), "h…8 chars truncated…ld");
});

check("truncate_with_token_budget_returns_original_when_under_limit", () => {
  const { text, originalTokenCount } = truncateMiddleWithTokenBudget("short output", 100);
  assert.equal(text, "short output");
  assert.equal(originalTokenCount, null);
});

check("truncate_with_token_budget_reports_truncation_at_zero_limit", () => {
  const { text, originalTokenCount } = truncateMiddleWithTokenBudget("abcdef", 0);
  assert.equal(text, "…2 tokens truncated…");
  assert.equal(originalTokenCount, 2);
});

check("truncate_middle_tokens_handles_utf8_content", () => {
  const s = "😀😀😀😀😀😀😀😀😀😀\nsecond line with text\n";
  const { text, originalTokenCount } = truncateMiddleWithTokenBudget(s, 8);
  assert.equal(text, "😀😀😀😀…8 tokens truncated… line with text\n");
  assert.equal(originalTokenCount, 16);
});

check("truncate_middle_bytes_handles_utf8_content", () => {
  const s = "😀😀😀😀😀😀😀😀😀😀\nsecond line with text\n";
  assert.equal(truncateMiddleChars(s, 20), "😀😀…21 chars truncated…with text\n");
});

check("approx_token_count_rounds_up_per_4_bytes", () => {
  assert.equal(approxTokenCount("abcdef"), 2);
  assert.equal(approxTokenCount(""), 0);
  assert.equal(approxTokenCount("😀😀😀😀😀"), 5);
});

check("formatted_truncate_text_keeps_short_text_untouched", () => {
  assert.equal(formattedTruncateText("short", 100), "short");
});

check("formatted_truncate_text_adds_codex_style_header", () => {
  const out = formattedTruncateText("a".repeat(400), 100);
  const [header, lineCount, blank] = out.split("\n");
  assert.equal(header, "Warning: truncated output (original token count: 100)");
  assert.equal(lineCount, "Total output lines: 1");
  assert.equal(blank, "");
  assert.ok(out.includes("chars truncated"));
});

check("truncate_event_strings_only_touches_oversized_strings", () => {
  const event = { type: "item.completed", item: { type: "reasoning", text: "x".repeat(400), id: "item_1" } };
  const out = truncateEventStrings(event, 100);
  assert.equal(out.type, "item.completed");
  assert.equal(out.item.id, "item_1");
  assert.equal(out.item.type, "reasoning");
  assert.ok(out.item.text.startsWith("Warning: truncated output"));
  assert.ok(out.item.text.length < 400);
});

check("truncate_event_strings_leaves_small_events_identical", () => {
  const event = { type: "turn.completed", usage: { input_tokens: 12 } };
  assert.deepEqual(truncateEventStrings(event, 1000), event);
});

console.log(`\n${passed} truncation checks passed`);
