import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["./src/mcp-server.js"],
  cwd: new URL("..", import.meta.url).pathname
});

const client = new Client({
  name: "codex-supervisor-smoke-test",
  version: "0.1.0"
});

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const toolNames = tools.tools.map((tool) => tool.name).sort();
  const required = [
    "create_codex_followup_worker",
    "cancel_codex_worker",
    "create_codex_worker",
    "get_codex_worker_events",
    "get_codex_worker_status",
    "list_codex_workers",
    "wait_codex_workers"
  ];
  const missing = required.filter((name) => !toolNames.includes(name));
  if (missing.length > 0) {
    throw new Error(`Missing tools: ${missing.join(", ")}`);
  }

  const result = await client.callTool({
    name: "list_codex_workers",
    arguments: {}
  });

  console.log(JSON.stringify({ ok: true, tools: toolNames, sample: result.content }, null, 2));
} finally {
  await client.close();
}
