import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "./helpers.js";
const run=promisify(execFile);
async function host(client,existing=null,mode="ok") {
  const root=await mkdtemp(join(tmpdir(),"setup-register-"));const state=join(root,"state.json");const entry=join(root,"client.cjs");
  if(existing)await writeFile(state,JSON.stringify(existing));
  await writeFile(entry,`const fs=require('fs');const args=process.argv.slice(2);const state=process.env.REG_STATE;
if(args[1]==='get'){if(!fs.existsSync(state)){console.error('No MCP server found');process.exit(1);}const s=JSON.parse(fs.readFileSync(state));if(process.env.REG_CLIENT==='codex')console.log(JSON.stringify({enabled:s.enabled!==false,transport:s}));else console.log('Scope: '+(s.scope||'User config')+'\\n  Command: '+s.command+'\\n  Args: '+s.args.join(' ')+'\\n  Environment:\\n'+(Object.keys(s.env||{}).length?'    CUSTOM=value':'')+'\\n\\nTo remove this server');}
else if(args[1]==='remove'){if(fs.existsSync(state))fs.unlinkSync(state);}
else if(args[1]==='add'){const i=args.indexOf('--');if(process.env.REG_MODE==='fail'||(process.env.REG_MODE==='fail-new'&&args[i+1]!=='/old/node')){console.error('registration denied');process.exit(7);}if(process.env.REG_MODE!=='no-write')fs.writeFileSync(state,JSON.stringify({command:args[i+1],args:args.slice(i+2)}));}`);
  const env={...process.env,HOME:root,USERPROFILE:root,CODEX_HOME:"",CLAUDE_CONFIG_DIR:"",CODEX_BIN:"",CLAUDE_BIN:"",REG_STATE:state,REG_CLIENT:client,REG_MODE:mode,[client==='codex'?'CODEX_BIN':'CLAUDE_BIN']:entry};
  const setup=async(args=[])=>run(process.execPath,[join(repoRoot,"src/setup.js"),"--mcp-only","--target",client,...args],{env});
  return {root,state,setup};
}
for(const client of ["claude","codex"]){
  test(`${client}: register fresh and verify read-back, then idempotent`,async()=>{
    const h=await host(client);assert.match((await h.setup()).stdout,/registered/);assert.match((await h.setup()).stdout,/already registered/);
    const state=JSON.parse(await readFile(h.state,"utf8"));assert.equal(state.command,process.execPath);assert.deepEqual(state.args,[join(repoRoot,"src/mcp-server.js")]);
  });
  test(`${client}: repair obsolete package path but preserve custom registrations`,async()=>{
    const h=await host(client,{command:"/old/node",args:["/old/node_modules/codex-supervisor-mcp/src/mcp-server.js"]});assert.match((await h.setup()).stdout,/repaired/);
    const custom={command:"npx",args:["-y","codex-supervisor-mcp"],env:{CUSTOM:"keep"}};const c=await host(client,custom);await assert.rejects(c.setup(),error=>error.code===1&&/preserved/.test(error.stderr));assert.deepEqual(JSON.parse(await readFile(c.state,"utf8")),custom);
    const checkout=join(c.root,"codex-supervisor-mcp/src/mcp-server.js");await mkdir(join(c.root,"codex-supervisor-mcp/src"),{recursive:true});await writeFile(checkout,"// user source entry");
    const source={command:process.execPath,args:[checkout]};await writeFile(c.state,JSON.stringify(source));
    await assert.rejects(c.setup(),error=>error.code===1&&/preserved/.test(error.stderr));
    assert.deepEqual(JSON.parse(await readFile(c.state,"utf8")),source);
  });
  test(`${client}: unsuccessful registration or unverifiable success fails manual setup`,async()=>{
    for(const mode of ["fail","no-write"]){const h=await host(client,null,mode);await assert.rejects(h.setup(),error=>error.code===1&&/registration failed/.test(error.stderr));}
  });
  test(`${client}: failure during repair restores the previous package entry`,async()=>{
    const previous={command:"/old/node",args:["/old/node_modules/codex-supervisor-mcp/src/mcp-server.js"]};
    const h=await host(client,previous,"fail-new");
    await assert.rejects(h.setup(),error=>error.code===1&&/registration failed/.test(error.stderr));
    assert.deepEqual(JSON.parse(await readFile(h.state,"utf8")),previous);
  });
  test(`${client}: a skill write failure does not prevent automatic MCP registration`,async()=>{
    const h=await host(client);
    await mkdir(join(h.root,`.${client}`,"skills"),{recursive:true});
    await writeFile(join(h.root,`.${client}`,"skills/codex-supervisor"),"unwritable skill destination");
    const result=await h.setup(["--skill-only","--auto"]); // Non-global automatic runs remain inert.
    assert.equal(result.stderr,"");
    const env={...process.env,HOME:h.root,USERPROFILE:h.root,CODEX_HOME:"",CLAUDE_CONFIG_DIR:"",REG_STATE:h.state,REG_CLIENT:client,REG_MODE:"ok",[client==='codex'?'CODEX_BIN':'CLAUDE_BIN']:join(h.root,"client.cjs")};
    await assert.rejects(run(process.execPath,[join(repoRoot,"src/setup.js"),"--target",client],{env}),error=>error.code===1&&/MCP registration will still be attempted/.test(error.stderr));
    const state=JSON.parse(await readFile(h.state,"utf8"));assert.equal(state.command,process.execPath);
    await rm(h.state);
    const automatic=await run(process.execPath,[join(repoRoot,"src/setup.js"),"--target",client,"--auto"],{env:{...env,npm_config_global:"true",CODEX_SUPERVISOR_SKIP_SETUP:""}});
    assert.match(automatic.stderr,/MCP registration will still be attempted/);
    assert.deepEqual(JSON.parse(await readFile(h.state,"utf8")),state);
  });
}
