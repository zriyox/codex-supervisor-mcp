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
// Builtins are matched with and without the node: prefix.
const PROCESS_PATTERN = { regex: "^(node:)?child_process$", message: "Use src/infra/process.js or src/infra/git.js." };
const IO_PATTERN = { regex: "^(node:)?(fs|fs/promises|sqlite|http|https|net|dgram|worker_threads)$", message: "src/domain is pure: no IO." };

function layerPattern(layer, forbidden) {
  return { regex: `^(\\.\\./)+(${forbidden.join("|")})/`, message: `src/${layer} may not import from ${forbidden.join(", ")}.` };
}

function restrictions(layer, forbidden) {
  const patterns = [PROCESS_PATTERN];
  if (layer === "domain") patterns.push(IO_PATTERN);
  if (forbidden.length) patterns.push(layerPattern(layer, forbidden));
  return { patterns };
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
      // A bare `catch {}` is how the tests say "best effort"; src/ has a stricter rule below.
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-unused-vars": ["error", { args: "after-used", argsIgnorePattern: "^_", caughtErrors: "none", ignoreRestSiblings: true, varsIgnorePattern: "^(_|React$)" }]
    }
  },
  // Size limits for shipped code. A file or function that outgrows them is
  // doing more than one job. Strings are exempt from the line length because
  // tool descriptions and error messages are long by nature.
  {
    files: ["src/**/*.js", "src/**/*.jsx"],
    rules: {
      "max-lines": ["error", { max: 400 }],
      "max-lines-per-function": ["error", { max: 80, IIFEs: true }],
      "max-len": ["error", { code: 160, ignoreStrings: true, ignoreTemplateLiterals: true, ignoreRegExpLiterals: true, ignoreUrls: true }],
      // An empty catch needs a comment saying why the error can be ignored.
      "no-empty": ["error", { allowEmptyCatch: false }]
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
