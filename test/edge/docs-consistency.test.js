import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot, withMcp } from "./helpers.js";

const read = (path) => readFile(join(repoRoot, path), "utf8");

// Ask the running server instead of reading its source: the answer does not
// depend on how the tools are laid out in files.
async function registeredTools() {
  const home = await mkdtemp(join(tmpdir(), "supervisor-docs-"));
  try {
    return await withMcp({ SUPERVISOR_HOME: home, AGENT_SUPERVISOR_SKIP_SKILL_SYNC: "1" }, async ({ client }) => (await client.listTools()).tools.map((tool) => tool.name));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function documentedTools(markdown, heading, end) {
  const start = markdown.indexOf(heading);
  const stop = markdown.indexOf(end, start);
  assert.ok(start >= 0 && stop > start, `missing documentation section ${heading}`);
  return [...markdown.slice(start, stop).matchAll(/^\| `([a-z_]+)`/gm)].map((match) => match[1]);
}

function mentionedTools(markdown, heading, end, registered) {
  const start = markdown.indexOf(heading);
  const stop = markdown.indexOf(end, start);
  assert.ok(start >= 0 && stop > start, `missing documentation section ${heading}`);
  const section = markdown.slice(start, stop);
  return registered.filter((name) => section.includes(`\`${name}\``));
}

test("the default tool set is exactly fourteen and the optional three stay off unless asked for", async () => {
  const home = await mkdtemp(join(tmpdir(), "supervisor-tools-"));
  try {
    const names = async (env) => withMcp({ SUPERVISOR_HOME: home, AGENT_SUPERVISOR_SKIP_SKILL_SYNC: "1", ...env }, async ({ client }) => (await client.listTools()).tools.map((tool) => tool.name));
    const byDefault = await names({ AGENT_SUPERVISOR_TOOLS: "" });
    assert.equal(byDefault.length, 14);
    const all = await names({ AGENT_SUPERVISOR_TOOLS: "all" });
    assert.deepEqual(all.slice(0, 14), byDefault, "the optional tools come after the default ones");
    assert.deepEqual(all.slice(14).sort(), ["facts", "get_artifact", "review"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("both READMEs and both references document every registered MCP tool", async () => {
  const [zh, en, zhRef, enRef] = await Promise.all([
    read("README.md"),
    read("README.en.md"),
    read("docs/reference.md"),
    read("docs/reference.en.md")
  ]);
  const registered = (await registeredTools()).sort();
  assert.equal(registered.length, 17);
  // The READMEs group tools by stage; the references keep one row per tool with its arguments.
  assert.deepEqual(mentionedTools(zh, "## 工具", "## 和 Claude Code", registered), registered);
  assert.deepEqual(mentionedTools(en, "## Tools", "## How this differs", registered), registered);
  assert.deepEqual(documentedTools(zhRef, "## 工具", "分组参数：").sort(), registered);
  assert.deepEqual(documentedTools(enRef, "## Tools", "The grouped arguments:").sort(), registered);
});

test("the skill names every default tool and the rules a main thread must not miss", async () => {
  const skill = await read("skills/agent-supervisor/SKILL.md");
  const home = await mkdtemp(join(tmpdir(), "supervisor-skill-"));
  try {
    const byDefault = await withMcp({ SUPERVISOR_HOME: home, AGENT_SUPERVISOR_TOOLS: "", AGENT_SUPERVISOR_SKIP_SKILL_SYNC: "1" }, async ({ client }) => (await client.listTools()).tools.map((tool) => tool.name));
    for (const name of byDefault) assert.ok(skill.includes(`\`${name}\``), `the skill never mentions ${name}`);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
  for (const required of ["workspace_setup_required", "AGENT_SUPERVISOR_ACCEPTANCE_CLI", "preflight_id", "invalid_report", "commit_message", "include_followup_parents", "allow_long_wait", "worker 不 push", "danger-full-access"]) {
    assert.ok(skill.includes(required), required);
  }
});

test("no document still names a tool or argument that was removed", async () => {
  const removed = /create_codex_worker|land_codex_worker|check_workers|overview_delta|get_worker_result|verify_delivery_push|cleanup_plan|ownedPaths|commitMessage|allowLongWait|CODEX_SUPERVISOR_/;
  for (const path of ["README.md", "README.en.md", "docs/reference.md", "docs/reference.en.md", "skills/agent-supervisor/SKILL.md"]) {
    const hit = (await read(path)).match(removed);
    assert.equal(hit, null, `${path} still says ${hit?.[0]}`);
  }
});
