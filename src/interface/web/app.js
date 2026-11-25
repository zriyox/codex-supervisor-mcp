// The board's HTTP server: a thin read-only view over the supervisor store.
// Which sessions exist, what each one is doing right now, what every Codex
// thread under a session has done. It reads the same SQLite file the MCP
// server writes and never writes to it, apart from the same orphan
// reconcile every read does. web-server.js is the entry that decides which
// store to open and then calls startWebServer().
import "../../app/compose.js";
import { attachToTurn, endSideSession, runSideTurn, sideSessionState, stopSideTurn } from "../../app/side-chat.js";
import { supervisorRoot } from "../../infra/paths.js";
import { getTask } from "../../infra/store/tasks.js";
import { checkForUpdate } from "../../infra/update/update-check.js";
import { events, overview, pageParams, session, worker } from "./views.js";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const distDir = resolve(here, "..", "..", "..", "web", "dist");
const port = Number(process.env.SUPERVISOR_WEB_PORT ?? 7877);
const host = process.env.SUPERVISOR_WEB_HOST ?? "127.0.0.1";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

// Read a JSON request body, capped so a stray client cannot fill memory.
function readJson(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("request body too large"), { code: "too_large" }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text.trim()) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (error) {
        reject(Object.assign(new Error(`invalid JSON body: ${error.message}`), { code: "bad_json" }));
      }
    });
    req.on("error", reject);
  });
}

// The last user message of an AI SDK useChat request, as plain text.
function lastUserText(body) {
  if (typeof body?.text === "string") return body.text;
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    const parts = Array.isArray(m.parts) ? m.parts : [];
    const text = parts.filter((p) => p?.type === "text").map((p) => p.text ?? "").join("\n").trim();
    if (text) return text;
    if (typeof m.content === "string" && m.content.trim()) return m.content.trim();
  }
  return "";
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(text)
  });
  res.end(text);
}

function serveStatic(res, pathname) {
  if (!existsSync(distDir)) {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    res.end("web/dist is missing. Run `npm run web:build` first.\n");
    return;
  }
  const safe = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  let file = join(distDir, safe);
  if (!file.startsWith(distDir)) {
    res.writeHead(403);
    res.end();
    return;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(distDir, "index.html");
  const type = MIME[extname(file)] ?? "application/octet-stream";
  res.writeHead(200, {
    "content-type": type,
    "cache-control": file.endsWith("index.html") ? "no-store" : "public, max-age=31536000, immutable"
  });
  createReadStream(file).pipe(res);
}

const LOOPBACK_NAMES = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

// A page on another site can send a POST here without a CORS preflight, and a
// rebound DNS name can make its origin look local. A browser request that
// changes something must come from the board's own origin, and when the board
// listens on loopback that origin must be a loopback name. Clients that send
// no Origin (curl, the tests) are not browsers and are let through.
function crossSiteRefusal(req) {
  if (req.method === "GET" || req.method === "HEAD") return null;
  const origin = req.headers.origin;
  if (!origin) return null;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return "the Origin header is not a URL";
  }
  if (parsed.host !== req.headers.host) return "the request comes from another origin";
  if (LOOPBACK_NAMES.has(host) && !LOOPBACK_NAMES.has(parsed.hostname)) return "the board listens on loopback and the origin is not a loopback name";
  return null;
}

async function route(req, res) {
  const url = new URL(req.url ?? "/", `http://${host}`);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "api") return serveStatic(res, url.pathname);
  const refusal = crossSiteRefusal(req);
  if (refusal) return json(res, 403, { error: "cross_origin_refused", message: refusal });

  // The side chat is the one place the board does something: it forks the
  // worker's Codex thread for a read-only side question.
  if (parts[1] === "workers" && parts.length >= 4 && parts[3] === "chat") {
    const taskId = decodeURIComponent(parts[2]);
    const task = await getTask(taskId);
    if (!task) return json(res, 404, { error: "task_not_found" });
    const action = parts[4] ?? null;
    // GET .../chat/<chatId>/stream is what the AI SDK client calls to
    // resume: replay the running turn, or 204 when nothing is running.
    if (req.method === "GET" && parts.length === 6 && parts[5] === "stream") {
      attachToTurn(taskId, res);
      return undefined;
    }
    if (req.method === "GET" && !action) return json(res, 200, { task_id: taskId, can_ask: Boolean(task.thread_id), worker_status: task.status, ...(await sideSessionState(taskId)) });
    if (req.method === "DELETE" && !action) return json(res, 200, { task_id: taskId, ...(await endSideSession(taskId)) });
    if (req.method === "POST" && action === "stop") return json(res, 200, { task_id: taskId, ...stopSideTurn(taskId) });
    if (req.method === "POST" && !action) {
      let body;
      try {
        body = await readJson(req);
      } catch (error) {
        return json(res, 400, { error: error.code ?? "bad_request", message: error.message });
      }
      const text = lastUserText(body);
      if (!text) return json(res, 400, { error: "empty_question", message: "send a user message with text" });
      try {
        await runSideTurn({ task, text, res });
      } catch (error) {
        if (res.headersSent) return undefined;
        const status = error.code === "busy" ? 409 : error.code === "no_thread" ? 400 : error.code === "codex_missing" ? 503 : 500;
        return json(res, status, { error: error.code ?? "side_chat_failed", message: error.message });
      }
      return undefined;
    }
    return json(res, 405, { error: "method_not_allowed" });
  }

  if (req.method !== "GET") return json(res, 405, { error: "method_not_allowed" });

  if (parts[1] === "overview" && parts.length === 2) return json(res, 200, await overview(pageParams(url, 20)));
  if (parts[1] === "version" && parts.length === 2) {
    return json(res, 200, await checkForUpdate({ force: url.searchParams.get("force") === "1" }));
  }
  if (parts[1] === "sessions" && parts.length === 3) {
    const body = await session(decodeURIComponent(parts[2]), pageParams(url, 40));
    return body ? json(res, 200, body) : json(res, 404, { error: "session_not_found" });
  }
  if (parts[1] === "workers" && parts.length === 3) {
    const body = await worker(decodeURIComponent(parts[2]));
    return body ? json(res, 200, body) : json(res, 404, { error: "task_not_found" });
  }
  if (parts[1] === "workers" && parts.length === 4 && parts[3] === "events") {
    const taskId = decodeURIComponent(parts[2]);
    if (!(await getTask(taskId))) return json(res, 404, { error: "task_not_found" });
    return json(res, 200, await events(taskId, url));
  }
  return json(res, 404, { error: "not_found" });
}

export function startWebServer({ storeOrigin = "default" } = {}) {
  const server = createServer((req, res) => {
    route(req, res).catch((error) => {
      process.stderr.write(`[codex-supervisor-web] ${error.stack ?? error.message}\n`);
      if (!res.headersSent) json(res, 500, { error: "internal", message: error.message });
      else res.end();
    });
  });

  // A taken port is the one error a person will actually hit, usually because
  // a board is already running. Say that, not a stack trace.
  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      process.stderr.write(
        `codex-supervisor-web: port ${port} on ${host} is already in use.\n` +
          `  A board may already be running at http://${host}:${port}\n` +
          `  To run a second one, pick another port: SUPERVISOR_WEB_PORT=8080 codex-supervisor-web\n`
      );
      process.exit(1);
    }
    process.stderr.write(`codex-supervisor-web: ${error.message}\n`);
    process.exit(1);
  });

  server.listen(port, host, () => {
    const boundPort = server.address().port;
    process.stdout.write(`codex-supervisor web view on http://${host}:${boundPort}\n  store: ${supervisorRoot}  (${storeOrigin})\n`);
  });
  return server;
}
