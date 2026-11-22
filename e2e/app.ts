import { test as base, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Language } from "../src/shared/api.ts";

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

export interface LaunchOptions {
  /**
   * Written to the profile's settings file before the app starts, unless the profile
   * already has one (a restart keeps what the app saved). The default, "en", keeps the
   * tests independent of the machine's languages; null starts with no settings file.
   */
  language?: Language | null;
  /** Raw contents for the settings file instead (a corrupt file, say). */
  settingsFile?: string;
}

interface Fixtures {
  /** A temporary profile (--user-data-dir), shared by every launch in the test and removed after it. */
  profile: string;
  /** Starts the app on the test's profile; call it again after closing to restart. */
  launch: (options?: LaunchOptions) => Promise<ElectronApplication>;
  /** The app, started once with the default options. */
  app: ElectronApplication;
}

/** The app under test, started with a temporary profile so a run leaves nothing behind. */
export const test = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern
  profile: async ({}, use) => {
    const userDataDir = mkdtempSync(path.join(tmpdir(), "aba-workbench-e2e-"));
    try {
      await use(userDataDir);
    } finally {
      // Windows can keep the profile's files locked for a moment after the app exits.
      rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  },
  launch: async ({ profile }, use, testInfo) => {
    const started: ElectronApplication[] = [];
    await use(async ({ language = "en", settingsFile }: LaunchOptions = {}) => {
      const settingsPath = path.join(profile, "settings.json");
      if (settingsFile !== undefined) writeFileSync(settingsPath, settingsFile);
      else if (language !== null && !existsSync(settingsPath)) writeFileSync(settingsPath, JSON.stringify({ version: 1, language }));
      const args = [`--user-data-dir=${profile}`];
      // Never point the window at a dev server.
      const env = Object.fromEntries(Object.entries(process.env).filter(([name, value]) => name !== "ELECTRON_RENDERER_URL" && value !== undefined)) as Record<string, string>;
      const app =
        testInfo.project.name === "packaged"
          ? await electron.launch({ executablePath: packagedExecutable(), args, env })
          : await electron.launch({ args: [root, ...args], cwd: root, env });
      started.push(app);
      return app;
    });
    for (const app of started) await app.close().catch(() => undefined);
  },
  app: async ({ launch }, use) => {
    await use(await launch());
  },
});

/** Shows a screen by its address (the part after #), as a link inside the app would. */
export async function goTo(page: Page, address: string): Promise<void> {
  await page.evaluate((hash) => {
    (globalThis as unknown as { location: { hash: string } }).location.hash = hash;
  }, address);
}

/** Resizes the window's content area. */
export async function resize(app: ElectronApplication, width: number, height: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [width, height]);
}

export { expect } from "@playwright/test";
