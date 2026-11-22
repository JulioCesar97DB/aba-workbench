import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

/*
 * Default layout: src/main, src/preload, src/renderer, built into out/.
 * Dependencies: electron-vite leaves the packages in package.json "dependencies" outside
 * the bundle (shipped as node_modules) and bundles everything else. This project lists
 * every package under devDependencies, so the main process bundle carries the provider
 * SDKs and the packaged app ships no node_modules.
 */
export default defineConfig(({ mode }) => ({
  main: {
    // Same meaning as under Next.js: "production" in a build (the rules files are read
    // once and cached), "development" under `pnpm dev` (re-read on every generation).
    define: { "process.env.NODE_ENV": JSON.stringify(mode === "production" ? "production" : "development") },
  },
  preload: {
    build: {
      // A sandboxed preload cannot be an ES module: build it as one CommonJS file.
      rollupOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } },
    },
  },
  renderer: {
    plugins: [react()],
  },
}));
