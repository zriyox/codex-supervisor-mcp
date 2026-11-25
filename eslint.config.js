import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["web/**", "node_modules/**", "data/**", "assets/**"] },
  js.configs.recommended,
  {
    files: ["src/**/*.js", "src/**/*.jsx", "test/**/*.js", "eslint.config.js"],
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
  }
];
