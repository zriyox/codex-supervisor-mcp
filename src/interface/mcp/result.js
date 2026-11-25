export function textResult(value) {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2)
      }
    ]
  };
}

export function clip(value, maxChars) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function errorResult(error) {
  return textResult({
    error: error.code ?? "error",
    message: error.message,
    ...(error.conflicts ? { conflicts: error.conflicts } : {}),
    ...(error.details?.preflight ? { preflight: error.details.preflight } : {}),
    ...(error.details ? { files: error.details.files ?? [], git: error.details.git ?? null, base_commit: error.details.base_commit ?? null, head: error.details.head ?? null } : {})
  });
}
