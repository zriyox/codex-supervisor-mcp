// "Is this commit an ancestor?" has three outcomes, not two. Reading "git
// could not answer" as "no" made a slow disk look like work that never landed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { gitSucceeds, gitSucceedsAsync } from "../../src/infra/git.js";
import { makeRepo, tempHome } from "./helpers.js";

test("an exit code is an answer, a git that cannot run is an error", async (t) => {
  const repo = await tempHome("supervisor-git-answer-");
  await makeRepo(repo);
  assert.equal(gitSucceeds(repo, ["rev-parse", "--verify", "--quiet", "HEAD"]), true);
  assert.equal(gitSucceeds(repo, ["rev-parse", "--verify", "--quiet", "refs/heads/no-such-branch"]), false);
  assert.equal(await gitSucceedsAsync(repo, ["rev-parse", "--verify", "--quiet", "refs/heads/no-such-branch"]), false);

  const before = process.env.GIT_BIN;
  process.env.GIT_BIN = "/no/such/git";
  t.after(() => { if (before === undefined) delete process.env.GIT_BIN; else process.env.GIT_BIN = before; });
  assert.throws(() => gitSucceeds(repo, ["rev-parse", "HEAD"]), /ENOENT/);
  await assert.rejects(gitSucceedsAsync(repo, ["rev-parse", "HEAD"]), /ENOENT/);
});
