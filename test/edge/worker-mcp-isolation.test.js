import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dispatchArgs, makeRepo, tempHome, waitFor, withMcp } from "./helpers.js";

test("a worker disables only the supervisor MCP server it inherited", async () => {
  const home = await tempHome("supervisor-worker-mcp-");
  const codexHome = join(home, "codex-home");
  const argsLog = join(home, "codex-args.jsonl");
  const { dir } = await makeRepo(join(home, "repo"));
  await mkdir(codexHome);
  await writeFile(join(codexHome, "config.toml"), [
    "[mcp_servers.codex-supervisor]",
    'command = "node"',
    "[mcp_servers.obsidian]",
    'url = "http://127.0.0.1:27123"'
  ].join("\n"));

  await withMcp({ SUPERVISOR_HOME: home, CODEX_HOME: codexHome, FAKE_CODEX_ARGS_LOG: argsLog }, async ({ call }) => {
    const worker = await call("create_codex_worker", dispatchArgs("isolated worker", dir));
    assert.ok(worker.id, JSON.stringify(worker));
    await waitFor(call, worker.id, (task) => task.status === "completed" && task.exit_code !== null);
  });

  const runs = (await readFile(argsLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line).args);
  const args = runs.find((entry) => entry.includes("--output-schema"));
  assert.ok(args, JSON.stringify(runs));
  assert.ok(args.includes("mcp_servers.codex-supervisor.enabled=false"), args.join(" "));
  assert.ok(!args.includes("mcp_servers.obsidian.enabled=false"), args.join(" "));
});
