import { readFileSync } from "node:fs";
import { join } from "node:path";
import { codexHome } from "./paths.js";

export function configuredMcpServers(configText) {
  const names = new Set();
  for (const line of String(configText ?? "").split("\n")) {
    const match = line.match(/^\s*\[mcp_servers\.(?:"([^"]+)"|([^\].]+))\]\s*(?:#.*)?$/);
    if (match) names.add(match[1] ?? match[2]);
  }
  return names;
}

export function disableMcpServerArgs(configText, names = null) {
  const configured = configuredMcpServers(configText);
  const selected = names ? [...configured].filter((name) => names.has(name)) : [...configured];
  const args = [];
  for (const name of selected) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) continue;
    args.push("-c", `mcp_servers.${name}.enabled=false`);
  }
  return args;
}

export function codexConfigText() {
  try {
    return readFileSync(join(codexHome, "config.toml"), "utf8");
  } catch {
    return "";
  }
}

export function supervisorMcpDisableArgs() {
  return disableMcpServerArgs(codexConfigText(), new Set(["codex-supervisor"]));
}
