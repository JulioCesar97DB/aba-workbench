import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CaseLibrary } from "./cases.ts";
import { createCloseGuard, FLUSH_TIMEOUT_MS, IDLE_TIMEOUT_MS, UNSAVED_DIALOG, withTimeout, type UnsavedProblem } from "./close-guard.ts";
import { ChatGptSession } from "./chatgpt-session.ts";
import { ConnectionService } from "./connections.ts";
import { CREDENTIALS_FILE_NAME, CredentialsStore } from "./credentials.ts";
import { anthropicProvider } from "../lib/providers/anthropic.ts";
import { IPC_CHANNELS } from "../shared/api.ts";
import { defaultCasesFolder } from "./cases-folder.ts";
import { registerIpc } from "./ipc.ts";
import { resolveHomeFolder, resolveRulesDir } from "./paths.ts";
import { APP_ORIGIN, registerAppScheme, serveRenderer } from "./protocol.ts";
import { denyAllPermissions, hardenWebContents } from "./security.ts";
import { defaultLanguage, SETTINGS_FILE_NAME, SettingsStore } from "./settings.ts";
import { WINDOW_BACKGROUND } from "../shared/theme.ts";
import { isTrustedFrame } from "./trust.ts";

// electron-vite sets ELECTRON_RENDERER_URL in development (its Vite dev server). A packaged
// app ignores it, so an environment variable cannot point the window at another page.
const devServerUrl = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL;
const trustedOrigin = devServerUrl ? new URL(devServerUrl).origin : APP_ORIGIN;
const rulesDir = resolveRulesDir({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() });
// The build output: out/main/index.js, out/preload/index.cjs, out/renderer/.
const preloadPath = fileURLToPath(new URL("../preload/index.cjs", import.meta.url));
const rendererDir = fileURLToPath(new URL("../renderer", import.meta.url));

/*
 * One copy of the app at a time, per profile. A second copy would have its own save
 * queues and could write the same case or settings file as the first, the last rename
 * winning; it would also take the first's temporary files for leftovers of a crash
 * (src/main/durable-write.ts). A second start shows the window already open and quits.
 */
const isFirstInstance = app.requestSingleInstanceLock();
if (!isFirstInstance) app.quit();

hardenWebContents();
registerAppScheme();

let mainWindow: BrowserWindow | null = null;

// The user's settings, in the app's own data folder. The first-run language follows the
// system's preferred languages (read only when first needed, after the app is ready).
const settings = new SettingsStore(path.join(app.getPath("userData"), SETTINGS_FILE_NAME), () => ({
  language: defaultLanguage(app.getPreferredSystemLanguages()),
  casesFolder: null,
}));

/**
 * The home folder, where the default cases folder goes (src/main/paths.ts). The window
 * tests start the built app with --home-folder=<a temporary folder>; a packaged app
 * ignores the option. It only moves the default; a folder chosen in Settings wins.
 */
function homeFolder(): string {
  return resolveHomeFolder({ isPackaged: app.isPackaged, override: app.commandLine.getSwitchValue("home-folder"), home: app.getPath("home") });
}

// The cases, in the folder chosen in Settings or in <home>/ABA Workbench.
const cases = new CaseLibrary({
  location: async () => {
    const fallback = defaultCasesFolder(homeFolder());
    const chosen = (await settings.get()).casesFolder;
    return { folder: chosen ?? fallback, isDefault: chosen === null || chosen === fallback };
  },
});

// The AI connections: the Claude key and the ChatGPT sign-in, in credentials.json in the
// app's own data folder, owner-only (src/main/credentials.ts). The interface is told each
// change as a state, never a key or a token.
const credentials = new CredentialsStore(path.join(app.getPath("userData"), CREDENTIALS_FILE_NAME));
const chatgpt = new ChatGptSession({
  store: credentials,
  // The system browser, never a window of the app: the user signs in on OpenAI's own page.
  openBrowser: (url) => shell.openExternal(url),
  language: async () => (await settings.get()).language,
  onChange: () => void connections.changed(),
});
const connections = new ConnectionService({
  store: credentials,
  chatgpt,
  welcome: {
    shown: async () => (await settings.get()).chatgptWelcomeShown === true,
    markShown: async () => void (await settings.markChatGptWelcomeShown()),
  },
  claude: anthropicProvider,
  onChange: (state) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC_CHANNELS.connectionsChanged, state);
  },
});

registerIpc({
  rulesDir,
  settings,
  cases,
  connections,
  isTrustedSender: (event) => mainWindow !== null && event.sender === mainWindow.webContents && isTrustedFrame(event.senderFrame, trustedOrigin),
});

/*
 * Nothing typed is lost on close or quit (src/main/close-guard.ts): the window's close
 * waits for the interface to save what is still waiting, and for the case work here.
 */
let quitting = false;
const flushRequests = new Map<string, (result: { ok: boolean }) => void>();

ipcMain.on(IPC_CHANNELS.savesFlushed, (event, requestId: unknown, result: unknown) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || !isTrustedFrame(event.senderFrame, trustedOrigin)) return;
  if (typeof requestId !== "string") return;
  const done = flushRequests.get(requestId);
  flushRequests.delete(requestId);
  done?.({ ok: typeof result === "object" && result !== null && (result as { ok?: unknown }).ok === true });
});

function flushInterface(window: BrowserWindow): Promise<{ ok: boolean } | "timeout" | "gone"> {
  // A crashed page has nothing left to save, and cannot answer.
  if (window.webContents.isCrashed()) return Promise.resolve("gone");
  const requestId = randomUUID();
  const answer = new Promise<{ ok: boolean }>((resolve) => flushRequests.set(requestId, resolve));
  window.webContents.send(IPC_CHANNELS.flushSaves, requestId);
  return withTimeout(answer, FLUSH_TIMEOUT_MS, "timeout" as const).finally(() => flushRequests.delete(requestId));
}

async function askAboutUnsaved(window: BrowserWindow, problem: UnsavedProblem): Promise<"stay" | "close"> {
  const words = UNSAVED_DIALOG[(await settings.get()).language];
  const { response } = await dialog.showMessageBox(window, {
    type: "warning",
    message: words[problem].message,
    detail: words[problem].detail,
    buttons: [words.stay, words.close],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  return response === 1 ? "close" : "stay";
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    // Below this the interface still works, but a window this small is more likely a mistake.
    minWidth: 480,
    minHeight: 480,
    // The sidebar's color (--color-nav), so the window does not flash white before the interface paints.
    backgroundColor: WINDOW_BACKGROUND,
    show: false,
    title: app.getName(),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  mainWindow = window;
  window.once("ready-to-show", () => window.show());
  window.on(
    "close",
    createCloseGuard({
      flush: () => flushInterface(window),
      idle: () => cases.idle(IDLE_TIMEOUT_MS),
      ask: (problem) => askAboutUnsaved(window, problem),
      close: () => window.close(),
      quit: () => app.quit(),
      isQuitting: () => quitting,
      cancelQuit: () => {
        quitting = false;
      },
      isDestroyed: () => window.isDestroyed(),
    }),
  );
  // Its generations stop when its page goes away (src/main/ipc.ts).
  window.on("closed", () => {
    mainWindow = null;
  });
  void window.loadURL(devServerUrl ?? `${APP_ORIGIN}/index.html`);
}

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.whenReady().then(() => {
  if (!isFirstInstance) return;
  denyAllPermissions();
  serveRenderer(rendererDir);
  if (!existsSync(path.join(rulesDir, "assessment.md"))) {
    // Main-process log only; the interface never sees the path.
    console.error(`The writing rules were not found in ${rulesDir}. Generations will fail.`);
  }
  createWindow();
  // While the app runs, a ChatGPT sign-in is refreshed before its token expires.
  chatgpt.schedule();
  // macOS only: clicking the Dock icon with no window open opens one again.
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Quitting closes the window, whose guard saves first. With no window open (macOS), case
// work still under way finishes first, for at most IDLE_TIMEOUT_MS.
let waitedForCases = false;
app.on("before-quit", (event) => {
  quitting = true;
  if (mainWindow || waitedForCases || !cases.busy) return;
  waitedForCases = true;
  event.preventDefault();
  void cases.idle(IDLE_TIMEOUT_MS).finally(() => app.quit());
});

/*
 * A renewed ChatGPT sign-in that could not be saved (a full or read-only disk) lives only
 * in memory: one last try to write it before the app quits, for at most 3 seconds, so the
 * rotated refresh token is not lost if the disk has recovered.
 */
let lastSaveTried = false;
app.on("before-quit", (event) => {
  if (lastSaveTried || !credentials.hasUnsavedChange) return;
  lastSaveTried = true;
  event.preventDefault();
  void Promise.race([credentials.saveUnsaved(), new Promise((resolve) => setTimeout(resolve, 3000))]).finally(() => app.quit());
});

// Platform convention: on macOS an app stays running with no windows; elsewhere it quits.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
