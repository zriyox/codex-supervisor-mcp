import js from "@eslint/js";
import globals from "globals";

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
  ...[
    ["domain", ["app", "infra", "interface", "runners"]],
    ["infra", ["app", "interface", "runners"]],
    ["runners", ["app", "interface"]],
    ["app", ["interface"]]
  ].map(([layer, forbidden]) => ({
    files: [`src/${layer}/**/*.js`],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          regex: `^(\\.\\./)+(${forbidden.join("|")})/`,
          message: `src/${layer} may not import from ${forbidden.join(", ")}.`
        }]
      }]
    }
  })),
  {
    files: ["src/domain/**/*.js"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: ["node:fs", "node:fs/promises", "node:child_process", "node:sqlite", "node:http", "node:net"].map((name) => ({ name, message: "src/domain is pure: no IO." })),
        patterns: [{ regex: "^(\\.\\./)+(app|infra|interface|runners)/", message: "src/domain may not import another layer." }]
      }]
    }
  }
];
