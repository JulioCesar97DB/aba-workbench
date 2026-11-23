import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores(["out/**", "dist/**", "tmp/**"]),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    // Main process, preload, provider layer, scripts and tests run on Node.
    files: ["**/*.{ts,mts,mjs}"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["src/renderer/**/*.{ts,tsx}"],
    extends: [reactHooks.configs.flat.recommended],
    languageOptions: { globals: globals.browser },
    rules: {
      // The interface reaches the main process only through window.aba (src/shared/api.ts).
      // Types may be shared; code from Node, Electron or the main-process side may not.
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: [{ name: "electron", message: "The interface uses window.aba, never Electron directly." }],
          patterns: [
            { group: ["node:*"], message: "The interface has no Node.js." },
            { group: ["**/main/**", "**/preload/**", "**/lib/**"], allowTypeImports: true, message: "Only types may come from the main-process side." },
          ],
        },
      ],
    },
  },
  {
    // The preload is sandboxed: Electron's renderer modules only, no Node.js modules.
    files: ["src/preload/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["node:*"], message: "A sandboxed preload has no Node.js modules." },
            { group: ["**/main/**", "**/lib/**"], allowTypeImports: true, message: "Only types may come from the main-process side." },
          ],
        },
      ],
    },
  },
]);
