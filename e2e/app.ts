import { test as base, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import electronBinary from "electron";
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
  /** A cases folder chosen in Settings, written into the settings file with the language. */
  casesFolder?: string;
}

interface Fixtures {
  /** A temporary profile (--user-data-dir), shared by every launch in the test and removed after it. */
  profile: string;
  /**
   * A temporary folder the app takes for Documents (--documents-folder), so the default
   * cases folder is <documents>/ABA Workbench and no test touches the real Documents.
   */
  documents: string;
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
  // eslint-disable-next-line no-empty-pattern
  documents: async ({}, use) => {
    const folder = mkdtempSync(path.join(tmpdir(), "aba-workbench-e2e-documents-"));
    try {
      await use(folder);
    } finally {
      rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  },
  launch: async ({ profile, documents }, use, testInfo) => {
    const started: ElectronApplication[] = [];
    await use(async ({ language = "en", settingsFile, casesFolder }: LaunchOptions = {}) => {
      const settingsPath = path.join(profile, "settings.json");
      if (settingsFile !== undefined) writeFileSync(settingsPath, settingsFile);
      else if (language !== null && !existsSync(settingsPath)) writeFileSync(settingsPath, JSON.stringify({ version: 1, language, ...(casesFolder ? { casesFolder } : {}) }));
      const args = [`--user-data-dir=${profile}`, `--documents-folder=${documents}`];
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

/** The default cases folder for a test's Documents folder. */
export function defaultCasesFolder(documents: string): string {
  return path.join(documents, "ABA Workbench");
}

/** An invented case, as the app writes it. */
export const SAMPLE_CASE = {
  id: "5b6f0f8e-2d7a-4c1e-9b3a-7e2f4d6c8a10",
  label: "M.F. sample case",
  clientAge: { years: 4, months: 2 },
  createdAt: "2026-11-20T10:00:00.000Z",
  updatedAt: "2026-11-20T10:00:00.000Z",
};

/** Writes a case's folder and data file into `casesFolder` (made if needed), before the app starts. */
export function seedCase(casesFolder: string, folderName = SAMPLE_CASE.label, data: Record<string, unknown> = SAMPLE_CASE): string {
  const folder = path.join(casesFolder, folderName);
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, "aba-case.json"), JSON.stringify({ schemaVersion: 1, files: [], ...data }, null, 2));
  return folder;
}

/**
 * Replaces the system's folder dialog: the next choices return `folder` (null: the user
 * cancels). A test never sees a real dialog.
 */
export async function stubFolderDialog(app: ElectronApplication, folder: string | null): Promise<void> {
  await app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = (async () => (chosen ? { canceled: false, filePaths: [chosen] } : { canceled: true, filePaths: [] })) as typeof dialog.showOpenDialog;
  }, folder);
}

/**
 * Replaces "Show in Finder / Explorer": records what would be shown instead of opening a
 * window. With `fail`, opening a folder answers as the system does when it cannot.
 */
export async function stubFileManager(app: ElectronApplication, { fail = false } = {}): Promise<() => Promise<string[]>> {
  await app.evaluate(({ shell }, failing) => {
    const shown: string[] = [];
    (globalThis as unknown as { shownInFileManager: string[] }).shownInFileManager = shown;
    shell.showItemInFolder = (item: string) => {
      shown.push(item);
    };
    shell.openPath = async (item: string) => {
      shown.push(item);
      return failing ? "The folder could not be opened." : "";
    };
  }, fail);
  return () => app.evaluate(() => [...(globalThis as unknown as { shownInFileManager: string[] }).shownInFileManager]);
}

/**
 * Starts another copy of the app on the same profile, outside Playwright, and waits for it
 * to end: its exit code, or "still running" (it is then stopped) after `timeoutMs`.
 */
export async function startSecondCopy(project: string, profile: string, documents: string, timeoutMs = 20_000): Promise<number | null | "still running"> {
  const args = [`--user-data-dir=${profile}`, `--documents-folder=${documents}`];
  const env = Object.fromEntries(Object.entries(process.env).filter(([name, value]) => name !== "ELECTRON_RENDERER_URL" && value !== undefined)) as Record<string, string>;
  const child =
    project === "packaged"
      ? spawn(packagedExecutable(), args, { env, stdio: "ignore" })
      : spawn(electronBinary as unknown as string, [root, ...args], { cwd: root, env, stdio: "ignore" });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve("still running");
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

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
