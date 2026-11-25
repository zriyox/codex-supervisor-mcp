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
    "cancel_worker",
    "create_worker with followup_of",
    "create_worker",
    "get_worker (include events)",
    "get_worker",
    "poll_workers",
    "get_worker (include goal)",
    "get_worker (include result)",
    "get_worker",
    "poll_workers",
    "resume_worker",
    "wait_workers"
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
