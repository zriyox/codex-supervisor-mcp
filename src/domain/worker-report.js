import { fileURLToPath } from "node:url";
export const workerReportSchemaPath = fileURLToPath(new URL("./worker-report.schema.json", import.meta.url));

// The last message should be the bare JSON value, but a provider or a weaker
// model sometimes wraps it in a markdown fence or pads it with a sentence.
// Unwrapping that is not a schema relaxation: the object still has to carry
// exactly result/verification/not_done with the right types. The first
// candidate that parses as JSON decides the verdict, so a wrong object is
// never rescued by a second one.
function reportCandidates(text) {
  const trimmed = text.trim();
  const candidates = [{ source: "bare", text: trimmed }];
  for (const match of trimmed.matchAll(/```[a-zA-Z]*\s*\n?([\s\S]*?)```/g)) {
    candidates.push({ source: "fence", text: match[1].trim() });
  }
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push({ source: "embedded", text: trimmed.slice(first, last + 1) });
  return candidates;
}

function validateReport(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { valid: false, error: "report must be a JSON object" };
  if (Object.keys(value).sort().join(",") !== "not_done,result,verification") {
    return { valid: false, error: "report must contain result:string, verification:string[], not_done:string[] only" };
  }
  if (typeof value.result !== "string") return { valid: false, error: "report.result must be a string" };
  const repaired = [];
  const normalized = { ...value };
  for (const field of ["verification", "not_done"]) {
    if (typeof value[field] === "string") {
      normalized[field] = [value[field]];
      repaired.push(`${field}_string`);
    }
    if (!Array.isArray(normalized[field]) || !normalized[field].every((entry) => typeof entry === "string")) {
      return { valid: false, error: `report.${field} must be a string or string[]` };
    }
  }
  return { valid: true, report: normalized, repaired };
}

function parseWithClosure(candidate) {
  try { return { value: JSON.parse(candidate), repair: null }; } catch (error) {
    const parsedError = error;
    const attempts = [
      [candidate, "}", "closed_object"],
      [candidate, "]", "closed_array"]
    ];
    if (candidate.endsWith("}")) {
      const body = candidate.slice(0, -1);
      attempts.push([body, "]}", "closed_array"]);
    }
    for (const [body, suffix, repair] of attempts) {
      try { return { value: JSON.parse(body + suffix), repair }; } catch { /* try the next bounded repair */ }
    }
    return { value: null, repair: null, error: parsedError };
  }
}

export function parseWorkerReport(text) {
  if (typeof text !== "string" || !text.trim()) return { format: "json_schema", valid: false, error: "worker wrote no final report" };
  let parseError = null;
  for (const { source, text: candidate } of reportCandidates(text)) {
    const parsed = parseWithClosure(candidate);
    if (parsed.error) { parseError = parseError ?? parsed.error; continue; }
    const checked = validateReport(parsed.value);
    if (!checked.valid) return { format: "json_schema", valid: false, error: checked.error };
    const repairs = [source === "bare" ? null : source, parsed.repair, ...checked.repaired].filter(Boolean);
    return { format: "json_schema", valid: true, report: checked.report, ...(repairs.length ? { repaired: repairs.join("+") } : {}) };
  }
  return { format: "json_schema", valid: false, error: parseError?.message ?? "report is not JSON" };
}

export function parseWorkerReportForRun(text, { outputSchema = true } = {}) {
  const parsed = parseWorkerReport(text);
  if (!outputSchema && !parsed.valid && typeof text === "string" && text.trim()) {
    return {
      format: "text",
      valid: true,
      repaired: "output_schema_disabled_text_fallback",
      report: { result: text, verification: [], not_done: [] }
    };
  }
  return parsed;
}
