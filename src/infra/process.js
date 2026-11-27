// The only place, besides git.js, that touches node:child_process. Everything
// else asks for a process through these names, which keeps blocking calls and
// platform-specific process handling in one file.
import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export const runSync = execFileSync;
export const runFile = execFile;
export const spawnProcess = spawn;

// A Windows run host is started inside its parent's hidden console; its children
// must share that console, because a console of their own shows a window.
export const SHARED_CONSOLE_ENV = "AGENT_SUPERVISOR_SHARED_CONSOLE";
export const hideChildConsole = process.env[SHARED_CONSOLE_ENV] !== "1";

// Resolves when the command exits 0, rejects otherwise. Output is discarded.
export function runToExit(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "ignore", windowsHide: hideChildConsole, ...options });
    child.on("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
    child.on("error", reject);
  });
}

function powershellBin() {
  const root = process.env.SystemRoot?.trim() || "C:\\Windows";
  const full = join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return existsSync(full) ? full : "powershell";
}

// The command line of a pid, or "" when it cannot be read. A pid recorded on
// disk is only signalled once this confirms it still belongs to a worker, so a
// recycled pid is never killed. Windows has no `ps`: CIM is the only reliable
// source for a full command line, and the full line matters because the npm
// shim is bypassed by running `node <entry>`, which puts the CLI's name in the
// arguments, not the image name. `tasklist` is the fallback when PowerShell is
// unavailable; it only reports the image name.
//
// The timeout is generous on purpose: this runs once per cross-process cancel,
// and a cold Windows PowerShell on a fresh machine routinely takes several
// seconds to print anything. A tight timeout silently degrades to the useless
// tasklist probe, and the cancel comes back "process_not_found".
export function describeProcess(pid) {
  const options = { encoding: "utf8", timeout: 15000, windowsHide: hideChildConsole };
  try {
    if (process.platform === "win32") {
      try {
        const command = `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`;
        const viaCim = execFileSync(powershellBin(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], options).trim();
        if (viaCim) return viaCim;
      } catch {
        // fall through to the image-name probe below
      }
      return execFileSync("tasklist", ["/FI", `PID eq ${Number(pid)}`, "/FO", "CSV", "/NH"], options).trim();
    }
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], options).trim();
  } catch {
    return "";
  }
}
