#!/usr/bin/env node
// Stable entry point. Client registrations store this absolute path, so it stays
// here; the server itself lives in interface/mcp.
import "./interface/mcp/server.js";
