// Finds a runner by name. The two built in are always there; any other is a
// package named agent-supervisor-runner-<name>, or a file named by
// AGENT_SUPERVISOR_RUNNER_<NAME>, loaded the first time it is asked for.
import { assertRunner } from "./contract.js";
import { claudeRunner } from "./claude/adapter.js";
import { codexRunner } from "./codex/adapter.js";
import { pathToFileURL } from "node:url";

export const DEFAULT_RUNNER = "codex";
const runners = new Map([[codexRunner.name, assertRunner(codexRunner, "codex")], [claudeRunner.name, assertRunner(claudeRunner, "claude")]]);

export const runnerNames = () => [...runners.keys()];

// For code that already has a task: the runner was loaded when it was dispatched
// in this process, or is loaded by loadRunner at the entry that reads the task.
export function getRunner(name = DEFAULT_RUNNER) {
  const runner = runners.get(name ?? DEFAULT_RUNNER);
  if (!runner) throw Object.assign(new Error(`runner "${name}" is not loaded`), { code: "runner_not_loaded" });
  return runner;
}

export const runnerOf = (task) => getRunner(task?.worker ?? DEFAULT_RUNNER);

function externalSource(name) {
  const fromEnv = process.env[`AGENT_SUPERVISOR_RUNNER_${name.toUpperCase().replace(/-/g, "_")}`]?.trim();
  return fromEnv ? { specifier: pathToFileURL(fromEnv).href, label: fromEnv } : { specifier: `agent-supervisor-runner-${name}`, label: `agent-supervisor-runner-${name}` };
}

export async function loadRunner(name = DEFAULT_RUNNER) {
  const wanted = name ?? DEFAULT_RUNNER;
  if (runners.has(wanted)) return runners.get(wanted);
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(wanted)) throw Object.assign(new Error(`"${wanted}" is not a runner name`), { code: "runner_unknown" });
  const { specifier, label } = externalSource(wanted);
  let loaded;
  try {
    loaded = await import(specifier);
  } catch (error) {
    throw Object.assign(new Error(`runner "${wanted}" is not available: could not load ${label} (${error.message.split("\n")[0]}). Built in: ${runnerNames().join(", ")}`),
      { code: "runner_unknown" });
  }
  const runner = assertRunner(loaded.runner ?? loaded.default, label);
  if (runner.name !== wanted) throw Object.assign(new Error(`${label} exports a runner named "${runner.name}", not "${wanted}"`), { code: "runner_unknown" });
  runners.set(wanted, runner);
  return runner;
}
