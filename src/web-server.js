#!/usr/bin/env node
// Entry for `codex-supervisor-web`. Decides which store to open, then starts
// the board (web-app.js).
//
//   codex-supervisor-web                     # http://127.0.0.1:7877
//   SUPERVISOR_WEB_PORT=8080 codex-supervisor-web
//   SUPERVISOR_HOME=/path/to/state codex-supervisor-web
//
// The store has to be the one the MCP server writes. Without SUPERVISOR_HOME
// in the environment, the nearest .mcp.json above the current directory is
// read: a project that configures codex-supervisor with its own
// SUPERVISOR_HOME gets a board on that store without retyping the path.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export function storeFromMcpConfig(startDir) {
  let dir = resolve(startDir);
  for (;;) {
    const file = join(dir, ".mcp.json");
    if (existsSync(file)) {
      try {
        const config = JSON.parse(readFileSync(file, "utf8"));
        const home = config?.mcpServers?.["codex-supervisor"]?.env?.SUPERVISOR_HOME;
        if (typeof home === "string" && home.trim()) return { home: resolve(dir, home.trim()), file };
      } catch {
        // an unreadable .mcp.json is somebody else's problem; keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

let storeOrigin = "SUPERVISOR_HOME";
if (!process.env.SUPERVISOR_HOME?.trim()) {
  const found = storeFromMcpConfig(process.cwd());
  if (found) {
    process.env.SUPERVISOR_HOME = found.home;
    storeOrigin = `from ${found.file}`;
  } else {
    storeOrigin = "default, no SUPERVISOR_HOME and no .mcp.json above the current directory";
  }
}

// paths.js reads SUPERVISOR_HOME when it is first imported, so the import
// has to come after the detection above.
const { startWebServer } = await import("./web-app.js");
startWebServer({ storeOrigin });
