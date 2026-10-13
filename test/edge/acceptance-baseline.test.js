import { test } from "node:test";
import assert from "node:assert/strict";
import { compareFailureBaseline } from "../../src/acceptance-baseline.js";

const failure = (test_id = "old", kind = "failure", signature = "old assertion") => ({ test_id, kind, signature });
const expected = (failures = [], required = []) => ({ identity: { base_commit: "base" }, failures, required });
const actual = (failures = [], executed = [], skipped = []) => ({ identity: { base_commit: "base" }, complete: true, failures, executed, skipped });

test("an exact approved failure list with executed required tests passes", () => {
  const result = compareFailureBaseline(expected([failure()], ["must-run"]), actual([failure()], ["must-run", "old"]));
  assert.equal(result.passed, true);
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.errors, []);
});

test("same failure count with a substituted failing test is rejected", () => {
  const result = compareFailureBaseline(expected([failure()]), actual([failure("new")], ["new"]));
  assert.equal(result.passed, false);
  assert.deepEqual(result.added.map((x) => x.test_id), ["new"]);
  assert.deepEqual(result.removed.map((x) => x.test_id), ["old"]);
});

test("new errors and changed assertion signatures are rejected", () => {
  for (const item of [failure("old", "error"), failure("old", "failure", "different assertion")]) {
    const result = compareFailureBaseline(expected([failure()]), actual([item], ["old"]));
    assert.equal(result.passed, false);
    assert.equal(result.changed.length, 1);
  }
});

test("removing a known failure requires an explicit baseline update", () => {
  const result = compareFailureBaseline(expected([failure()]), actual([], ["old"]));
  assert.equal(result.passed, false);
  assert.deepEqual(result.removed, [failure()]);
});

test("required tests cannot be skipped or missing even when failures are zero", () => {
  for (const report of [actual([], [], ["must-run"]), actual()]) {
    const result = compareFailureBaseline(expected([], ["must-run"]), report);
    assert.equal(result.passed, false);
    assert.deepEqual(result.missing_required, ["must-run"]);
  }
});

test("wrong base and incomplete reports cannot validate a baseline", () => {
  for (const report of [{ ...actual(), identity: { base_commit: "other" } }, { ...actual(), complete: false }]) {
    const result = compareFailureBaseline(expected(), report);
    assert.equal(result.passed, false);
    assert.ok(result.errors.length > 0);
  }
});

test("empty failure baselines pass only with valid complete execution evidence", () => {
  assert.equal(compareFailureBaseline(expected(), actual()).passed, true);
  for (const report of [null, {}, { ...actual(), complete: undefined }, { ...actual(), failures: undefined }]) {
    assert.equal(compareFailureBaseline(expected(), report).passed, false);
  }
});

test("duplicate tests, contradictory skip evidence and unexecuted failures are rejected", () => {
  for (const report of [actual([failure(), failure()], ["old"]), actual([], ["must-run"], ["must-run"]), actual([failure()]), actual([], ["old", "old"])]) {
    const result = compareFailureBaseline(expected(), report);
    assert.equal(result.passed, false);
    assert.ok(result.errors.length > 0);
  }
});

test("malformed baseline records fail closed and comparison does not mutate inputs", () => {
  for (const baseline of [null, {}, { ...expected(), identity: {} }, expected([{ test_id: "bad" }]), expected([], ["", "x"])]) {
    assert.equal(compareFailureBaseline(baseline, actual()).passed, false);
  }
  const baseline = expected([failure()], ["old"]);
  const report = actual([failure()], ["old"]);
  const before = JSON.stringify([baseline, report]);
  assert.equal(compareFailureBaseline(baseline, report).passed, true);
  assert.equal(JSON.stringify([baseline, report]), before);
});
