import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWorkerReport, workerReportSchemaPath } from "../../src/worker-report.js";
import { readFile } from "node:fs/promises";

test("structured report validation refuses prose, missing fields and fabricated shapes", async () => {
  const report = { result: "done", verification: ["npm test exit 0"], not_done: [] };
  assert.deepEqual(parseWorkerReport(JSON.stringify(report)).report, report);
  for (const input of ["done", "{}", JSON.stringify({ ...report, verification: "passed" }), JSON.stringify({ ...report, not_done: [null] }), JSON.stringify({ ...report, extra: "ignored" })]) assert.equal(parseWorkerReport(input).valid, false);
  const schema = JSON.parse(await readFile(workerReportSchemaPath, "utf8"));
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, Object.keys(report));
});
