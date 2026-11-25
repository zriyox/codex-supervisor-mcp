import js from "@eslint/js";
import globals from "globals";

// What each layer may NOT import.
const LAYERS = {
  interface: ["run-host"],
  "run-host": ["interface"],
  app: ["interface", "run-host"],
  domain: ["app", "infra", "interface", "runners", "run-host"],
  infra: ["app", "interface", "runners", "run-host"],
  runners: ["app", "interface", "run-host"]
};
// Blocking calls and platform-specific process handling live in these two files.
const PROCESS_MODULES = ["src/infra/git.js", "src/infra/process.js"];
const IO_MODULES = ["node:fs", "node:fs/promises", "node:sqlite", "node:http", "node:net"];

function layerPattern(layer, forbidden) {
  return { regex: `^(\\.\\./)+(${forbidden.join("|")})/`, message: `src/${layer} may not import from ${forbidden.join(", ")}.` };
}

function restrictions(layer, forbidden) {
  const paths = [{ name: "node:child_process", message: "Use src/infra/process.js or src/infra/git.js." }];
  if (layer === "domain") paths.push(...IO_MODULES.map((name) => ({ name, message: "src/domain is pure: no IO." })));
  return { paths, ...(forbidden.length ? { patterns: [layerPattern(layer, forbidden)] } : {}) };
}

export default [
  { ignores: ["web/**", "node_modules/**", "data/**", "assets/**"] },
  js.configs.recommended,
  {
    files: ["src/**/*.js", "src/**/*.jsx", "test/**/*.js", "test/**/*.mjs", "eslint.config.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node },
      parserOptions: { ecmaFeatures: { jsx: true } }
    },
    rules: {
      // A bare `catch {}` is how this codebase says "best effort"; an empty block of any other kind is a mistake.
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-unused-vars": ["error", { args: "after-used", argsIgnorePattern: "^_", caughtErrors: "none", ignoreRestSiblings: true, varsIgnorePattern: "^(_|React$)" }]
    }
  },
  // Layering. Dependencies point downward only: interface -> app -> domain,
  // with infra and runners reached from app. docs/architecture.md has the map.
  // One rule object per layer, because a later no-restricted-imports replaces
  // an earlier one for the same file instead of adding to it.
  ...Object.entries(LAYERS).map(([layer, forbidden]) => ({
    files: [`src/${layer}/**/*.js`, `src/${layer}/**/*.jsx`],
    ignores: PROCESS_MODULES,
    rules: { "no-restricted-imports": ["error", restrictions(layer, forbidden)] }
  })),
  {
    files: PROCESS_MODULES,
    rules: { "no-restricted-imports": ["error", { patterns: [layerPattern("infra", LAYERS.infra)] }] }
  }
];
