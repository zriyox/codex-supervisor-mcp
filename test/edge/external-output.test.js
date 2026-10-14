import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tempHome } from "./helpers.js";
import { captureExternalOutputs, compareExternalOutputs } from "../../src/external-output.js";

test("shared output records actual baseline and changes without modifying the user's existing file", async () => {
  const home = await tempHome("supervisor-external-");const path=join(home,"dirty-user.md");
  await writeFile(path,"uncommitted user content\n");
  const before = await captureExternalOutputs([{path}]);
  assert.equal(await readFile(path,"utf8"),"uncommitted user content\n");
  await writeFile(path,"uncommitted user content\nworker addition\n");
  const after = await captureExternalOutputs([{path}]);const change=compareExternalOutputs(before,after)[0];
  assert.equal(change.changed,true);assert.notEqual(change.before.sha256,change.after.sha256);
  assert.match(change.integration,/not_cherry_pick/);assert.match(change.after.content,/user content/);
  await assert.rejects(captureExternalOutputs([{path,sha256:before[0].sha256}],{checkBaseline:true}),/baseline changed/);
  assert.equal(compareExternalOutputs(after,after)[0].changed,false);
});

test("declared new outputs remain distinguishable from missing existing outputs", async () => {
  const home=await tempHome("supervisor-external-new-");const path=join(home,"new.md");
  const before=await captureExternalOutputs([{path}]);await writeFile(path,"new output");
  assert.equal(compareExternalOutputs(before,await captureExternalOutputs([{path}]))[0].changed,true);
  await assert.rejects(captureExternalOutputs([{path:"relative.md"}]),/absolute/);
});
