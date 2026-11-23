import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import { devStyleNonce } from "./scripts/dev-style-nonce.ts";
import { thirdPartyNotices } from "./scripts/third-party-notices.ts";

/** Every package bundled into the app, with its license text: copied into the packaged app by electron-builder. */
const NOTICES = "out/licenses/THIRD-PARTY-NOTICES.txt";

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
    plugins: [thirdPartyNotices(NOTICES)],
    build: {
      rollupOptions: {
        // The PDF reading process is a second entry: out/main/pdf-text-child.js, started as an
        // Electron utility process for each PDF (src/main/pdf-text/electron-child.ts).
        input: { index: "src/main/index.ts", "pdf-text-child": "src/main/pdf-text/child.ts" },
      },
    },
  },
  preload: {
    plugins: [thirdPartyNotices(NOTICES)],
    build: {
      // A sandboxed preload cannot be an ES module: build it as one CommonJS file.
      rollupOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } },
    },
  },
  renderer: {
    // Tailwind compiles src/renderer/src/styles/app.css; devStyleNonce lets the dev
    // server's injected styles through the content security policy (pnpm dev only).
    plugins: [react(), tailwindcss(), devStyleNonce(), thirdPartyNotices(NOTICES, ["tailwindcss"])],
  },
}));
