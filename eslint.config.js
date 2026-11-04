"use strict";

const js      = require("@eslint/js");
const globals = require("globals");

module.exports = [
  { ignores: ["coverage/**", "node_modules/**"] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType:  "commonjs",
      globals:     { ...globals.node, ...globals.jest },
    },
    rules: {
      // Best-effort `try { … } catch {}` is the codebase idiom for optional I/O.
      "no-empty":                      ["error", { allowEmptyCatch: true }],
      "no-unused-vars":                "warn",
      "no-misleading-character-class": "warn",
    },
  },
];
