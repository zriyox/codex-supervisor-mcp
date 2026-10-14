import { fileURLToPath } from "node:url";
export const workerReportSchemaPath = fileURLToPath(new URL("./worker-report.schema.json", import.meta.url));

export function parseWorkerReport(text) {
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "not_done,result,verification"
      || typeof value.result !== "string" || !Array.isArray(value.verification) || !Array.isArray(value.not_done)
      || [...value.verification, ...value.not_done].some((entry) => typeof entry !== "string")) {
      throw new Error("report must contain result:string, verification:string[], not_done:string[] only");
    }
    return { format: "json_schema", valid: true, report: value };
  } catch (error) { return { format: "json_schema", valid: false, error: error.message }; }
}
