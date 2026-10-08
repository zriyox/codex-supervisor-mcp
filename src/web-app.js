// The board's HTTP server: a thin read-only view over the supervisor store.
// Which sessions exist, what each one is doing right now, what every Codex
// thread under a session has done. It reads the same SQLite file the MCP
// server writes and never writes to it, apart from the same orphan
// reconcile every read does. web-server.js is the entry that decides which
// store to open and then calls startWebServer().
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getTask,
  listTaskEventKinds,
  readAgentMessages,
  readSessions,
  readTaskEvents,
  readTasks,
  reconcileDetachedActiveTasks
} from "./task-store.js";
import { readNativeGoal } from "./goal-store.js";
import { readTaskChanges } from "./worktree.js";
import { ACTIVE_STATUSES } from "./status.js";
import { supervisorRoot } from "./paths.js";
import { checkForUpdate } from "./update-check.js";
import { attachToTurn, endSideSession, runSideTurn, sideSessionState, stopSideTurn } from "./side-chat.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const distDir = resolve(here, "..", "web", "dist");
const port = Number(process.env.SUPERVISOR_WEB_PORT ?? 7877);
const host = process.env.SUPERVISOR_WEB_HOST ?? "127.0.0.1";
const NO_SESSION = "none";

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

function clip(value, maxChars) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

function durationMs(task) {
  const start = Date.parse(task.started_at ?? task.created_at ?? "");
  if (Number.isNaN(start)) return null;
  const end = Date.parse(task.completed_at ?? "");
  const stop = Number.isNaN(end) ? Date.now() : end;
  return Math.max(0, stop - start);
}

// The row every list shows. No prompt, no raw events: those are per-worker
// reads, so a session with forty threads stays one cheap request.
function workerRow(task) {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    phase: task.phase ?? null,
    session_id: task.session_id ?? null,
    thread_id: task.thread_id ?? null,
    goal: task.goal_objective ?? null,
    goal_status: task.goal_status ?? null,
    model: task.model ?? null,
    sandbox: task.sandbox,
    project_root: task.project_root,
    worktree_path: task.worktree_path ?? null,
    branch: task.worktree_path ? `codex/${task.id}` : null,
    base_commit: task.base_commit ?? null,
    owned_paths: task.owned_paths ?? [],
    depends_on: task.depends_on ?? [],
    followup_of: task.followup_of ?? null,
    resumed_from: task.resumed_from ?? null,
    run_count: task.run_count ?? 0,
    current_action: clip(task.current_action, 300),
    last_message: clip(task.last_message, 400),
    changed_file_count: liveChangeCount(task),
    acceptance: task.acceptance_results?.status ?? null,
    command_count: (task.commands ?? []).length,
    error: task.error ?? null,
    exit_code: task.exit_code ?? null,
    pid: task.pid ?? null,
    created_at: task.created_at || null,
    started_at: task.started_at || null,
    updated_at: task.updated_at || null,
    completed_at: task.completed_at || null,
    duration_ms: durationMs(task)
  };
}

// Changed-file counts for the list. The stored changed_files on a row only
// knows about file_change events; the truth is the worktree diff, which costs
// two git calls per worker. Terminal rows never change again, so their count
// is memoised on (id, updated_at); running rows are re-read every time.
const changeCountCache = new Map();
function liveChangeCount(task) {
  const key = `${task.id}:${task.updated_at}:${task.status}`;
  const cached = changeCountCache.get(key);
  if (cached !== undefined && !ACTIVE_STATUSES.has(task.status)) return cached;
  const count = readTaskChanges(task).length;
  changeCountCache.set(key, count);
  if (changeCountCache.size > 2000) changeCountCache.delete(changeCountCache.keys().next().value);
  return count;
}

function sessionKey(task) {
  return task.session_id || NO_SESSION;
}

function latest(values) {
  return values.filter(Boolean).sort().at(-1) ?? null;
}

// What a session is about. The title the main thread recorded wins; without
// one, the goals of its workers are the next best description.
function aboutSession(meta, tasks) {
  if (meta?.title) return { title: meta.title, note: meta.note ?? null, derived: false };
  const goals = Array.from(new Set(tasks.map((task) => task.goal_objective).filter(Boolean)));
  const summary = goals.slice(0, 3).map((goal) => clip(goal, 60)).join("；");
  return { title: summary || null, note: null, derived: true };
}

function sessionRow(key, tasks, meta = null) {
  const counts = {};
  for (const task of tasks) counts[task.status] = (counts[task.status] ?? 0) + 1;
  const active = tasks.filter((task) => ACTIVE_STATUSES.has(task.status));
  const byActivity = [...tasks].sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")));
  const lastReport = byActivity.find((task) => task.last_message);
  const about = aboutSession(meta, tasks);
  return {
    id: key,
    unsessioned: key === NO_SESSION,
    title: about.title,
    note: about.note,
    title_derived: about.derived,
    worker_count: tasks.length,
    active_count: active.length,
    counts,
    project_roots: Array.from(new Set(tasks.map((task) => task.project_root).filter(Boolean))),
    first_created_at: tasks.map((task) => task.created_at).filter(Boolean).sort()[0] ?? null,
    last_activity_at: latest(tasks.map((task) => task.updated_at)),
    // What the session is doing right now: one line per running thread.
    now: active.map((task) => ({
      id: task.id,
      title: task.title,
      phase: task.phase ?? null,
      current_action: clip(task.current_action, 160)
    })),
    last_report: lastReport
      ? { id: lastReport.id, title: lastReport.title, text: clip(lastReport.last_message, 240), at: lastReport.updated_at }
      : null
  };
}

// Pagination for the lists: `limit` rows after `offset`, newest activity
// first for sessions, dispatch order for workers. The page says whether
// there is more so the board loads the rest as the user scrolls.
function pageParams(url, defaultLimit) {
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? defaultLimit) || defaultLimit));
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
  return { limit, offset };
}

function paginate(items, { limit, offset }) {
  return { items: items.slice(offset, offset + limit), total: items.length, offset, limit, has_more: offset + limit < items.length };
}

async function overview({ limit, offset } = { limit: 20, offset: 0 }) {
  await reconcileDetachedActiveTasks();
  const tasks = await readTasks();
  const metas = new Map((await readSessions()).map((row) => [row.id, row]));
  const groups = new Map();
  for (const task of tasks) {
    const key = sessionKey(task);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(task);
  }
  const sessions = Array.from(groups, ([key, group]) => sessionRow(key, group, metas.get(key) ?? null)).sort((a, b) => {
    if (a.active_count !== b.active_count) return b.active_count - a.active_count;
    return String(b.last_activity_at ?? "").localeCompare(String(a.last_activity_at ?? ""));
  });
  const page = paginate(sessions, { limit, offset });
  return {
    generated_at: new Date().toISOString(),
    store: supervisorRoot,
    total_workers: tasks.length,
    active_workers: tasks.filter((task) => ACTIVE_STATUSES.has(task.status)).length,
    total_sessions: sessions.length,
    offset: page.offset,
    limit: page.limit,
    has_more: page.has_more,
    sessions: page.items
  };
}

async function session(key, { limit, offset } = { limit: 40, offset: 0 }) {
  await reconcileDetachedActiveTasks();
  const tasks = (await readTasks()).filter((task) => sessionKey(task) === key);
  if (tasks.length === 0) return null;
  const meta = (await readSessions()).find((row) => row.id === key) ?? null;
  const ordered = [...tasks].sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));
  const page = paginate(ordered, { limit, offset });
  return {
    ...sessionRow(key, tasks, meta),
    offset: page.offset,
    limit: page.limit,
    has_more: page.has_more,
    workers: page.items.map(workerRow)
  };
}

async function worker(taskId) {
  const task = await getTask(taskId);
  if (!task) return null;
  const reports = await readAgentMessages(taskId, 10);
  // Token spend comes from Codex's own turn.completed usage blocks; one per
  // run, so a resumed worker sums its runs.
  const usage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, turns: 0 };
  for (const event of await readTaskEvents(taskId, 50, ["turn.completed"])) {
    const block = event?.usage ?? {};
    usage.turns += 1;
    for (const key of ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens"]) {
      usage[key] += Number(block[key] ?? 0) || 0;
    }
  }
  const commands = (task.commands ?? []).slice(-40).map((entry) => ({
    ...entry,
    command: clip(entry.command, 600)
  }));
  return {
    ...workerRow(task),
    prompt: task.prompt ?? null,
    changed_files: readTaskChanges(task),
    commands,
    reports: reports.length > 0 ? reports : task.last_message ? [task.last_message] : [],
    native_goal: readNativeGoal(task.thread_id),
    usage,
    notices: task.notices ?? null,
    run_log: task.run_log ?? null,
    event_kinds: await listTaskEventKinds(taskId)
  };
}

async function events(taskId, url) {
  const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit") ?? 150)));
  const kinds = url.searchParams.get("kinds")?.split(",").filter(Boolean) ?? null;
  return { task_id: taskId, events: await readTaskEvents(taskId, limit, kinds) };
}

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

async function route(req, res) {
  const url = new URL(req.url ?? "/", `http://${host}`);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "api") return serveStatic(res, url.pathname);

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
    process.stdout.write(`codex-supervisor web view on http://${host}:${port}\n  store: ${supervisorRoot}  (${storeOrigin})\n`);
  });
  return server;
}
