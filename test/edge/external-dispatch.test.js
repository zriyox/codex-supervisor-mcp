import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tempHome, withMcp, dispatchArgs, waitFor, makeRepo, fakeCodex } from "./helpers.js";

test("shared output declaration reserves paths and records preserved baseline in result and diff", async () => {
  const home=await tempHome("supervisor-external-dispatch-");const {dir}=await makeRepo(join(home,"repo"));
  const shared=join(home,"shared.md");await writeFile(shared,"user draft\n");
  const release = join(home, "release-worker");
  const gatedCodex = join(home, "gated-codex.mjs");
  await writeFile(gatedCodex, `
    import { once } from "node:events";
    import { existsSync, watch } from "node:fs";

    if (!process.argv.includes("--help")) {
      const watcher = watch(${JSON.stringify(home)});
      try {
        while (!existsSync(${JSON.stringify(release)})) {
          await once(watcher, "change");
        }
      } finally {
        watcher.close();
      }
    }
    await import(${JSON.stringify(pathToFileURL(fakeCodex).href)});
  `);
  const options={sandbox:{mode:"workspace-write"},owned_paths:["result.txt"],workspace:{external_outputs:[{path:shared}]},acceptance:{commands:['node -e "process.exit(0)"']}};
  await withMcp({ SUPERVISOR_HOME: home, CODEX_BIN: gatedCodex }, async ({ call }) => {
    let worker;
    try {
      worker = await call("create_worker", dispatchArgs("shared", dir, options));
      const conflict = await call("create_worker", dispatchArgs("collision", dir, { ...options, owned_paths: ["other.txt"] }));
      assert.equal(conflict.error, "ownership_conflict");
      await writeFile(shared, "user draft\nnew worker content\n");
    } finally {
      await writeFile(release, "");
    }
    await waitFor(call,worker.id,row=>row.exit_code===0);
    const result=await call("get_worker", { task_id: worker.id, include: ["result"] });
    assert.equal(result.external_outputs[0].changed,true);
    assert.equal(result.external_outputs[0].before.content,"user draft\n");
    assert.match(result.external_outputs[0].after.content,/user draft/);
    assert.match(result.external_outputs[0].integration,/not_cherry_pick/);
    const diff=await call("get_worker_diff", { task_id: worker.id });assert.equal(diff.external_outputs[0].changed,true);
  });
});
