import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["./src/mcp-server.js"],
  cwd: new URL("../..", import.meta.url).pathname
});

const client = new Client({
  name: "codex-supervisor-smoke-test",
  version: "0.2.0"
});

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const toolNames = tools.tools.map((tool) => tool.name).sort();
  const required = [
    "preflight_worker", "create_worker", "resume_worker", "cancel_worker", "poll_workers", "wait_workers", "get_worker",
    "get_worker_diff", "ask_worker", "land_worker", "verify_push", "cleanup", "find_works", "describe_session"
  ];
  const missing = required.filter((name) => !toolNames.includes(name));
  if (missing.length > 0) {
    throw new Error(`Missing tools: ${missing.join(", ")}`);
  }

  const result = await client.callTool({
    name: "poll_workers",
    arguments: {}
  });

  console.log(JSON.stringify({ ok: true, tools: toolNames, sample: result.content }, null, 2));
} finally {
  await client.close();
}
