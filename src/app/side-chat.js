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
import { ensureTaskWorktree } from "./restore-worktree.js";
import "./compose.js";
import { answerOf, partsFromChunks, turnView } from "../domain/side-turn-view.js";
import { closeSideSession, getSideSession, insertSideTurn, interruptRunningSideTurns, openSideSession, readSideTurns, setSideSessionFork, updateSideTurn } from "../infra/store/sessions.js";
import { getTask } from "../infra/store/tasks.js";
import { unsupported } from "../runners/contract.js";
import { loadRunner, runnerOf } from "../runners/registry.js";
import { endStream, sseHead, writeChunk } from "./sse.js";
import { randomUUID } from "node:crypto";

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
// A side question runs with none of the user's MCP servers: it only reads.
export function sideTurnConfigArgs(configText, runner = runnerOf(null)) {
  return runner.sideChat.disableMcpServerArgs(configText);
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

// taskId -> { turnId, child, chunks, watchers: Set<res>, startedAt, question, state }
const running = new Map();

let swept = false;
async function sweepOnce() {
  if (swept) return;
  swept = true;
  await interruptRunningSideTurns();
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

function startSideChild(target, task, session) {
  const runner = runnerOf(task);
  const side = runner.sideChat;
  const forkArgs = side.forkArgs({ forkThreadId: session.fork_thread_id, workerThreadId: task.thread_id, model: task.model });
  const args = side.withConfig(forkArgs, sideTurnConfigArgs(side.configText(), runner));
  const cwd = task.worktree_path || task.project_root || process.cwd();
  return runner.start(target, args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1" },
    windowsHide: true
  });
}

// The in-memory side of a running turn: its chunks so far, who is watching,
// and how it was stopped. Chunks are written through to the store in batches.
async function openLiveTurn(task, text, child) {
  const turnId = `turn-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const startedAt = new Date().toISOString();
  const state = { toolsSeen: new Set(), completed: false, failed: false, usage: null };
  const live = { turnId, child, chunks: [], watchers: new Set(), startedAt, question: text, state, stderr: "", stoppedBy: null, persistTimer: null,
    chunksFor: runnerOf(task).sideChat.chunksFor };
  const persistSoon = () => {
    if (live.persistTimer) return;
    live.persistTimer = setTimeout(() => {
      live.persistTimer = null;
      updateSideTurn(turnId, { chunks: live.chunks }).catch(() => {});
    }, 250);
  };
  live.broadcast = (chunk) => {
    live.chunks.push(chunk);
    for (const w of live.watchers) writeChunk(w, chunk);
    persistSoon();
  };
  live.stop = (reason) => {
    live.stoppedBy = reason;
    runnerOf(task).cancelChild(child);
  };
  running.set(task.id, live);
  await insertSideTurn({ id: turnId, task_id: task.id, question: text, status: "running", chunks: [], started_at: startedAt });
  return live;
}

function pipeSideOutput(child, live, session, taskId) {
  let rest = "";
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
        setSideSessionFork(taskId, event.thread_id).catch(() => {});
      }
      for (const part of live.chunksFor(event, live.state)) live.broadcast(part);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    live.stderr = (live.stderr + chunk).slice(-4000);
  });
}

// How the turn ended, and the error to show when it did not complete.
function sideTurnOutcome(live, code, signal) {
  if (live.state.failed) return { status: "failed", error: live.chunks.find((c) => c.type === "error")?.errorText ?? "Codex turn failed", announce: false };
  if (live.state.completed) return { status: "completed", error: null, announce: false };
  if (live.stoppedBy === "timeout") {
    return { status: "timed_out", error: `the side turn ran past ${TURN_TIMEOUT_MS / 60000} minutes and was stopped`, announce: true };
  }
  if (live.stoppedBy) return { status: "stopped", error: "stopped", announce: true };
  const tail = live.stderr.trim().split("\n").filter((l) => !l.includes("rmcp::transport")).slice(-3).join("\n");
  const why = signal ? `stopped by ${signal}` : `codex exited with code ${code}`;
  return { status: "failed", error: tail ? `${why}: ${tail}` : why, announce: true };
}

async function settleSideTurn(live, taskId, code, signal) {
  if (live.persistTimer) clearTimeout(live.persistTimer);
  const { status, error, announce } = sideTurnOutcome(live, code, signal);
  if (announce) live.broadcast({ type: "error", errorText: error });
  live.broadcast({ type: "finish" });
  for (const w of live.watchers) endStream(w);
  live.watchers.clear();
  running.delete(taskId);
  await updateSideTurn(live.turnId, { status, chunks: live.chunks, usage: live.state.usage, error, ended_at: new Date().toISOString() }).catch(() => {});
  return status;
}

// Start a turn. `res` (optional) becomes the first watcher. Resolves when the
// turn has ended, however it ended.
export async function runSideTurn({ task, text, res = null, fresh = false }) {
  await sweepOnce();
  const runner = await loadRunner(task.worker);
  if (!runner.capabilities.side_chat) throw unsupported(runner, "side_chat", "asking a worker a side question");
  if (!task.thread_id) throw Object.assign(new Error("this worker recorded no thread_id, so there is no thread to fork"), { code: "no_thread" });
  if (running.has(task.id)) throw Object.assign(new Error("a side turn is already running for this worker"), { code: "busy" });
  const target = runner.resolveTarget();
  if (target.error) throw Object.assign(new Error(target.error), { code: "codex_missing" });

  const { session, refreshed } = await prepareSideSession(task, { fresh });
  // The fork reads the worker's files; a cleaned-up worktree comes back from its branch.
  await ensureTaskWorktree(task);
  const child = startSideChild(target, task, session);
  const live = await openLiveTurn(task, text, child);
  if (res) {
    sseHead(res);
    live.watchers.add(res);
    res.on("close", () => live.watchers.delete(res));
  }
  live.broadcast({ type: "start", messageId: live.turnId });
  const timer = setTimeout(() => live.stop("timeout"), TURN_TIMEOUT_MS);
  pipeSideOutput(child, live, session, task.id);
  child.stdin.on("error", () => {});
  child.stdin.end(sideQuestionText(text));

  return new Promise((resolve) => {
    const finish = async (code, signal) => {
      clearTimeout(timer);
      const status = await settleSideTurn(live, task.id, code, signal);
      resolve({ status, turnId: live.turnId, forkThreadId: session.fork_thread_id, refreshed });
    };
    child.on("error", (error) => {
      live.stderr += `\nfailed to start codex: ${error.message}`;
      finish(-1, null);
    });
    child.on("exit", finish);
  });
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
    const stored = await getTask(taskId);
    const runner = runnerOf(stored);
    const target = runner.resolveTarget();
    if (!target.error) {
      deleted = await new Promise((resolve) => {
        // --force: without a terminal codex asks for confirmation and exits.
        const child = runner.start(target, runner.sideChat.deleteArgs(row.fork_thread_id), { stdio: "ignore", windowsHide: true, env: { ...process.env, NO_COLOR: "1" } });
        const t = setTimeout(() => { runner.cancelChild(child); resolve(false); }, 15000);
        child.on("exit", (code) => { clearTimeout(t); resolve(code === 0); });
        child.on("error", () => { clearTimeout(t); resolve(false); });
      });
    }
  }
  return { ended: true, fork_thread_id: row.fork_thread_id, deleted };
}
