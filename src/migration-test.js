// Builds a v1 database from scratch (progress phases stored in the status
// column, phase NOT NULL) and proves the v2 migration keeps every row and
// reinterprets the old values.
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const here = dirname(fileURLToPath(import.meta.url));
const home = await mkdtemp(join(tmpdir(), "supervisor-migration-"));
await mkdir(join(home, "data"), { recursive: true });
const dbFile = join(home, "data", "supervisor.sqlite");

const V1_SCHEMA = `
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY, title TEXT, worker TEXT NOT NULL, status TEXT NOT NULL,
    phase TEXT NOT NULL, cwd TEXT NOT NULL, project_root TEXT NOT NULL, sandbox TEXT NOT NULL,
    model TEXT, reasoning_effort TEXT NOT NULL DEFAULT 'high',
    skip_git_repo_check INTEGER NOT NULL DEFAULT 1, prompt TEXT NOT NULL,
    changed_files TEXT NOT NULL DEFAULT '[]', commands TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, started_at TEXT, completed_at TEXT,
    pid INTEGER, exit_code INTEGER, signal TEXT, stderr_tail TEXT, last_event_at TEXT,
    last_event_type TEXT, last_message TEXT, current_action TEXT, current_command TEXT,
    error TEXT, followup_of TEXT, worktree_path TEXT, run_log TEXT NOT NULL
  );
  CREATE TABLE task_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, seq INTEGER NOT NULL,
    created_at TEXT NOT NULL, event_type TEXT NOT NULL, payload TEXT NOT NULL
  );
`;

// Every status v1 could produce, plus the phase that accompanied it.
const LEGACY_ROWS = [
  ["old-queued", "queued", "queued"],
  ["old-running", "running", "starting"],
  ["old-editing", "editing", "editing"],
  ["old-command", "command", "command"],
  ["old-command-completed", "command_completed", "command_completed"],
  ["old-reporting", "reporting", "reporting"],
  ["old-completed", "completed", "completed"],
  ["old-failed", "failed", "failed"],
  ["old-cancelled", "cancelled", "cancelled"]
];

const seed = new DatabaseSync(dbFile);
seed.exec(V1_SCHEMA);
const insert = seed.prepare(`
  INSERT INTO tasks (id, title, worker, status, phase, cwd, project_root, sandbox, prompt,
                     created_at, updated_at, changed_files, commands, run_log, followup_of)
  VALUES (?, ?, 'codex', ?, ?, '/repo', '/repo', 'workspace-write', 'do a thing',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ?, ?, '/tmp/run.jsonl', ?)
`);
for (const [id, status, phase] of LEGACY_ROWS) {
  const parent = id === "old-running" ? "old-queued" : null;
  insert.run(id, id, status, phase, JSON.stringify([`${id}.ts`]), JSON.stringify([{ command: "ls" }]), parent);
}
seed.prepare("INSERT INTO task_events (task_id, seq, created_at, event_type, payload) VALUES (?, 1, '2026-01-01T00:00:00.000Z', 'thread.started', ?)").run(
  "old-running",
  JSON.stringify({ type: "thread.started", thread_id: "abc" })
);
seed.close();

process.env.SUPERVISOR_HOME = home;
const { readTasks, readTaskEvents, reconcileDetachedActiveTasks } = await import("./task-store.js");

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL - ${name}\n      ${error.message}`);
  }
}

const tasks = await readTasks();
const byId = new Map(tasks.map((task) => [task.id, task]));

await test("no rows are lost and no columns are dropped", async () => {
  assert.equal(tasks.length, LEGACY_ROWS.length);
  const running = byId.get("old-running");
  assert.equal(running.followup_of, "old-queued", "existing values must survive");
  assert.deepEqual(running.changed_files, ["old-running.ts"]);
  assert.deepEqual(running.commands, [{ command: "ls" }]);
  assert.deepEqual(running.owned_paths, [], "new columns get their defaults");
  assert.deepEqual(running.depends_on, []);
  assert.equal(running.run_count, 0);
  assert.equal(running.thread_id, null);
});

await test("progress phases move out of status and into phase", async () => {
  const expected = [
    ["old-queued", "queued", null],
    ["old-running", "running", "starting"],
    ["old-editing", "running", "editing"],
    ["old-command", "running", "command"],
    ["old-command-completed", "running", "command"],
    ["old-reporting", "running", "reporting"]
  ];
  for (const [id, status, phase] of expected) {
    assert.equal(byId.get(id).status, status, `${id} status`);
    assert.equal(byId.get(id).phase, phase, `${id} phase`);
  }
});

await test("terminal rows carry no phase and keep their status", async () => {
  for (const [id, status] of [["old-completed", "completed"], ["old-failed", "failed"], ["old-cancelled", "cancelled"]]) {
    assert.equal(byId.get(id).status, status);
    assert.equal(byId.get(id).phase, null, `${id} should not carry a phase`);
  }
});

await test("events survive the table rebuild", async () => {
  const events = await readTaskEvents("old-running", 10);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "thread.started");
  assert.equal(events[0].thread_id, "abc");
});

await test("migration is idempotent", async () => {
  const second = await readTasks();
  assert.equal(second.length, LEGACY_ROWS.length);
  assert.equal(second.find((task) => task.id === "old-editing").phase, "editing");
});

// No legacy row has a pid, and every one of them was created months ago, so
// nothing can ever finish them. They are lost - not failed, because no run
// ever reported a failure - and they say so.
await test("an active legacy row that never had a process is reconciled as lost", async () => {
  const reconciles = await reconcileDetachedActiveTasks();
  const activeLegacy = LEGACY_ROWS.filter(([, status]) => !["completed", "failed", "cancelled"].includes(status));
  assert.equal(reconciles.length, activeLegacy.length, "every active legacy row has no pid and is old");
  const after = new Map((await readTasks()).map((task) => [task.id, task]));
  for (const [id] of activeLegacy) {
    assert.equal(after.get(id).status, "lost", `${id} should be lost`);
    assert.equal(after.get(id).phase, null, `${id} should carry no phase once lost`);
    assert.match(after.get(id).error, /never recorded|no process was ever recorded/, `${id} must say why`);
  }
  for (const [id, status] of [["old-completed", "completed"], ["old-failed", "failed"], ["old-cancelled", "cancelled"]]) {
    assert.equal(after.get(id).status, status, `${id} must keep its terminal status`);
  }
  assert.equal((await reconcileDetachedActiveTasks()).length, 0, "a second pass finds nothing left to reconcile");
});

console.log(`\nmigration: ${failures === 0 ? "passed" : `${failures} failed`}  (db: ${dbFile})`);
process.exit(failures === 0 ? 0 : 1);
