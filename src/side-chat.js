// Side questions about a worker, the way Codex's own /btw (/side) does it:
// the worker's thread is forked into a separate session, the question is
// asked there, and the worker's thread is never touched. The fork runs in
// the worker's worktree with a read-only sandbox, so it can read anything on
// disk and change nothing. One side session per worker; the first turn forks,
// later turns resume the fork, "end" deletes the fork.
//
// A turn is streamed to the page as an AI SDK UI message stream (SSE). The
// page is only a viewer: every chunk is also kept on the turn row, so a page
// that left (tab switched, drawer closed, reload) comes back, replays what it
// missed and keeps receiving; a turn nobody watches still runs to the end and
// its answer is there when someone looks. Only an explicit stop kills a turn.
//
// States a page has to handle:
//   worker without thread_id ........ cannot ask
//   no side session ................. first question forks
//   session idle .................... next question resumes the fork
//   turn running, page attached ..... streaming
//   turn running, nobody attached ... attach: replay + tail
//   turn running, other page asked .. attach the same way, or stop it
//   turn finished unwatched ......... answer in the history
//   turn failed / timed out / stopped  error on the turn, session still usable
//   board restarted mid-turn ........ turn marked interrupted
//   session ended ................... fork deleted, history cleared
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { codexHome } from "./paths.js";
import { defaultBinDirs, findBinaryPath, resolveCommand, shimMessage } from "./bin-resolver.js";
import {
  closeSideSession,
  getSideSession,
  insertSideTurn,
  interruptRunningSideTurns,
  openSideSession,
  readSideTurns,
  setSideSessionFork,
  updateSideTurn
} from "./task-store.js";

const CODEX_NPM_ENTRY = { pkg: "@openai/codex", bin: "bin/codex.js" };
const TURN_TIMEOUT_MS = 10 * 60 * 1000;

// What a side question is, said to the fork every time. Without it the fork
// treats the question as a new task: one real fork spent its whole turn
// trying to ssh to a build host from inside the read-only sandbox, probing
// the network, and finally reaching for an MCP tool.
const SIDE_PREAMBLE = `This is a side question about the work you did in this thread, asked from a read-only fork. Rules for this turn:
- Answer from what you already know from this thread. You may read files in the working directory to check.
- The sandbox is read-only and has no network: do not try ssh, curl, builds, tests, package installs or writes; they will fail and waste the turn. MCP tools are disabled here.
- If answering properly needs something you cannot check from here (a remote machine, a running service, a command), say exactly what and stop; do not retry.
- Nothing you do here changes the work. If the work needs changing, say what should change; the main thread will ask the worker itself.
- Be direct and short. Lead with the answer.`;

export function sideQuestionText(question) {
  return `${SIDE_PREAMBLE}\n\nQuestion:\n${question}`;
}

// The fork inherits the worker's MCP servers. A side question must not be
// able to dispatch, resume or cancel anything through them, and a fork that
// waits on a tool it cannot use burns its turn; every server named in the
// Codex config is switched off for the turn. Sub-tables
// ([mcp_servers.x.env]) are not servers and are skipped.
//
// The key path is written bare: `-c mcp_servers.name.enabled=false`. A
// quoted name (`mcp_servers."name".enabled`) is taken by codex as a new
// server literally called "name", quotes included, with no transport, and
// the whole config then fails to load.
export function sideTurnConfigArgs(configText) {
  const names = new Set();
  for (const line of String(configText ?? "").split("\n")) {
    const match = line.match(/^\s*\[mcp_servers\.(?:"([^"]+)"|([^\].]+))\]\s*(?:#.*)?$/);
    if (match) names.add(match[1] ?? match[2]);
  }
  const args = [];
  for (const name of names) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) continue; // a name codex cannot take bare on the command line
    args.push("-c", `mcp_servers.${name}.enabled=false`);
  }
  return args;
}

function codexConfigText() {
  try {
    return readFileSync(join(codexHome, "config.toml"), "utf8");
  } catch {
    return "";
  }
}

// The session to ask on. A fork taken before the worker was resumed no
// longer reflects the worker's thread; it is dropped and a new one taken
// from the current thread. `fresh` forces that. Returns the session and why
// it was (re)opened: "requested", "worker_resumed", "first" or null.
export async function prepareSideSession(task, { fresh = false } = {}) {
  let session = await getSideSession(task.id);
  let refreshed = null;
  const stale =
    session?.fork_thread_id &&
    session.worker_run_count !== null &&
    session.worker_run_count !== undefined &&
    (task.run_count ?? 0) > session.worker_run_count;
  if (session && (fresh || stale)) {
    await endSideSession(task.id);
    session = null;
    refreshed = fresh ? "requested" : "worker_resumed";
  }
  if (!session) {
    session = await openSideSession(task.id, task.run_count ?? 0);
    refreshed = refreshed ?? "first";
  }
  return { session, refreshed };
}
const OUTPUT_CLIP = 4000;

// taskId -> { turnId, child, chunks, watchers: Set<res>, startedAt, question, state }
const running = new Map();

let swept = false;
async function sweepOnce() {
  if (swept) return;
  swept = true;
  await interruptRunningSideTurns();
}

function codexTarget() {
  const configured = process.env.CODEX_BIN?.trim();
  const located = configured ? configured : (findBinaryPath("codex", { extraDirs: defaultBinDirs() }) ?? "codex");
  const target = resolveCommand(located, { npmEntry: CODEX_NPM_ENTRY });
  if (target.shim) return { error: shimMessage("codex", target.cmd, "CODEX_BIN") };
  return { cmd: target.cmd, prefixArgs: target.prefixArgs };
}

// Stop a side turn and everything under it. On Windows the direct child is
// the JS wrapper around the native Codex binary; killing the wrapper alone
// leaves the real CLI running, so the whole tree goes through taskkill.
function killTree(child) {
  if (process.platform === "win32" && child.pid) {
    try {
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", timeout: 5000, windowsHide: true });
      return;
    } catch {
      // fall back to the handle below
    }
  }
  child.kill("SIGTERM");
}

function clip(text, max = OUTPUT_CLIP) {
  if (typeof text !== "string") return text ?? null;
  return text.length <= max ? text : `${text.slice(0, max)}\n…(${text.length - max} more characters)`;
}

// ---- Codex event -> UI message stream chunks

function chunksFor(event, state) {
  const item = event.item ?? {};
  const out = [];
  switch (event.type) {
    case "thread.started":
      if (event.thread_id) out.push({ type: "data-session", data: { fork_thread_id: event.thread_id } });
      break;
    case "turn.started":
      out.push({ type: "start-step" });
      break;
    case "item.started":
    case "item.updated":
      if (item.type === "command_execution" && !state.toolsSeen.has(item.id)) {
        state.toolsSeen.add(item.id);
        out.push({ type: "tool-input-available", toolCallId: item.id, toolName: "shell", input: { command: item.command ?? "" } });
      }
      break;
    case "item.completed":
      switch (item.type) {
        case "reasoning": {
          const id = `r-${item.id}`;
          out.push({ type: "reasoning-start", id }, { type: "reasoning-delta", id, delta: item.text ?? "" }, { type: "reasoning-end", id });
          break;
        }
        case "agent_message": {
          const id = `t-${item.id}`;
          out.push({ type: "text-start", id }, { type: "text-delta", id, delta: item.text ?? "" }, { type: "text-end", id });
          break;
        }
        case "command_execution":
          if (!state.toolsSeen.has(item.id)) {
            state.toolsSeen.add(item.id);
            out.push({ type: "tool-input-available", toolCallId: item.id, toolName: "shell", input: { command: item.command ?? "" } });
          }
          out.push({
            type: "tool-output-available",
            toolCallId: item.id,
            output: { exit_code: item.exit_code ?? null, status: item.status ?? null, output: clip(item.aggregated_output ?? "") }
          });
          break;
        case "file_change":
          out.push(
            { type: "tool-input-available", toolCallId: item.id, toolName: "edit", input: { changes: item.changes ?? [] } },
            { type: "tool-output-available", toolCallId: item.id, output: { status: item.status ?? "completed" } }
          );
          break;
        case "web_search":
        case "mcp_tool_call":
          out.push(
            { type: "tool-input-available", toolCallId: item.id, toolName: item.type, input: { ...item, id: undefined, type: undefined } },
            { type: "tool-output-available", toolCallId: item.id, output: { status: item.status ?? "completed" } }
          );
          break;
        case "error":
          // Startup notices (unknown config keys, missing model metadata) come
          // through as error items. They are not the answer failing.
          out.push({ type: "data-notice", data: { message: item.message ?? item.text ?? "" } });
          break;
        default:
          break;
      }
      break;
    case "turn.completed":
      out.push({ type: "finish-step" });
      if (event.usage) {
        out.push({ type: "data-usage", data: event.usage });
        state.usage = event.usage;
      }
      state.completed = true;
      break;
    case "turn.failed":
      out.push({ type: "error", errorText: event.error?.message ?? event.error ?? event.message ?? "Codex turn failed" });
      state.failed = true;
      break;
    case "error":
      out.push({ type: "data-notice", data: { message: event.message ?? event.error ?? "" } });
      break;
    default:
      break;
  }
  return out;
}

// ---- stream plumbing

function sseHead(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-vercel-ai-ui-message-stream": "v1",
    "x-accel-buffering": "no"
  });
}

function writeChunk(res, chunk) {
  if (!res.writableEnded) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

function endStream(res) {
  if (!res.writableEnded) res.end("data: [DONE]\n\n");
}

// Chunks of a turn, assembled into the UIMessage parts the page shows for a
// finished (or interrupted) turn. The page rebuilds history from this.
export function partsFromChunks(chunks) {
  const parts = [];
  const open = new Map(); // id -> part for text / reasoning
  const tools = new Map(); // toolCallId -> part
  for (const c of chunks) {
    switch (c.type) {
      case "text-start":
        open.set(c.id, { type: "text", text: "", state: "streaming" });
        parts.push(open.get(c.id));
        break;
      case "text-delta":
        if (open.has(c.id)) open.get(c.id).text += c.delta ?? "";
        break;
      case "text-end":
        if (open.has(c.id)) open.get(c.id).state = "done";
        break;
      case "reasoning-start":
        open.set(c.id, { type: "reasoning", text: "", state: "streaming" });
        parts.push(open.get(c.id));
        break;
      case "reasoning-delta":
        if (open.has(c.id)) open.get(c.id).text += c.delta ?? "";
        break;
      case "reasoning-end":
        if (open.has(c.id)) open.get(c.id).state = "done";
        break;
      case "tool-input-available": {
        const part = { type: `tool-${c.toolName}`, toolCallId: c.toolCallId, state: "input-available", input: c.input };
        tools.set(c.toolCallId, part);
        parts.push(part);
        break;
      }
      case "tool-output-available":
        if (tools.has(c.toolCallId)) {
          tools.get(c.toolCallId).state = "output-available";
          tools.get(c.toolCallId).output = c.output;
        }
        break;
      case "data-notice":
      case "data-usage":
      case "data-session":
        parts.push({ type: c.type, data: c.data });
        break;
      default:
        break;
    }
  }
  return parts;
}

// ---- public API

export async function sideSessionState(taskId) {
  await sweepOnce();
  const session = await getSideSession(taskId);
  const live = running.get(taskId) ?? null;
  const turns = (await readSideTurns(taskId)).map((t) => ({
    id: t.id,
    question: t.question,
    status: t.status,
    started_at: t.started_at,
    ended_at: t.ended_at,
    usage: t.usage,
    error: t.error,
    parts: partsFromChunks(t.chunks)
  }));
  return {
    active: Boolean(session),
    fork_thread_id: session?.fork_thread_id ?? null,
    busy: Boolean(live),
    busy_since: live?.startedAt ?? null,
    busy_turn_id: live?.turnId ?? null,
    watchers: live ? live.watchers.size : 0,
    turns
  };
}

// Attach a page to the running turn: replay what it has produced so far,
// then keep it in the audience. 204 when nothing is running.
export function attachToTurn(taskId, res) {
  const live = running.get(taskId);
  if (!live) {
    res.writeHead(204);
    res.end();
    return false;
  }
  sseHead(res);
  for (const chunk of live.chunks) writeChunk(res, chunk);
  live.watchers.add(res);
  res.on("close", () => live.watchers.delete(res));
  return true;
}

// Start a turn. `res` (optional) becomes the first watcher. Resolves when the
// turn has ended, however it ended.
export async function runSideTurn({ task, text, res = null, fresh = false }) {
  await sweepOnce();
  if (!task.thread_id) throw Object.assign(new Error("this worker recorded no thread_id, so there is no Codex thread to fork"), { code: "no_thread" });
  if (running.has(task.id)) throw Object.assign(new Error("a side turn is already running for this worker"), { code: "busy" });
  const target = codexTarget();
  if (target.error) throw Object.assign(new Error(target.error), { code: "codex_missing" });

  const { session, refreshed } = await prepareSideSession(task, { fresh });

  const args = session.fork_thread_id
    ? ["exec", "resume", "--json", "--skip-git-repo-check", "-c", 'sandbox_mode="read-only"']
    : ["exec", "fork", "--json", "--skip-git-repo-check", "-c", 'sandbox_mode="read-only"'];
  args.push(...sideTurnConfigArgs(codexConfigText()));
  if (task.model) args.push("-m", task.model);
  args.push(session.fork_thread_id ?? task.thread_id, "-");

  const cwd = task.worktree_path || task.project_root || process.cwd();
  const child = spawn(target.cmd, [...target.prefixArgs, ...args], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1" },
    windowsHide: true
  });

  const turnId = `turn-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const startedAt = new Date().toISOString();
  const live = { turnId, child, chunks: [], watchers: new Set(), startedAt, question: text, state: { toolsSeen: new Set(), completed: false, failed: false, usage: null } };
  running.set(task.id, live);
  await insertSideTurn({ id: turnId, task_id: task.id, question: text, status: "running", chunks: [], started_at: startedAt });

  let persistTimer = null;
  const persistSoon = () => {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      updateSideTurn(turnId, { chunks: live.chunks }).catch(() => {});
    }, 250);
  };
  const broadcast = (chunk) => {
    live.chunks.push(chunk);
    for (const w of live.watchers) writeChunk(w, chunk);
    persistSoon();
  };

  if (res) {
    sseHead(res);
    live.watchers.add(res);
    res.on("close", () => live.watchers.delete(res));
  }
  broadcast({ type: "start", messageId: turnId });

  let rest = "";
  let stderr = "";
  let stoppedBy = null;
  const timer = setTimeout(() => {
    stoppedBy = "timeout";
    killTree(child);
  }, TURN_TIMEOUT_MS);
  live.stop = (reason) => {
    stoppedBy = reason;
    killTree(child);
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    rest += chunk;
    let nl;
    while ((nl = rest.indexOf("\n")) !== -1) {
      const line = rest.slice(0, nl).trim();
      rest = rest.slice(nl + 1);
      if (!line) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.type === "thread.started" && !session.fork_thread_id && event.thread_id) {
        session.fork_thread_id = event.thread_id;
        setSideSessionFork(task.id, event.thread_id).catch(() => {});
      }
      for (const part of chunksFor(event, live.state)) broadcast(part);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  child.stdin.on("error", () => {});
  child.stdin.end(sideQuestionText(text));

  return new Promise((resolve) => {
    const finish = async (code, signal) => {
      clearTimeout(timer);
      if (persistTimer) clearTimeout(persistTimer);
      let status = "completed";
      let error = null;
      if (live.state.failed) {
        status = "failed";
        error = live.chunks.find((c) => c.type === "error")?.errorText ?? "Codex turn failed";
      } else if (!live.state.completed) {
        if (stoppedBy === "timeout") {
          status = "timed_out";
          error = `the side turn ran past ${TURN_TIMEOUT_MS / 60000} minutes and was stopped`;
        } else if (stoppedBy) {
          status = "stopped";
          error = "stopped";
        } else {
          status = "failed";
          const tail = stderr.trim().split("\n").filter((l) => !l.includes("rmcp::transport")).slice(-3).join("\n");
          const why = signal ? `stopped by ${signal}` : `codex exited with code ${code}`;
          error = tail ? `${why}: ${tail}` : why;
        }
        broadcast({ type: "error", errorText: error });
      }
      broadcast({ type: "finish" });
      for (const w of live.watchers) endStream(w);
      live.watchers.clear();
      running.delete(task.id);
      await updateSideTurn(turnId, { status, chunks: live.chunks, usage: live.state.usage, error, ended_at: new Date().toISOString() }).catch(() => {});
      resolve({ status, turnId, forkThreadId: session.fork_thread_id, refreshed });
    };
    child.on("error", (error) => {
      stderr += `\nfailed to start codex: ${error.message}`;
      finish(-1, null);
    });
    child.on("exit", finish);
  });
}

// The answer of a turn, as the text parts joined; null while nothing has
// been said yet.
function answerOf(turn) {
  const parts = partsFromChunks(turn.chunks ?? []);
  const text = parts.filter((p) => p.type === "text").map((p) => p.text).join("\n").trim();
  return text || null;
}

function turnView(turn) {
  return {
    turn_id: turn.id,
    question: turn.question,
    status: turn.status,
    answer: answerOf(turn),
    usage: turn.usage ?? null,
    error: turn.error ?? null,
    started_at: turn.started_at ?? null,
    ended_at: turn.ended_at ?? null
  };
}

// The newest side turn of a worker, for a caller that asked earlier and
// comes back for the answer. Null when nothing was ever asked.
export async function latestSideTurn(taskId) {
  await sweepOnce();
  const turns = await readSideTurns(taskId);
  const live = running.get(taskId) ?? null;
  const latest = turns.at(-1) ?? null;
  const session = await getSideSession(taskId);
  if (!latest) return { active: Boolean(session), fork_thread_id: session?.fork_thread_id ?? null, busy: Boolean(live), turn: null };
  const view = turnView(latest);
  if (live && live.turnId === latest.id) {
    view.status = "running";
    view.answer = answerOf({ chunks: live.chunks });
  }
  return { active: Boolean(session), fork_thread_id: session?.fork_thread_id ?? null, busy: Boolean(live), turn: view };
}

// Ask the worker a question on the side, without touching its own thread,
// and wait up to `timeoutMs` for the answer. A turn that outlives the budget
// keeps running in this process; the caller reads it back with latestSideTurn.
export async function askWorker({ task, question, timeoutMs = 110000, fresh = false }) {
  // Decided here, before the race, so a turn that outruns the budget still
  // reports whether the fork was taken anew.
  const { refreshed } = await prepareSideSession(task, { fresh });
  const turn = runSideTurn({ task, text: question });
  // runSideTurn throws synchronously-ish (rejected promise) for no_thread,
  // busy and codex_missing before anything starts; surface those as-is.
  let timer;
  const budget = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });
  try {
    const outcome = await Promise.race([turn.then((r) => ({ timedOut: false, ...r })), budget]);
    if (!outcome.timedOut) {
      const state = await latestSideTurn(task.id);
      return { ...state, timed_out: false, refreshed };
    }
    turn.catch(() => {});
    const state = await latestSideTurn(task.id);
    return { ...state, timed_out: true, refreshed };
  } finally {
    clearTimeout(timer);
  }
}

export function stopSideTurn(taskId) {
  const live = running.get(taskId);
  if (!live) return { stopped: false };
  live.stop("user");
  return { stopped: true, turn_id: live.turnId };
}

// Close the side session: stop a running turn, delete the fork so it does
// not pile up in Codex's session list, forget the history.
export async function endSideSession(taskId) {
  const live = running.get(taskId);
  if (live) live.stop("ended");
  const row = await closeSideSession(taskId);
  if (!row) return { ended: false };
  let deleted = false;
  if (row.fork_thread_id) {
    const target = codexTarget();
    if (!target.error) {
      deleted = await new Promise((resolve) => {
        // --force: without a terminal codex asks for confirmation and exits.
        const child = spawn(target.cmd, [...target.prefixArgs, "delete", "--force", row.fork_thread_id], { stdio: "ignore", windowsHide: true, env: { ...process.env, NO_COLOR: "1" } });
        const t = setTimeout(() => { killTree(child); resolve(false); }, 15000);
        child.on("exit", (code) => { clearTimeout(t); resolve(code === 0); });
        child.on("error", () => { clearTimeout(t); resolve(false); });
      });
    }
  }
  return { ended: true, fork_thread_id: row.fork_thread_id, deleted };
}
