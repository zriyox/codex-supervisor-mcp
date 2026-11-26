// The package was codex-supervisor-mcp and kept its state in
// ~/.codex-supervisor. Worktrees are registered in each repository by absolute
// path, so a machine that has that directory must keep using it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tempHome } from "./helpers.js";

test("an existing state directory under the former name stays in use; a new machine gets the new one", async () => {
  process.env.SUPERVISOR_HOME = await tempHome("supervisor-state-root-");
  const { defaultSupervisorRoot } = await import("../../src/infra/paths.js");
  const home = join("/home", "someone");
  const former = join(home, ".codex-supervisor");
  assert.equal(defaultSupervisorRoot(home, (path) => path === former), former);
  assert.equal(defaultSupervisorRoot(home, () => false), join(home, ".agent-supervisor"));
});
