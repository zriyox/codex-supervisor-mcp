// How a public tool reaches the operation behind it. An operation validates
// its own input and answers with a text result; a tool maps the public
// arguments onto it and shapes the reply.
import { z } from "zod";
import { textResult } from "../result.js";

const defined = (object) => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));

// Runs one operation and returns its payload as a plain value.
export async function run(op, args, extra) {
  const parsed = op.input.safeParse(defined(args));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { error: "invalid_arguments", message: `${issue.path.join(".") || "arguments"}: ${issue.message}` };
  }
  const result = await op.handler(parsed.data, extra);
  const text = result?.content?.[0]?.text ?? "null";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// A payload whose top level carries `error` is a failed call, and says so in
// the protocol as well as in the text.
export function reply(payload) {
  const result = textResult(payload);
  if (payload && typeof payload === "object" && typeof payload.error === "string") result.isError = true;
  return result;
}

// Unknown arguments are refused, not dropped: a caller still using a name from
// an older version gets told so instead of running with a silent default.
export function defineTool(name, config, handler) {
  return [name, { ...config, inputSchema: z.strictObject(config.inputSchema) }, async (args, extra) => {
    try {
      return reply(await handler(args ?? {}, extra));
    } catch (error) {
      return reply({ error: error.code ?? "internal_error", message: error.message });
    }
  }];
}

export { defined };
