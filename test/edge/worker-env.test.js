import { test } from "node:test";
import assert from "node:assert/strict";
import { withWorkerToolPath } from "../../src/worker-env.js";

test("the worker PATH always contains the running Node toolchain", () => {
  const env = withWorkerToolPath({ PATH: "/usr/bin:/bin" }, "/opt/homebrew/bin/node", ":");
  assert.equal(env.PATH, "/opt/homebrew/bin:/usr/bin:/bin");
});

test("the worker PATH preserves Path spelling and does not duplicate the Node directory", () => {
  const env = withWorkerToolPath({ Path: "/opt/homebrew/bin:/usr/bin:/bin" }, "/opt/homebrew/bin/node", ":");
  assert.equal(env.PATH, "/opt/homebrew/bin:/usr/bin:/bin");
});
