// The only place that runs git. Callers differ in real ways (optional locks,
// path quoting, what happens to stderr, whether output is trimmed), so those
// are options here instead of one private copy per caller.
import { execFileSync } from "node:child_process";

export const gitBin = () => process.env.GIT_BIN?.trim() || "git";

export function runGit(cwd, args, options = {}) {
  const { timeout = 60000, noOptionalLocks = false, rawPaths = false, stderr = "pipe", input = null, maxBuffer, encoding = "utf8", env, trim = true } = options;
  const argv = [...(noOptionalLocks ? ["--no-optional-locks"] : []), "-C", cwd, ...(rawPaths ? ["-c", "core.quotePath=false"] : []), ...args];
  const output = execFileSync(gitBin(), argv, {
    encoding,
    timeout,
    stdio: [input == null ? "ignore" : "pipe", "pipe", stderr],
    ...(input == null ? {} : { input }),
    ...(maxBuffer ? { maxBuffer } : {}),
    ...(env ? { env } : {})
  });
  return trim && typeof output === "string" ? output.trim() : output;
}

// For questions git answers with its exit code, such as merge-base --is-ancestor.
export function gitSucceeds(cwd, args, { timeout = 15000 } = {}) {
  try {
    execFileSync(gitBin(), ["-C", cwd, ...args], { stdio: "ignore", timeout });
    return true;
  } catch {
    return false;
  }
}
