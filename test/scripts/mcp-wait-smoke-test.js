import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const cwd = process.argv[2] ?? process.cwd();

const transport = new StdioClientTransport({
  command: "node",
  args: ["./src/mcp-server.js"],
  cwd: new URL("../..", import.meta.url).pathname,
  // Uses the real store on purpose, but never rewrites the installed skill with the checkout's.
  env: { ...process.env, AGENT_SUPERVISOR_SKIP_SKILL_SYNC: "1" }
});

const client = new Client({
  name: "agent-supervisor-wait-smoke-test",
  version: "0.1.0"
});

function parseTextResult(result) {
  return JSON.parse(result.content?.[0]?.text ?? "null");
}

try {
  await client.connect(transport);
  const created = parseTextResult(await client.callTool({
    name: "create_worker",
    arguments: {
      title: "MCP wait smoke test",
      task: "Reply with one short sentence. Do not modify files.",
      cwd,
      sandbox: { mode: "read-only" },
      reasoning_effort: "high",
      owned_paths: [cwd],
      goal: { objective: "MCP wait smoke test: reply with one sentence" }
    }
  }));

  const waited = parseTextResult(await client.callTool({
    name: "wait_workers",
    arguments: {
      task_ids: [created.id],
      mode: "all",
      timeout_ms: 120000,
      allow_long_wait: true,
      poll_ms: 1000,
      include_events: true,
      event_limit: 5
    }
  }));

  console.log(JSON.stringify({ created: created.id, waited }, null, 2));

  if (waited.timed_out || waited.completed_count !== 1) {
    process.exit(1);
  }
} finally {
  await client.close();
}
