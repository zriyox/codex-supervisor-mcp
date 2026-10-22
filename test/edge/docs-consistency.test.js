import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { repoRoot } from "./helpers.js";

const read = (path) => readFile(join(repoRoot, path), "utf8");

function registeredTools(source) {
  return [...source.matchAll(/register(?:Tool|\()\s*\(?\s*"([a-z][a-z0-9_]+)"/g)].map((match) => match[1]);
}

function documentedTools(markdown, heading, end) {
  const start = markdown.indexOf(heading);
  const stop = markdown.indexOf(end, start);
  assert.ok(start >= 0 && stop > start, `missing documentation section ${heading}`);
  return [...markdown.slice(start, stop).matchAll(/^\| `([^`]+)`/gm)].map((match) => match[1]);
}

test("both READMEs document every registered MCP tool", async () => {
  const [source, zh, en] = await Promise.all([
    read("src/mcp-server.js"),
    read("README.md"),
    read("README.en.md")
  ]);
  const registered = registeredTools(source).sort();
  const chinese = documentedTools(zh, "## 工具", "## 和 Claude Code").sort();
  const english = documentedTools(en, "## Tools", "## How this differs").sort();
  assert.equal(registered.length, 39);
  assert.deepEqual(chinese, registered);
  assert.deepEqual(english, registered);
  assert.match(zh.slice(zh.indexOf("## 工具"), zh.indexOf("## 和 Claude Code")), /39 个/);
  assert.match(en.slice(en.indexOf("## Tools"), en.indexOf("## How this differs")), /Thirty-nine/);
});

test("the core dispatch and recovery contract stays visible in the skill", async () => {
  const skill = await read("skills/codex-supervisor/SKILL.md");
  for (const required of [
    "workspace_setup_required",
    "CODEX_SUPERVISOR_ACCEPTANCE_CLI",
    "preflight_id",
    "invalid_report",
    "commitMessage",
    "includeFollowupParents",
    "ActiveTurnOutputSchemaMismatch",
    "worker 不 push",
    "danger-full-access"
  ]) assert.match(skill, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), required);
  assert.doesNotMatch(skill, /git commit --amend|amend 进原来那个提交|三者都要各自 push/);
});

test("the READMEs keep the 0.13 contract and remove stale commit workflow", async () => {
  const [zh, en] = await Promise.all([read("README.md"), read("README.en.md")]);
  for (const text of [zh, en]) {
    for (const required of ["workspaceSetup", "preflight_id", "invalid_report", "token_budget", "commitMessage", "includeFollowupParents", "commitMessages", "ActiveTurnOutputSchemaMismatch"]) {
      assert.match(text, new RegExp(required), required);
    }
    assert.doesNotMatch(text, /one worker per step|一个 worker 只做一步|amend(?:ed)? (?:it )?into the same commit|改完 `--amend`/i);
  }
  for (const required of ["emitProgress", "file`, `hunk", "CODEX_SUPERVISOR_HANDOFF_TOKEN_THRESHOLD"]) {
    assert.match(en, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), required);
  }
});
