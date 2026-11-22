import { app, BrowserWindow } from "electron";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerIpc } from "./ipc.ts";
import { resolveRulesDir } from "./paths.ts";
import { APP_ORIGIN, registerAppScheme, serveRenderer } from "./protocol.ts";
import { denyAllPermissions, hardenWebContents } from "./security.ts";
import { defaultLanguage, SETTINGS_FILE_NAME, SettingsStore } from "./settings.ts";
import { isTrustedFrame } from "./trust.ts";

// electron-vite sets ELECTRON_RENDERER_URL in development (its Vite dev server). A packaged
// app ignores it, so an environment variable cannot point the window at another page.
const devServerUrl = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL;
const trustedOrigin = devServerUrl ? new URL(devServerUrl).origin : APP_ORIGIN;
const rulesDir = resolveRulesDir({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() });
// The build output: out/main/index.js, out/preload/index.cjs, out/renderer/.
const preloadPath = fileURLToPath(new URL("../preload/index.cjs", import.meta.url));
const rendererDir = fileURLToPath(new URL("../renderer", import.meta.url));

hardenWebContents();
registerAppScheme();

let mainWindow: BrowserWindow | null = null;

// The user's settings, in the app's own data folder. The first-run language follows the
// system's preferred languages (read only when first needed, after the app is ready).
const settings = new SettingsStore(path.join(app.getPath("userData"), SETTINGS_FILE_NAME), () => ({
  language: defaultLanguage(app.getPreferredSystemLanguages()),
}));

registerIpc({
  rulesDir,
  settings,
  isTrustedSender: (event) => mainWindow !== null && event.sender === mainWindow.webContents && isTrustedFrame(event.senderFrame, trustedOrigin),
});

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    // Below this the interface still works, but a window this small is more likely a mistake.
    minWidth: 480,
    minHeight: 480,
    // The sidebar's color, so the window does not flash white before the interface paints.
    backgroundColor: "#1b2530",
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
  // Its generations stop when its page goes away (src/main/ipc.ts).
  window.on("closed", () => {
    mainWindow = null;
  });
  void window.loadURL(devServerUrl ?? `${APP_ORIGIN}/index.html`);
}

app.whenReady().then(() => {
  denyAllPermissions();
  serveRenderer(rendererDir);
  if (!existsSync(path.join(rulesDir, "assessment.md"))) {
    // Main-process log only; the interface never sees the path.
    console.error(`The writing rules were not found in ${rulesDir}. Generations will fail.`);
  }
  createWindow();
  // macOS only: clicking the Dock icon with no window open opens one again.
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Platform convention: on macOS an app stays running with no windows; elsewhere it quits.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
