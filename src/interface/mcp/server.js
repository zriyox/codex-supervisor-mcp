#!/usr/bin/env node
import "../../app/compose.js";
import { syncSkills } from "../../infra/skill-sync.js";
import { packageVersion } from "./meta.js";
import { refreshUpdateState, UPDATE_RECHECK_MS } from "./update-state.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { overviewDeltaTool, checkWorkersTool } from "./tools/poll.js";
import { checkAcceptanceTool, preflightCodexWorkerTool, getWorkerPreflightTool, createCodexWorkerTool, createCodexFollowupWorkerTool, resumeCodexWorkerTool } from "./tools/dispatch.js";
import { listCodexWorkersTool, getOrchestrationOverviewTool, getSessionWorksTool, checkForUpdateTool, describeSessionTool, searchWorksTool, getCodexWorkerStatusTool, getCodexWorkerEventsTool } from "./tools/overview.js";
import { waitCodexWorkersTool } from "./tools/wait.js";
import { getContextSnapshotMetaTool, getFactTool, getArtifactTool, promoteWorkerFactTool, revokeWorkerFactTool, getWorkerEvidenceTool, searchWorkerFactsTool } from "./tools/facts.js";
import { createIndependentVerifierTool, recordIndependentFindingTool, resolveIndependentFindingTool, getIndependentReviewTool } from "./tools/review.js";
import { getWorkerGoalTool, getWorkerSummaryTool, getWorkerResultTool, getWorkerDiffTool, askCodexWorkerTool } from "./tools/results.js";
import { landCodexWorkerTool, verifyDeliveryPushTool, cleanupPlanTool, applyCleanupTool, cleanupHistoryTool, cancelCodexWorkerTool } from "./tools/delivery.js";

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
if (!process.env.CODEX_SUPERVISOR_SKIP_SKILL_SYNC) {
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

// Registration order is part of the contract: tools/list returns it.
const TOOLS = [
  overviewDeltaTool,
  checkWorkersTool,
  checkAcceptanceTool,
  preflightCodexWorkerTool,
  getWorkerPreflightTool,
  createCodexWorkerTool,
  createCodexFollowupWorkerTool,
  resumeCodexWorkerTool,
  listCodexWorkersTool,
  getOrchestrationOverviewTool,
  waitCodexWorkersTool,
  getSessionWorksTool,
  checkForUpdateTool,
  describeSessionTool,
  searchWorksTool,
  getCodexWorkerStatusTool,
  getCodexWorkerEventsTool,
  getContextSnapshotMetaTool,
  getFactTool,
  getArtifactTool,
  promoteWorkerFactTool,
  revokeWorkerFactTool,
  getWorkerEvidenceTool,
  searchWorkerFactsTool,
  createIndependentVerifierTool,
  recordIndependentFindingTool,
  resolveIndependentFindingTool,
  getIndependentReviewTool,
  getWorkerGoalTool,
  getWorkerSummaryTool,
  getWorkerResultTool,
  getWorkerDiffTool,
  askCodexWorkerTool,
  landCodexWorkerTool,
  verifyDeliveryPushTool,
  cleanupPlanTool,
  applyCleanupTool,
  cleanupHistoryTool,
  cancelCodexWorkerTool
];
for (const tool of TOOLS) server.registerTool(...tool);

const transport = new StdioServerTransport();
await server.connect(transport);
