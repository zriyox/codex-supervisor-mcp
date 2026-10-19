import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWorkerReport, workerReportSchemaPath } from "../../src/worker-report.js";
import { readFile } from "node:fs/promises";

test("structured report validation refuses prose, missing fields and fabricated shapes", async () => {
  const report = { result: "done", verification: ["npm test exit 0"], not_done: [] };
  assert.deepEqual(parseWorkerReport(JSON.stringify(report)).report, report);
  const stringFields = parseWorkerReport(JSON.stringify({ ...report, verification: "passed", not_done: "none" }));
  assert.equal(stringFields.valid, true);
  assert.deepEqual(stringFields.report, { ...report, verification: ["passed"], not_done: ["none"] });
  assert.match(stringFields.repaired, /verification_string/);
  for (const input of ["done", "{}", JSON.stringify({ ...report, verification: [null] }), JSON.stringify({ ...report, not_done: [null] }), JSON.stringify({ ...report, extra: "ignored" })]) assert.equal(parseWorkerReport(input).valid, false);
  assert.equal(parseWorkerReport("").valid, false);
  assert.equal(parseWorkerReport("   ").valid, false);
  const schema = JSON.parse(await readFile(workerReportSchemaPath, "utf8"));
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, Object.keys(report));
});

test("a report missing one closing bracket is repaired only within the exact schema", () => {
  const report = { result: "done", verification: ["npm test exit 0"], not_done: ["none"] };
  const complete = JSON.stringify(report);
  const text = complete.slice(0, -2) + "}";
  const parsed = parseWorkerReport(text);
  assert.equal(parsed.valid, true);
  assert.deepEqual(parsed.report, report);
  assert.match(parsed.repaired, /closed_array/);
  assert.equal(parseWorkerReport(JSON.stringify(report).slice(0, -8)).valid, false, "a deeply truncated report is not guessed");
});

// Observed in the wild: the run is fine and acceptance passes, but the last
// message arrives fenced or annotated, so the worker used to be marked failed
// with invalid_report. The fields are still checked exactly as strictly.
test("a fenced or annotated report is unwrapped without relaxing the fields", () => {
  const report = { result: "done", verification: ["npm test exit 0"], not_done: ["none"] };
  const json = JSON.stringify(report);
  for (const text of [`\`\`\`json\n${json}\n\`\`\``, `\`\`\`\n${json}\n\`\`\``, `Here is my report:\n\`\`\`json\n${json}\n\`\`\`\nDone.`, `Report:\n${json}\nThat is all.`]) {
    const parsed = parseWorkerReport(text);
    assert.equal(parsed.valid, true, text);
    assert.deepEqual(parsed.report, report);
  }
  assert.equal(parseWorkerReport(JSON.stringify(report)).repaired, undefined, "a bare report is not marked as repaired");
  assert.equal(parseWorkerReport(`\`\`\`json\n${json}\n\`\`\``).repaired, "fence");
  assert.equal(parseWorkerReport(`Report:\n${json}\nDone.`).repaired, "embedded");
  // A fenced object with the wrong shape is still refused.
  const wrong = parseWorkerReport(`\`\`\`json\n${JSON.stringify({ ...report, extra: 1 })}\n\`\`\``);
  assert.equal(wrong.valid, false);
  // A bad object can never be rescued by a second, valid one in the same message.
  assert.equal(parseWorkerReport(`${JSON.stringify({ result: 1 })}\n${json}`).valid, false);
});
