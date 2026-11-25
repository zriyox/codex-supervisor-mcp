// The only place that runs git. Callers differ in real ways (optional locks,
// path quoting, what happens to stderr, whether output is trimmed), so those
// are options here instead of one private copy per caller.
import { execFile, execFileSync } from "node:child_process";

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

// git that does not hold the event loop, for the paths that run many
// commands inside one request: cleanup walks every finished worktree during a
// poll. Takes the options runGit takes, apart from input and stderr.
export function runGitAsync(cwd, args, options = {}) {
  const { timeout = 60000, noOptionalLocks = false, rawPaths = false, maxBuffer, env, trim = true } = options;
  const argv = [...(noOptionalLocks ? ["--no-optional-locks"] : []), "-C", cwd, ...(rawPaths ? ["-c", "core.quotePath=false"] : []), ...args];
  return new Promise((resolveRun, rejectRun) => {
    execFile(gitBin(), argv, { encoding: "utf8", timeout, ...(maxBuffer ? { maxBuffer } : {}), ...(env ? { env } : {}) }, (error, stdout, stderr) => {
      if (!error) return resolveRun(trim ? stdout.trim() : stdout);
      error.message = `${error.message.split("\n")[0]}${stderr?.trim() ? `\n${stderr.trim()}` : ""}`;
      rejectRun(error);
    });
  });
}

// A question git answers with its exit code, such as merge-base
// --is-ancestor. An exit code is an answer. A timeout, a signal or a git that
// could not be started is not "no", and reading it as one turns a slow disk
// into "this commit never landed", so those throw.
const answered = (error) => typeof (error.status ?? error.code) === "number";

export function gitSucceeds(cwd, args, { timeout = 15000 } = {}) {
  try {
    execFileSync(gitBin(), ["-C", cwd, ...args], { stdio: "ignore", timeout });
    return true;
  } catch (error) {
    if (answered(error)) return false;
    throw error;
  }
}

export function gitSucceedsAsync(cwd, args, { timeout = 15000 } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    execFile(gitBin(), ["-C", cwd, ...args], { timeout }, (error) => {
      if (!error) resolveRun(true);
      else if (answered(error)) resolveRun(false);
      else rejectRun(error);
    });
  });
}
