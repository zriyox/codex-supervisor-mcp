// Coverage for the skill installer: fresh install, idempotency, backup before
// overwrite, dry-run, target filtering, and the postinstall guard.
//
// Only the skill half is exercised here because it is pure filesystem work.
// Registering the MCP shells out to the `claude` and `codex` CLIs, so that path
// is verified manually rather than in this deterministic suite.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const setupPath = fileURLToPath(new URL("./setup.js", import.meta.url));
const sourceSkill = await readFile(
  fileURLToPath(new URL("../skills/codex-supervisor/SKILL.md", import.meta.url)),
  "utf8"
);

let passed = 0;
let skipped = 0;
async function check(name, fn) {
  if ((await fn()) === "skip") {
    skipped += 1;
    console.log(`skip - ${name}`);
    return;
  }
  passed += 1;
  console.log(`ok - ${name}`);
}

async function makeHome(layout = ["claude", "codex"]) {
  const home = await mkdtemp(join(tmpdir(), "supervisor-setup-"));
  for (const dir of layout) {
    // setup.js treats a client as present when its binary is on PATH or its
    // skill directory already exists. Creating the directory is what makes
    // this suite deterministic: a CI runner has neither claude nor codex, so
    // detection must not depend on the machine's PATH.
    await mkdir(join(home, `.${dir}`, "skills"), { recursive: true });
  }
  return home;
}

function runSetup(home, args = [], env = {}) {
  return run(process.execPath, [setupPath, ...args], {
    // USERPROFILE is what Windows reads; HOME covers macOS and Linux.
    env: { ...process.env, HOME: home, USERPROFILE: home, npm_config_global: "false", ...env }
  });
}

const skillAt = (home, client) => join(home, `.${client}`, "skills", "codex-supervisor", "SKILL.md");

await check("a fresh run installs the skill into every present client", async () => {
  const home = await makeHome();
  await runSetup(home, ["--skill-only"]);
  for (const client of ["claude", "codex"]) {
    assert.equal(await readFile(skillAt(home, client), "utf8"), sourceSkill, `${client} skill content`);
  }
  assert.equal(existsSync(join(home, ".claude.json")), false, "must not create client config");
});

await check("a second run is idempotent and leaves no backup", async () => {
  const home = await makeHome();
  await runSetup(home, ["--skill-only"]);
  await runSetup(home, ["--skill-only"]);
  const dir = join(home, ".claude", "skills", "codex-supervisor");
  assert.deepEqual((await readdir(dir)).sort(), ["SKILL.md"]);
});

await check("a locally modified skill is backed up before being overwritten", async () => {
  const home = await makeHome();
  await runSetup(home, ["--skill-only"]);
  await writeFile(skillAt(home, "claude"), "locally edited\n");
  await runSetup(home, ["--skill-only"]);
  const dir = join(home, ".claude", "skills", "codex-supervisor");
  const files = (await readdir(dir)).sort();
  assert.equal(files.length, 2, `expected a backup file, got ${files.join(", ")}`);
  assert.match(files.find((name) => name.startsWith("SKILL.md.bak-")) ?? "", /^SKILL\.md\.bak-\d+$/);
  assert.equal(await readFile(skillAt(home, "claude"), "utf8"), sourceSkill);
});

await check("--force overwrites without keeping a backup", async () => {
  const home = await makeHome();
  await runSetup(home, ["--skill-only"]);
  await writeFile(skillAt(home, "claude"), "locally edited\n");
  await runSetup(home, ["--skill-only", "--force"]);
  const dir = join(home, ".claude", "skills", "codex-supervisor");
  assert.deepEqual((await readdir(dir)).sort(), ["SKILL.md"]);
});

await check("--dry-run reports work without writing anything", async () => {
  const home = await makeHome();
  const { stdout } = await runSetup(home, ["--skill-only", "--dry-run"]);
  assert.match(stdout, /would install/);
  assert.equal(existsSync(join(home, ".claude", "skills", "codex-supervisor")), false);
});

await check("--target only touches the named client", async () => {
  const home = await makeHome();
  await runSetup(home, ["--skill-only", "--target", "claude"]);
  assert.equal(existsSync(skillAt(home, "claude")), true);
  assert.equal(existsSync(skillAt(home, "codex")), false);
});

await check("--auto stays silent unless the install is global", async () => {
  const nonGlobal = await makeHome();
  await runSetup(nonGlobal, ["--auto"], { npm_config_global: "false" });
  assert.equal(existsSync(join(nonGlobal, ".claude", "skills", "codex-supervisor")), false);

  const global = await makeHome();
  await runSetup(global, ["--auto", "--skill-only"], { npm_config_global: "true" });
  assert.equal(existsSync(skillAt(global, "claude")), true);
});

await check("CODEX_SUPERVISOR_SKIP_SETUP opts the automatic run out", async () => {
  const home = await makeHome();
  await runSetup(home, ["--auto", "--skill-only"], {
    npm_config_global: "true",
    CODEX_SUPERVISOR_SKIP_SETUP: "1"
  });
  assert.equal(existsSync(join(home, ".claude", "skills", "codex-supervisor")), false);
});

await check("a client missing from PATH is still found via its global bin directory", async () => {
  if (process.platform === "win32") {
    // This form plants a POSIX shebang script with no extension, which Windows
    // cannot see at all. The Windows shape of the same check - a codex.cmd
    // beside the npm entry it wraps - lives in setup-windows-test.js.
    return "skip";
  }
  const home = await makeHome(["codex"]);
  const binDir = join(home, ".npm-global", "bin");
  await mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  const { stdout } = await runSetup(home, ["--mcp-only", "--target", "codex"], {
    PATH: "/usr/bin:/bin"
  });
  assert.match(stdout, /already registered/, "expected the off-PATH binary to be detected");
});

await check("an unknown argument fails a manual run but not an automatic one", async () => {
  const home = await makeHome();
  await assert.rejects(runSetup(home, ["--nope"]), /Unknown argument/);
  await runSetup(home, ["--nope", "--auto"]);
});

console.log(`\n${passed} setup checks passed${skipped ? `, ${skipped} skipped` : ""}`);
