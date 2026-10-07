// The skill copy that runs at server start: only clients that already have a
// skill directory get it, a second run changes nothing, and a locally edited
// copy is backed up before it is replaced.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tempHome } from "./helpers.js";

const home = await tempHome("supervisor-skill-");
process.env.HOME = home;
process.env.USERPROFILE = home;
const { installSkill, skillRoots, skillSource, syncSkills } = await import("../../src/skill-sync.js");
const source = await readFile(skillSource, "utf8");
const claudeSkill = join(home, ".claude", "skills", "codex-supervisor", "SKILL.md");

test("only a client whose skill directory exists gets the skill", async () => {
  await mkdir(join(home, ".claude", "skills"), { recursive: true });
  const result = await syncSkills();
  assert.deepEqual(result, { installed: ["Claude Code"], updated: [], unchanged: [], failed: [] });
  assert.equal(await readFile(claudeSkill, "utf8"), source);
  assert.equal(existsSync(join(home, ".codex")), false, "a missing client directory is never created");
  assert.equal(existsSync(join(home, ".agents")), false);
});

test("a second run leaves an identical file alone", async () => {
  const result = await syncSkills();
  assert.deepEqual(result.unchanged, ["Claude Code"]);
  assert.deepEqual(result.updated, []);
  const files = await readdir(join(home, ".claude", "skills", "codex-supervisor"));
  assert.deepEqual(files, ["SKILL.md"], "no backup for an unchanged file");
});

test("an edited copy is backed up and brought back to the bundled text", async () => {
  await writeFile(claudeSkill, "locally edited\n");
  const result = await syncSkills();
  assert.deepEqual(result.updated, ["Claude Code"]);
  assert.equal(await readFile(claudeSkill, "utf8"), source);
  const files = await readdir(join(home, ".claude", "skills", "codex-supervisor"));
  const backup = files.find((name) => name.startsWith("SKILL.md.bak-"));
  assert.ok(backup, `backup expected, got ${files.join(", ")}`);
  assert.equal(await readFile(join(home, ".claude", "skills", "codex-supervisor", backup), "utf8"), "locally edited\n");
});

test("a client that cannot be written is reported, the others still succeed", async () => {
  await mkdir(join(home, ".codex", "skills"), { recursive: true });
  // A file where the skill directory should go makes mkdir fail for Codex only.
  await writeFile(join(home, ".codex", "skills", "codex-supervisor"), "not a directory");
  const result = await syncSkills();
  assert.deepEqual(result.unchanged, ["Claude Code"]);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0], /^Codex: /);
});

test("installSkill with force overwrites without a backup", async () => {
  const client = skillRoots().claude;
  await writeFile(claudeSkill, "edited again\n");
  const before = (await readdir(join(home, ".claude", "skills", "codex-supervisor"))).length;
  assert.equal(await installSkill(client, { force: true }), "updated");
  const after = (await readdir(join(home, ".claude", "skills", "codex-supervisor"))).length;
  assert.equal(after, before, "force must not add a backup");
  assert.equal(await readFile(claudeSkill, "utf8"), source);
});
