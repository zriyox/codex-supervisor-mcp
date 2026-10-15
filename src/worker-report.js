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

export function parseWorkerReport(text) {
  if (typeof text !== "string" || !text.trim()) return { format: "json_schema", valid: false, error: "worker wrote no final report" };
  let parseError = null;
  for (const { source, text: candidate } of reportCandidates(text)) {
    let value;
    try { value = JSON.parse(candidate); }
    catch (error) { parseError = parseError ?? error; continue; }
    const valid = value && typeof value === "object" && !Array.isArray(value)
      && Object.keys(value).sort().join(",") === "not_done,result,verification"
      && typeof value.result === "string" && Array.isArray(value.verification) && Array.isArray(value.not_done)
      && [...value.verification, ...value.not_done].every((entry) => typeof entry === "string");
    if (!valid) return { format: "json_schema", valid: false, error: "report must contain result:string, verification:string[], not_done:string[] only" };
    return { format: "json_schema", valid: true, report: value, ...(source === "bare" ? {} : { repaired: source }) };
  }
  return { format: "json_schema", valid: false, error: parseError?.message ?? "report is not JSON" };
}
