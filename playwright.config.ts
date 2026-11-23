import { defineConfig } from "@playwright/test";

/*
 * End-to-end tests that drive the desktop window (Playwright's Electron support). They
 * need a display (on a Linux runner: xvfb-run) and are kept apart from `pnpm test`.
 *   pnpm test:e2e            the built app (out/), as `electron .` runs it
 *   pnpm test:e2e:packaged   the unpacked app that `pnpm package` left in dist/
 * Only the mock provider is reachable from the interface: these tests make no AI call.
 */
export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.e2e.ts",
  timeout: 60_000,
  // Each test starts its own app; one at a time.
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: "list",
  outputDir: "tmp/e2e-results",
  projects: [{ name: "built" }, { name: "packaged" }],
});
