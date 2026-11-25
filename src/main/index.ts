import { app, BrowserWindow, clipboard, ClipboardItem, dialog, ipcMain, Menu, shell } from "electron";
import { appMenuTemplate } from "./app-menu.ts";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CaseLibrary } from "./cases.ts";
import { FailedSaves, runSaves } from "./failed-saves.ts";
import { createCloseGuard, createQuitWait, SAVE_WAIT_MS, UNSAVED_DIALOG, withTimeout, type UnsavedProblem } from "./close-guard.ts";
import { ChatGptSession } from "./chatgpt-session.ts";
import { ConnectionService } from "./connections.ts";
import { CREDENTIALS_FILE_NAME, CredentialsStore } from "./credentials.ts";
import { anthropicProvider } from "../lib/providers/anthropic.ts";
import { openaiProvider } from "../lib/providers/openai.ts";
import { INSTRUCTIONS_FILE_NAME, InstructionsStore } from "./instructions.ts";
import { SectionService } from "./sections.ts";
import { CaseMapService } from "./case-map-service.ts";
import { IPC_CHANNELS } from "../shared/api.ts";
import { defaultCasesFolder, installFolder, isInsideOnDisk } from "./cases-folder.ts";
import { registerIpc } from "./ipc.ts";
import { APP_ID, resolveHiddenMode, resolveHomeFolder, resolveJudgeEnabled, resolveRulesDir } from "./paths.ts";
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

/*
 * Hidden mode, development only (src/main/paths.ts): the window is made and works as
 * usual but is never shown, the app has no Dock icon and never becomes the active app
 * (macOS's "accessory" policy), and the page is not throttled for being hidden, so the
 * window tests and scripts can run while someone works on the same computer.
 */
const hidden = resolveHiddenMode({ isPackaged: app.isPackaged, requested: app.commandLine.hasSwitch("hidden") });
if (hidden && process.platform === "darwin") {
  app.setActivationPolicy("accessory");
  app.dock?.hide();
}
/*
 * Windows: Chromium draws a window that is never shown at one frame a second, whatever
 * backgroundThrottling says. Every requestAnimationFrame and CSS transition then takes
 * seconds: a dialog's 150 ms closing took 2 to 5 s on the runners, past the tests' waits
 * (dev runs 45655443351, 45655474782). Without the limit the hidden window draws at the
 * display's rate, as a shown one does.
 */
if (hidden && process.platform === "win32") app.commandLine.appendSwitch("disable-frame-rate-limit");

/*
 * Windows: the installed app's taskbar identity is its appId, the one the installer gives
 * its Start menu and Desktop shortcuts, so the running window and a pinned shortcut share
 * one taskbar button. Not set when it runs from the repository.
 */
if (process.platform === "win32" && app.isPackaged) app.setAppUserModelId(APP_ID);

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

/*
 * The packaged app's own install folder, which an update or uninstalling deletes whole: a
 * cases folder in it, by any name, is refused when chosen and, if the settings already
 * name one, reported and never used (owner's decision, 2026-11-23).
 */
const appFolder = installFolder({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath });
async function insideApp(folder: string): Promise<boolean> {
  return appFolder !== null && (await isInsideOnDisk(folder, appFolder));
}

// The cases, in the folder chosen in Settings or in <home>/ABA Workbench.
const cases = new CaseLibrary({
  insideApp,
  location: async () => {
    const fallback = defaultCasesFolder(homeFolder());
    const chosen = (await settings.get()).casesFolder;
    return { folder: chosen ?? fallback, isDefault: chosen === null || chosen === fallback };
  },
});

// Changes to sources that could not be saved, kept while the app runs (a reload does not forget them).
// Section text, instructions and notes go through it too (made below; used only once a save runs).
const failedSaves = new FailedSaves({ run: runSaves(cases, () => sections, () => caseMap), labelOf: (caseId) => cases.labelOf(caseId) });

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

// The report's sections: her standing instructions per section live in the app's own
// data folder (instructions.json), everything else in each case's data file.
const instructionsStore = new InstructionsStore(path.join(app.getPath("userData"), INSTRUCTIONS_FILE_NAME));
const sections = new SectionService({
  cases,
  instructions: instructionsStore,
  rulesDir,
  provider: (id) => (id === "anthropic" ? anthropicProvider : openaiProvider),
  credential: (id) => connections.credentialFor(id),
  chosenModel: async (id) => (await settings.get()).models?.[id] ?? null,
  rememberProvider: (id) => settings.setLastProvider(id),
  claudeKeyRefused: () => connections.claudeKeyRefused(),
  // Both forms in one item, written at once: plain text and minimal HTML.
  writeClipboard: (content) => clipboard.write([new ClipboardItem({ "text/plain": content.text, "text/html": content.html })]),
});

// The case map (step 1 of the AI knowledge plan): inside each case's data file, drafted by
// the AI with the same connections, models and rules as the sections.
const caseMap = new CaseMapService({
  cases,
  ai: {
    instructions: instructionsStore,
    rulesDir,
    provider: (id) => (id === "anthropic" ? anthropicProvider : openaiProvider),
    credential: (id) => connections.credentialFor(id),
    chosenModel: async (id) => (await settings.get()).models?.[id] ?? null,
    rememberProvider: (id) => settings.setLastProvider(id),
  },
});

registerIpc({
  rulesDir,
  settings,
  cases,
  failedSaves,
  connections,
  sections,
  caseMap,
  isTrustedSender: (event) => mainWindow !== null && event.sender === mainWindow.webContents && isTrustedFrame(event.senderFrame, trustedOrigin),
  insideApp,
  // The evaluation's judge (pnpm eval) only where scripts drive the app: development, hidden.
  judgeEnabled: resolveJudgeEnabled({ isPackaged: app.isPackaged, hidden }),
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

/**
 * Asks the interface to save everything still waiting, within `timeoutMs`. `ok` is false
 * when a change could not be saved, as the interface says or as the main process keeps it.
 */
async function flushInterface(window: BrowserWindow, timeoutMs: number): Promise<{ ok: boolean } | "timeout" | "gone"> {
  // A crashed page has nothing left to save, and cannot answer.
  if (window.webContents.isCrashed()) return "gone";
  const requestId = randomUUID();
  const answer = new Promise<{ ok: boolean }>((resolve) => flushRequests.set(requestId, resolve));
  window.webContents.send(IPC_CHANNELS.flushSaves, requestId);
  const result = await withTimeout(answer, timeoutMs, "timeout" as const).finally(() => flushRequests.delete(requestId));
  return result === "timeout" ? result : { ok: result.ok && failedSaves.size === 0 };
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
    // Hidden mode: not in the taskbar (Windows, Linux) either.
    skipTaskbar: hidden,
    title: app.getName(),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // No developer tools in the packaged app, by any path (owner's decision, 2026-11-22; src/main/app-menu.ts).
      devTools: !app.isPackaged,
      // A hidden window would otherwise have its timers slowed (the saves wait on them).
      backgroundThrottling: !hidden,
    },
  });
  mainWindow = window;
  if (!hidden) window.once("ready-to-show", () => window.show());
  // Set once the close guard lets the window close: an unload the page then holds is that close, not a reload.
  let closing = false;
  window.on(
    "close",
    createCloseGuard({
      flush: (ms) => flushInterface(window, ms),
      idle: (ms) => cases.idle(ms),
      ask: (problem) => askAboutUnsaved(window, problem),
      close: () => {
        closing = true;
        window.close();
      },
      quit: () => app.quit(),
      isQuitting: () => quitting,
      cancelQuit: () => {
        quitting = false;
      },
      isDestroyed: () => window.isDestroyed(),
    }),
  );
  /*
   * A reload (Cmd+R in a development build, Force Reload, the page reloading itself) while
   * saves are under way: the page holds its unload (holdUnloadForSaves in
   * src/renderer/src/case-saves.tsx) after sending what was still waiting. The saves finish
   * here, within SAVE_WAIT_MS, then the page reloads. What could not be saved stays in
   * failedSaves, so the reloaded page shows it again. Not calling preventDefault keeps the page.
   */
  let reloading = false;
  // A page that reloads starts with no box showing a kept text: each box tells again when it shows one (review round 3, R3-1).
  window.webContents.on("did-navigate", () => failedSaves.newPage());
  window.webContents.on("render-process-gone", () => failedSaves.newPage());

  window.webContents.on("will-prevent-unload", (event) => {
    if (closing) {
      // The window is closing (its guard already saved): the saves still running finish here, without the page.
      event.preventDefault();
      return;
    }
    if (reloading) return;
    reloading = true;
    const deadline = Date.now() + SAVE_WAIT_MS;
    void flushInterface(window, SAVE_WAIT_MS)
      .then(() => cases.idle(Math.max(0, deadline - Date.now())))
      .finally(() => {
        reloading = false;
        if (!window.isDestroyed()) window.webContents.reload();
      });
  });
  // Its generations stop when its page goes away (src/main/ipc.ts).
  window.on("closed", () => {
    mainWindow = null;
  });
  void window.loadURL(devServerUrl ?? `${APP_ORIGIN}/index.html`);
}

app.on("second-instance", () => {
  if (!mainWindow || hidden) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.whenReady().then(() => {
  if (!isFirstInstance) return;
  denyAllPermissions();
  serveRenderer(rendererDir);
  // The packaged app's menu has no Reload and no developer tools (src/main/app-menu.ts).
  const menu = appMenuTemplate({ packaged: app.isPackaged, platform: process.platform });
  if (menu) Menu.setApplicationMenu(Menu.buildFromTemplate(menu));
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

/*
 * Before the app quits, one wait for everything that must not be cut short (one listener,
 * createQuitWait, so one wait can never let the quit through while the other runs):
 * - with no window open (macOS), case work still under way, for at most SAVE_WAIT_MS (with a
 *   window, its close guard saves first);
 * - a renewed ChatGPT sign-in that could not be saved (a full or read-only disk) lives only
 *   in memory: one last try to write it, for at most 3 seconds, so the rotated refresh
 *   token is not lost if the disk has recovered.
 */
app.on("before-quit", () => {
  quitting = true;
});
app.on(
  "before-quit",
  createQuitWait(
    () => [
      ...(!mainWindow && cases.busy ? [cases.idle(SAVE_WAIT_MS)] : []),
      ...(credentials.hasUnsavedChange ? [withTimeout(credentials.saveUnsaved(), 3000, undefined)] : []),
    ],
    () => app.quit(),
  ),
);

// Platform convention: on macOS an app stays running with no windows; elsewhere it quits.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
