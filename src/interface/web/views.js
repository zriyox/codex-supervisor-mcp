// What the board shows: session and worker rows built from the store, read-only.
import { branchOf } from "../../domain/worker-branch.js";
import { ACTIVE_STATUSES } from "../../domain/status.js";
import { supervisorRoot } from "../../infra/paths.js";
import { restoreEventBodies } from "../../infra/store/event-body.js";
import { listTaskEventKinds, readAgentMessages, readTaskEvents } from "../../infra/store/events.js";
import { reconcileDetachedActiveTasks } from "../../infra/store/reconcile.js";
import { readSessions } from "../../infra/store/sessions.js";
import { getTask, readTasks } from "../../infra/store/tasks.js";
import { readTaskChanges } from "../../infra/worktree.js";
import { readNativeGoal } from "../../infra/store/runner-readers.js";

const NO_SESSION = "none";

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
    branch: task.worktree_path ? branchOf(task) : null,
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
    landed_at: task.landed_at ?? null,
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
export function pageParams(url, defaultLimit) {
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? defaultLimit) || defaultLimit));
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
  return { limit, offset };
}

function paginate(items, { limit, offset }) {
  return { items: items.slice(offset, offset + limit), total: items.length, offset, limit, has_more: offset + limit < items.length };
}

export async function overview({ limit, offset } = { limit: 20, offset: 0 }) {
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

export async function session(key, { limit, offset } = { limit: 40, offset: 0 }) {
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

export async function worker(taskId) {
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
    native_goal: readNativeGoal(task.thread_id, task.worker),
    usage,
    notices: task.notices ?? null,
    run_log: task.run_log ?? null,
    event_kinds: await listTaskEventKinds(taskId)
  };
}

export async function events(taskId, url) {
  const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit") ?? 150)));
  const kinds = url.searchParams.get("kinds")?.split(",").filter(Boolean) ?? null;
  const task = await getTask(taskId);
  return { task_id: taskId, events: await restoreEventBodies(await readTaskEvents(taskId, limit, kinds), task?.run_log ?? null) };
}
