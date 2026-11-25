#!/usr/bin/env node
import "../../app/compose.js";
import { installCrashGuard } from "../../infra/crash-guard.js";
import { syncSkills } from "../../infra/skill-sync.js";
import { packageVersion } from "./meta.js";
import { refreshUpdateState, UPDATE_RECHECK_MS } from "./update-state.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { cancelWorkerTool, createWorkerTool, preflightWorkerTool, resumeWorkerTool } from "./tools/dispatch.js";
import { cleanupTool, landWorkerTool, verifyPushTool } from "./tools/deliver.js";
import { factsTool, getArtifactTool, reviewTool } from "./tools/optional.js";
import { askWorkerTool, describeSessionTool, findWorksTool, getWorkerDiffTool, getWorkerTool } from "./tools/read.js";
import { pollWorkersTool, waitWorkersTool } from "./tools/track.js";

installCrashGuard("mcp-server");

const server = new McpServer({
  name: "codex-supervisor",
  version: packageVersion
});

refreshUpdateState();
setInterval(() => refreshUpdateState({ force: true }), UPDATE_RECHECK_MS).unref();

// The skill describes this tool surface, so it moves with the server: a
// server fetched by `npx -y codex-supervisor-mcp@latest` never ran postinstall,
// and a global install only synced the skill on the day it was installed.
// Runs in the background; a client that cannot write its skill directory
// only costs a line on stderr.
if (!process.env.AGENT_SUPERVISOR_SKIP_SKILL_SYNC) {
  syncSkills()
    .then((result) => {
      const changed = [...result.installed, ...result.updated];
      if (changed.length > 0) {
        process.stderr.write(
          `[codex-supervisor] skill synced for ${changed.join(", ")}; a session that already loaded the skill keeps the old text until it loads it again\n`
        );
      }
      for (const failure of result.failed) {
        process.stderr.write(`[codex-supervisor] skill sync failed: ${failure}\n`);
      }
    })
    .catch((error) => {
      process.stderr.write(`[codex-supervisor] skill sync failed: ${error.message}\n`);
    });
}

// The order is the order tools/list returns, which is the order a model reads
// them in: the path of a batch from preflight to cleanup.
const TOOLS = [
  preflightWorkerTool, createWorkerTool, resumeWorkerTool, cancelWorkerTool,
  pollWorkersTool, waitWorkersTool,
  getWorkerTool, getWorkerDiffTool, askWorkerTool,
  landWorkerTool, verifyPushTool, cleanupTool,
  findWorksTool, describeSessionTool
];
// The fact ledger, independent review and raw artifacts are rarely needed and
// cost context in every session, so they are opt-in.
const OPTIONAL_TOOLS = [factsTool, reviewTool, getArtifactTool];
const enabled = process.env.AGENT_SUPERVISOR_TOOLS === "all" ? [...TOOLS, ...OPTIONAL_TOOLS] : TOOLS;
for (const tool of enabled) server.registerTool(...tool);

const transport = new StdioServerTransport();
await server.connect(transport);
