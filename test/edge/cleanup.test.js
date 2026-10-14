import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { tempHome, makeRepo, withMcp, dispatchArgs, waitFor, git, repoRoot } from "./helpers.js";

test("cleanup removes only clean integrated worktrees and preserves dirty, unlanded and lost work", async () => {
  const home = await tempHome("supervisor-cleanup-");
  const { dir } = await makeRepo(join(home, "repo"));
  const workers = {};
  await withMcp({ SUPERVISOR_HOME: home }, async ({ call }) => {
    for (const title of ["integrated", "dirty", "ignored", "unlanded", "lost"]) {
      const worker = await call("create_codex_worker", dispatchArgs(title, dir, { ownedPaths: [`${title}.txt`] }));
      await waitFor(call, worker.id, (t) => t.status === "completed" && t.exit_code != null);
      workers[title] = worker;
      await writeFile(join(worker.worktree_path, `${title}.txt`), `${title}\n`);
      git(worker.worktree_path, ["add", "-A"]);
      git(worker.worktree_path, ["commit", "-q", "-m", title]);
      if (["integrated", "dirty", "ignored"].includes(title)) {
        const landed = await call("land_codex_worker", { task_id: worker.id });
        assert.ok(!landed.error, JSON.stringify(landed));
      }
    }
  });
  await writeFile(join(workers.dirty.worktree_path, "precious.txt"), "keep this\n");
  const ignorePath = git(workers.ignored.worktree_path, ["rev-parse", "--git-path", "info/exclude"]);
  await writeFile(ignorePath, "precious-artifact.bin\n");
  await writeFile(join(workers.ignored.worktree_path, "precious-artifact.bin"), "keep ignored artifact\n");
  const db = new DatabaseSync(join(home, "data", "supervisor.sqlite"));
  const old = new Date(Date.now() - 30 * 86400000).toISOString();
  db.prepare("UPDATE tasks SET completed_at=?,updated_at=?").run(old, old);
  db.prepare("UPDATE tasks SET status='lost' WHERE id=?").run(workers.lost.id);
  db.close();
  const run = (args) => JSON.parse(execFileSync(process.execPath, [join(repoRoot, "src", "cleanup.js"), "--days", "1", ...args], {
    encoding: "utf8", env: { ...process.env, SUPERVISOR_HOME: home, CODEX_HOME: join(home, "codex") }, timeout: 15000
  }));
  const preview = run(["--dry-run"]);
  assert.deepEqual(preview.candidates, [workers.integrated.id]);
  assert.ok(preview.skipped.some((item) => item.id === workers.dirty.id && /dirty/.test(item.reason)));
  assert.ok(preview.skipped.some((item) => item.id === workers.unlanded.id && /unlanded/.test(item.reason)));
  assert.ok(preview.skipped.some((item) => item.id === workers.lost.id));
  assert.ok(preview.skipped.some((item) => item.id === workers.ignored.id && /ignored/.test(item.reason)));
  assert(existsSync(workers.integrated.worktree_path));
  const applied = run(["--apply"]);
  assert.equal(applied.deleted.tasks, 1);
  assert(!existsSync(workers.integrated.worktree_path));
  for (const title of ["dirty", "ignored", "unlanded", "lost"]) assert(existsSync(workers[title].worktree_path));
  assert.equal(git(dir, ["branch", "--list", `codex/${workers.integrated.id}`]), "");
  const remaining = new DatabaseSync(join(home, "data", "supervisor.sqlite"));
  assert.equal(remaining.prepare("SELECT count(*) AS n FROM tasks").get().n, 4);
  remaining.close();
});
