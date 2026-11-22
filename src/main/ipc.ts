import { app, ipcMain, type IpcMainInvokeEvent, type WebContents } from "electron";
import { IPC_CHANNELS, type AppInfo, type Settings } from "../shared/api.ts";
import { runDevCheckGeneration } from "./dev-check.ts";
import { GenerationRegistry, MAX_RUNNING_PER_WINDOW } from "./generations.ts";
import type { SettingsStore } from "./settings.ts";

/**
 * The main-process side of window.aba (src/shared/api.ts). Every handler first checks
 * that the message comes from the app's own window; everything else is refused.
 */
export function registerIpc(options: {
  rulesDir: string;
  settings: SettingsStore;
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean;
}): void {
  const generations = new GenerationRegistry();
  const assertTrusted = (event: IpcMainInvokeEvent) => {
    if (!options.isTrustedSender(event)) throw new Error("Refused: the message does not come from the app's window.");
  };

  // A generation belongs to the page that started it. When that page goes away (reload,
  // navigation, renderer crash, window closed), nobody can see or cancel it any more, so
  // it stops: once real providers are connected, it would otherwise keep spending.
  // "did-navigate" fires only when a main-frame navigation commits (a reload does), so a
  // navigation the app blocks (security.ts) leaves the page and its generations alone;
  // "did-start-navigation" would fire before the block and kill them for nothing.
  const watched = new WeakSet<WebContents>();
  const watch = (contents: WebContents) => {
    if (watched.has(contents)) return;
    watched.add(contents);
    const id = contents.id;
    contents.on("did-navigate", () => generations.orphan(id));
    contents.on("render-process-gone", () => generations.orphan(id));
    contents.once("destroyed", () => generations.orphan(id));
  };

  ipcMain.handle(IPC_CHANNELS.getAppInfo, (event): AppInfo => {
    assertTrusted(event);
    return { name: app.getName(), version: app.getVersion(), developmentBuild: !app.isPackaged };
  });

  ipcMain.handle(IPC_CHANNELS.getSettings, (event): Promise<Settings> => {
    assertTrusted(event);
    return options.settings.get();
  });

  // The language is checked in SettingsStore.setLanguage: anything but "en" or "es" is refused.
  ipcMain.handle(IPC_CHANNELS.setLanguage, (event, language: unknown): Promise<Settings> => {
    assertTrusted(event);
    return options.settings.setLanguage(language).catch((error: unknown) => {
      // A safe message for the interface; the details (a path, say) stay in the main process's log.
      if (error instanceof Error && error.message.startsWith("Refused:")) throw error;
      console.error("The settings could not be saved:", error);
      throw new Error("The settings could not be saved.");
    });
  });

  ipcMain.handle(IPC_CHANNELS.startMockGeneration, (event, generationId: unknown): void => {
    assertTrusted(event);
    const sender = event.sender;
    watch(sender);
    const result = generations.start(
      sender.id,
      String(generationId),
      (signal) => runDevCheckGeneration({ rulesDir: options.rulesDir, signal }),
      (update) => {
        if (!sender.isDestroyed()) sender.send(IPC_CHANNELS.generationUpdate, update);
      },
    );
    if (result === "invalid-id") throw new Error("Refused: the generation id is not a new UUID.");
    if (result === "busy") throw new Error(`Refused: ${MAX_RUNNING_PER_WINDOW} generations are already running in this window.`);
  });

  ipcMain.handle(IPC_CHANNELS.cancelGeneration, (event, generationId: unknown): void => {
    assertTrusted(event);
    if (typeof generationId === "string") generations.cancel(event.sender.id, generationId);
  });
}
