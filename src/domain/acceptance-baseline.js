// Compare complete test identities, never a grep of the total failure count.
// The caller supplies an approved baseline and the current runner's evidence.
export function compareFailureBaseline(expected, actual) {
  const errors = [];
  const result = { passed: false, added: [], removed: [], changed: [], missing_required: [], errors };
  const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const text = (value) => typeof value === "string" && value.trim().length > 0;
  if (!object(expected) || !object(actual)) {
    errors.push("baseline and report must be objects");
    return result;
  }
  if (!object(expected.identity) || !text(expected.identity.base_commit)) errors.push("baseline identity.base_commit is required");
  if (!object(actual.identity) || !text(actual.identity.base_commit)) errors.push("report identity.base_commit is required");
  if (expected.identity?.base_commit !== actual.identity?.base_commit) errors.push("base_commit mismatch");
  if (actual.complete !== true) errors.push("report is not complete");
  // Any explicitly approved identity component must match, including suite
  // version, dataset hash or measured commit. Extra actual fields are allowed.
  for (const [key, value] of Object.entries(expected.identity ?? {})) {
    if (!text(value)) errors.push(`baseline identity.${key} must be a nonempty string`);
    else if (actual.identity?.[key] !== value && key !== "base_commit") errors.push(`identity.${key} mismatch`);
  }
  const ids = (value, label) => {
    if (!Array.isArray(value) || value.some((entry) => !text(entry))) {
      errors.push(`${label} must be an array of nonempty test IDs`);
      return new Set();
    }
    const unique = new Set(value);
    if (unique.size !== value.length) errors.push(`${label} has duplicate test IDs`);
    return unique;
  };
  const required = ids(expected.required, "required");
  const executed = ids(actual.executed, "executed");
  const skipped = ids(actual.skipped, "skipped");
  for (const id of skipped) if (executed.has(id)) errors.push(`test ${id} is both executed and skipped`);
  result.missing_required = [...required].filter((id) => !executed.has(id) || skipped.has(id)).sort();
  const failures = (value, label) => {
    const map = new Map();
    if (!Array.isArray(value)) {
      errors.push(`${label} failures must be an array`);
      return map;
    }
    for (const item of value) {
      if (!object(item) || !text(item.test_id) || !["failure", "error"].includes(item.kind) || !text(item.signature)) {
        errors.push(`${label} has a malformed failure record`);
        continue;
      }
      if (map.has(item.test_id)) errors.push(`${label} has duplicate failure ${item.test_id}`);
      map.set(item.test_id, { test_id: item.test_id, kind: item.kind, signature: item.signature });
    }
    return map;
  };
  const baseline = failures(expected.failures, "baseline");
  const observed = failures(actual.failures, "report");
  for (const [id, item] of observed) {
    if (!executed.has(id)) errors.push(`failure ${id} was not executed`);
    const before = baseline.get(id);
    if (!before) result.added.push(item);
    else if (before.kind !== item.kind || before.signature !== item.signature) result.changed.push({ test_id: id, expected: before, actual: item });
  }
  for (const [id, item] of baseline) if (!observed.has(id)) result.removed.push(item);
  for (const key of ["added", "removed", "changed"]) result[key].sort((a, b) => a.test_id.localeCompare(b.test_id));
  result.passed = errors.length === 0 && result.added.length === 0 && result.removed.length === 0 && result.changed.length === 0 && result.missing_required.length === 0;
  return result;
}
