// Coverage for the Windows spawn resolver.
//
// The win32 branch cannot run on the machines this project is developed on, so
// every probe (platform, env, filesystem, node path) is injected here and the
// real filesystem is never touched. Non-win32 behaviour is asserted to be a
// pure pass-through so macOS and Linux stay byte-for-byte unchanged.
import assert from "node:assert/strict";
import path from "node:path";
import { findBinaryPath, resolveCommand, shimMessage } from "./bin-resolver.js";

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

const w = path.win32;
const existsAmong = (files) => {
  const set = new Set(files);
  return (candidate) => set.has(candidate);
};

const NPM_PREFIX = "C:\\Users\\z\\AppData\\Roaming\\npm";
const CODEX_ENTRY = w.join(NPM_PREFIX, "node_modules", "@openai", "codex", "bin", "codex.js");
const CODEX_SHIM = w.join(NPM_PREFIX, "codex.cmd");

check("non-win32 resolution is a pure pass-through", () => {
  for (const platform of ["linux", "darwin"]) {
    assert.deepEqual(resolveCommand("codex", { platform }), {
      cmd: "codex",
      prefixArgs: [],
      shim: false
    });
  }
});

check("non-win32 never probes the filesystem", () => {
  const boom = () => {
    throw new Error("filesystem must not be touched off win32");
  };
  assert.deepEqual(
    resolveCommand("codex", { platform: "darwin", exists: boom, npmEntry: { pkg: "x", bin: "y" } }),
    { cmd: "codex", prefixArgs: [], shim: false }
  );
});

check("an empty or non-string name passes through", () => {
  for (const name of ["", undefined, null]) {
    assert.deepEqual(resolveCommand(name, { platform: "win32" }), {
      cmd: name,
      prefixArgs: [],
      shim: false
    });
  }
});

check("a JS entry point is run under node on every platform", () => {
  // The value CODEX_BIN naturally takes on Windows: the npm package's own entry
  // point. Neither kernel can spawn it directly, so node goes in front.
  for (const platform of ["win32", "darwin", "linux"]) {
    assert.deepEqual(
      resolveCommand(platform === "win32" ? "C:\\p\\codex.js" : "/p/codex.js", {
        platform,
        nodePath: "NODE"
      }),
      { cmd: "NODE", prefixArgs: [platform === "win32" ? "C:\\p\\codex.js" : "/p/codex.js"], shim: false }
    );
  }
  for (const ext of [".cjs", ".mjs", ".JS"]) {
    assert.deepEqual(resolveCommand(`/p/codex${ext}`, { platform: "darwin", nodePath: "NODE" }), {
      cmd: "NODE",
      prefixArgs: [`/p/codex${ext}`],
      shim: false
    });
  }
});

check("non-win32 still passes through a path-bearing name that is not JS", () => {
  for (const name of ["/p/codex", "/p/run.sh", "/p/codex.exe"]) {
    assert.deepEqual(resolveCommand(name, { platform: "darwin" }), {
      cmd: name,
      prefixArgs: [],
      shim: false
    });
  }
});

check("win32 uses a native .exe when the install is not npm", () => {
  const exe = w.join("C:\\Program Files\\nodejs", "codex.exe");
  const target = resolveCommand("codex", {
    platform: "win32",
    env: { PATH: "C:\\Program Files\\nodejs", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
    exists: existsAmong([exe])
  });
  assert.deepEqual(target, { cmd: exe, prefixArgs: [], shim: false });
});

check("win32 bypasses an npm .cmd shim through the package's JS entry", () => {
  const target = resolveCommand("codex", {
    platform: "win32",
    env: { PATH: NPM_PREFIX, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
    exists: existsAmong([CODEX_SHIM, CODEX_ENTRY]),
    nodePath: "C:\\node\\node.exe",
    npmEntry: { pkg: "@openai/codex", bin: "bin/codex.js" }
  });
  assert.deepEqual(target, {
    cmd: "C:\\node\\node.exe",
    prefixArgs: [CODEX_ENTRY],
    shim: false
  });
});

check("win32 spawns a native npm entry directly when there is no JS wrapper", () => {
  const entry = w.join(NPM_PREFIX, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
  const target = resolveCommand("claude", {
    platform: "win32",
    env: { PATH: NPM_PREFIX },
    exists: existsAmong([w.join(NPM_PREFIX, "claude.cmd"), entry]),
    npmEntry: { pkg: "@anthropic-ai/claude-code", bin: "bin/claude.exe" }
  });
  assert.deepEqual(target, { cmd: entry, prefixArgs: [], shim: false });
});

check("win32 finds the local node_modules/.bin layout", () => {
  const root = "C:\\proj";
  const shim = w.join(root, "node_modules", ".bin", "codex.cmd");
  const entry = w.join(root, "node_modules", "@openai", "codex", "bin", "codex.js");
  const target = resolveCommand("codex", {
    platform: "win32",
    env: { PATH: w.join(root, "node_modules", ".bin") },
    exists: existsAmong([shim, entry]),
    nodePath: "C:\\node\\node.exe",
    npmEntry: { pkg: "@openai/codex", bin: "bin/codex.js" }
  });
  assert.deepEqual(target, { cmd: "C:\\node\\node.exe", prefixArgs: [entry], shim: false });
});

check("win32 reports a shim it cannot bypass instead of spawning it", () => {
  const target = resolveCommand("codex", {
    platform: "win32",
    env: { PATH: NPM_PREFIX },
    exists: existsAmong([CODEX_SHIM])
  });
  assert.equal(target.shim, true);
  assert.equal(target.cmd, CODEX_SHIM);
  assert.match(shimMessage("codex", CODEX_SHIM, "CODEX_BIN"), /shell shim/);
  assert.match(shimMessage("codex", CODEX_SHIM, "CODEX_BIN"), /CODEX_BIN/);
});

check("win32 handles an explicitly named shim", () => {
  const target = resolveCommand("codex.cmd", {
    platform: "win32",
    env: { PATH: NPM_PREFIX },
    exists: existsAmong([CODEX_SHIM, CODEX_ENTRY]),
    nodePath: "C:\\node\\node.exe",
    npmEntry: { pkg: "@openai/codex", bin: "bin/codex.js" }
  });
  assert.deepEqual(target, { cmd: "C:\\node\\node.exe", prefixArgs: [CODEX_ENTRY], shim: false });
});

check("win32 treats .ps1 as a shim as well", () => {
  const target = resolveCommand("codex.ps1", { platform: "win32", exists: () => false });
  assert.equal(target.shim, true);
});

check("win32 keeps PATH order: an earlier working shim beats a later .exe", () => {
  const later = w.join("C:\\later", "codex.exe");
  const target = resolveCommand("codex", {
    platform: "win32",
    env: { PATH: `${NPM_PREFIX};C:\\later`, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
    exists: existsAmong([CODEX_SHIM, CODEX_ENTRY, later]),
    nodePath: "C:\\node\\node.exe",
    npmEntry: { pkg: "@openai/codex", bin: "bin/codex.js" }
  });
  assert.deepEqual(target, { cmd: "C:\\node\\node.exe", prefixArgs: [CODEX_ENTRY], shim: false });
});

check("win32 returns a pass-through when nothing matches, preserving ENOENT", () => {
  assert.deepEqual(
    resolveCommand("codex", {
      platform: "win32",
      env: { PATH: "C:\\empty", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      exists: () => false
    }),
    { cmd: "codex", prefixArgs: [], shim: false }
  );
});

check("win32 skips a shim whose package is missing in favour of a usable later match", () => {
  const later = w.join("C:\\later", "codex.exe");
  const target = resolveCommand("codex", {
    platform: "win32",
    env: { PATH: `${NPM_PREFIX};C:\\later`, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
    exists: existsAmong([CODEX_SHIM, later]),
    npmEntry: { pkg: "@openai/codex", bin: "bin/codex.js" }
  });
  assert.deepEqual(target, { cmd: later, prefixArgs: [], shim: false });
});

check("findBinaryPath applies the PATHEXT ladder on win32", () => {
  assert.equal(
    findBinaryPath("codex", {
      platform: "win32",
      env: { PATH: NPM_PREFIX, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      exists: existsAmong([CODEX_SHIM])
    }),
    CODEX_SHIM
  );
});

check("findBinaryPath splits POSIX PATH on colons, not semicolons", () => {
  const exists = existsAmong(["/usr/local/bin/codex"]);
  assert.equal(
    findBinaryPath("codex", { platform: "linux", env: { PATH: "/usr/bin:/usr/local/bin" }, exists }),
    "/usr/local/bin/codex"
  );
  assert.equal(
    findBinaryPath("codex", { platform: "linux", env: { PATH: "/usr/bin;/usr/local/bin" }, exists }),
    null
  );
});

check("findBinaryPath probes extra directories after PATH", () => {
  assert.equal(
    findBinaryPath("codex", {
      platform: "darwin",
      env: { PATH: "/usr/bin" },
      extraDirs: ["/home/z/.npm-global/bin"],
      exists: existsAmong(["/home/z/.npm-global/bin/codex"])
    }),
    "/home/z/.npm-global/bin/codex"
  );
});

check("findBinaryPath probes a path-bearing name as-is and returns null when absent", () => {
  const exe = "C:\\tools\\codex.exe";
  assert.equal(findBinaryPath(exe, { platform: "win32", exists: existsAmong([exe]) }), exe);
  assert.equal(findBinaryPath("C:\\tools\\missing.exe", { platform: "win32", exists: () => false }), null);
  assert.equal(findBinaryPath("", { platform: "darwin" }), null);
});

console.log(`\n${passed} bin-resolver checks passed`);
