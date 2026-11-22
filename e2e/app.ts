import { test as base, _electron as electron, type ElectronApplication } from "@playwright/test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

/**
 * The executable `pnpm package` leaves in dist/ for this system: mac-arm64/ or mac/ on
 * macOS, win-unpacked/ (win-arm64-unpacked/) on Windows, linux-unpacked/ on Linux.
 */
function packagedExecutable(dist = path.join(root, "dist")): string {
  const candidates: string[] = [];
  for (const dir of existsSync(dist) ? readdirSync(dist) : []) {
    if (process.platform === "darwin" && /^mac/.test(dir)) candidates.push(path.join(dist, dir, "ABA Workbench.app", "Contents", "MacOS", "ABA Workbench"));
    if (process.platform === "win32" && /^win.*unpacked$/.test(dir)) candidates.push(path.join(dist, dir, "ABA Workbench.exe"));
    if (process.platform === "linux" && /^linux.*unpacked$/.test(dir)) candidates.push(path.join(dist, dir, "aba-workbench"));
  }
  const found = candidates.filter((file) => existsSync(file));
  if (found.length !== 1) throw new Error(`Expected one packaged app in ${dist}, found ${found.length}. Run \`pnpm package\` first.`);
  return found[0];
}

/** The app under test, started with a temporary profile so a run leaves nothing behind. */
export const test = base.extend<{ app: ElectronApplication }>({
  // eslint-disable-next-line no-empty-pattern
  app: async ({}, use, testInfo) => {
    const userDataDir = mkdtempSync(path.join(tmpdir(), "aba-workbench-e2e-"));
    const args = [`--user-data-dir=${userDataDir}`];
    // Never point the window at a dev server.
    const env = Object.fromEntries(Object.entries(process.env).filter(([name, value]) => name !== "ELECTRON_RENDERER_URL" && value !== undefined)) as Record<string, string>;
    const app =
      testInfo.project.name === "packaged"
        ? await electron.launch({ executablePath: packagedExecutable(), args, env })
        : await electron.launch({ args: [root, ...args], cwd: root, env });
    try {
      await use(app);
    } finally {
      await app.close();
      // Windows can keep the profile's files locked for a moment after the app exits.
      rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  },
});

export { expect } from "@playwright/test";
