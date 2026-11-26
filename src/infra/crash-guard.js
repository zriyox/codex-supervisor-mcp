// Last line of defence for a long-lived process. Without it one promise that
// nobody awaited ends the MCP server, and every tool call after that answers
// "Connection closed" with no trace of why.
//
// A rejection nobody handled is written down and the process carries on: the
// state is in the store, not in memory, so the next call is as good as the
// last. A thrown exception is written down and the process exits, because
// after one the stack it interrupted cannot be trusted.
import { appendFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./paths.js";

export const crashLogPath = join(dataDir, "crash.log");
const MAX_BYTES = 1024 * 1024;

function record(role, kind, error) {
  const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
  const line = `${JSON.stringify({ at: new Date().toISOString(), role, pid: process.pid, kind, error: text })}\n`;
  process.stderr.write(`[agent-supervisor] ${role} ${kind}: ${text}\n`);
  try {
    mkdirSync(dataDir, { recursive: true });
    const size = statSync(crashLogPath, { throwIfNoEntry: false })?.size ?? 0;
    if (size > MAX_BYTES) writeFileSync(crashLogPath, line);
    else appendFileSync(crashLogPath, line);
  } catch (writeError) {
    process.stderr.write(`[agent-supervisor] could not write ${crashLogPath}: ${writeError.message}\n`);
  }
}

// role names the process in the log: "mcp-server", "run-host", "web".
//
// exitOnRejection is for the run host, whose state is in memory: the live run,
// the child, the write chains. Kept alive after a rejection it would hold its
// row at "running" for good, where a dead one is found and recovered by pid.
export function installCrashGuard(role, { exitOnRejection = false } = {}) {
  process.on("unhandledRejection", (reason) => {
    record(role, "unhandled_rejection", reason);
    if (exitOnRejection) process.exit(1);
  });
  process.on("uncaughtException", (error) => {
    record(role, "uncaught_exception", error);
    process.exit(1);
  });
}
