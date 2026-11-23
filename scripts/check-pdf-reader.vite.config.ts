/* Bundles scripts/check-pdf-reader.ts, with the app's own modules, into one file Electron can run (pnpm check:pdf-reader). */
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    ssr: "scripts/check-pdf-reader.ts",
    outDir: "tmp/check-pdf-reader/bundle",
    emptyOutDir: true,
    target: "node22",
    rollupOptions: { external: ["electron"], output: { format: "es", entryFileNames: "check.mjs" } },
  },
  ssr: { noExternal: true },
});
