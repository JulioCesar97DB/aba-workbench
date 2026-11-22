import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent, type WebContents } from "electron";
import {
  IPC_CHANNELS,
  type AppInfo,
  type CaseList,
  type CasesFolderInfo,
  type ChooseCasesFolderResult,
  type CreateCaseResult,
  type Language,
  type OpenCaseResult,
  type Settings,
} from "../shared/api.ts";
import type { CaseLibrary } from "./cases.ts";
import { inspectCasesFolder } from "./cases-folder.ts";
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
  cases: CaseLibrary;
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
    const platform = process.platform === "darwin" ? "mac" : process.platform === "win32" ? "windows" : "linux";
    return { name: app.getName(), version: app.getVersion(), developmentBuild: !app.isPackaged, platform };
  });

  // Only the language: the cases folder's path stays here (getCasesFolder shows it as text).
  ipcMain.handle(IPC_CHANNELS.getSettings, async (event): Promise<Settings> => {
    assertTrusted(event);
    return { language: (await options.settings.get()).language };
  });

  // The language is checked in SettingsStore.setLanguage: anything but "en" or "es" is refused.
  ipcMain.handle(IPC_CHANNELS.setLanguage, (event, language: unknown): Promise<Settings> => {
    assertTrusted(event);
    return options.settings.setLanguage(language).then(
      (saved) => ({ language: saved.language }),
      (error: unknown) => {
        throw safeError(error, "The settings could not be saved.");
      },
    );
  });

  /*
   * The cases folder and the cases (src/main/cases.ts checks every argument). Expected
   * outcomes (a missing folder, a damaged case) come back as values; an unexpected error
   * reaches the interface as a fixed message, its details only in this process's log.
   */
  ipcMain.handle(IPC_CHANNELS.getCasesFolder, async (event): Promise<CasesFolderInfo> => {
    assertTrusted(event);
    const info = await options.cases.folderInfo().catch((error: unknown) => {
      throw safeError(error, "The cases folder could not be checked.");
    });
    return withoutPath(info);
  });

  ipcMain.handle(IPC_CHANNELS.chooseCasesFolder, async (event): Promise<ChooseCasesFolderResult> => {
    assertTrusted(event);
    const window = BrowserWindow.fromWebContents(event.sender);
    const [{ language }, current] = await Promise.all([options.settings.get(), options.cases.folderInfo()]);
    const words = FOLDER_DIALOG[language];
    const dialogOptions: Electron.OpenDialogOptions = {
      title: words.title,
      message: words.title,
      buttonLabel: words.button,
      // Where the current folder is, or the home folder: never somewhere the user did not expect.
      defaultPath: current.state === "ready" || current.state === "not-writable" ? current.folder : app.getPath("home"),
      properties: ["openDirectory", "createDirectory", "dontAddToRecent"],
    };
    const result = window ? await dialog.showOpenDialog(window, dialogOptions) : await dialog.showOpenDialog(dialogOptions);
    const chosen = result.filePaths[0];
    if (result.canceled || !chosen) return { outcome: "cancelled" };
    const state = await inspectCasesFolder(chosen, false).catch(() => "not-allowed" as const);
    if (state !== "ready") return { outcome: "unusable", problem: state === "not-created-yet" ? "missing" : state };
    try {
      await options.settings.setCasesFolder(chosen);
    } catch (error) {
      console.error("The cases folder could not be saved in the settings:", error);
      return { outcome: "not-saved" };
    }
    return { outcome: "chosen", folder: withoutPath(await options.cases.folderInfo()) };
  });

  ipcMain.handle(IPC_CHANNELS.showCasesFolder, async (event): Promise<boolean> => {
    assertTrusted(event);
    const { folder, state } = await options.cases.folderInfo();
    if (state !== "ready" && state !== "not-writable") return false;
    // openPath answers "" when it worked, or an error message.
    return (await shell.openPath(folder)) === "";
  });

  ipcMain.handle(IPC_CHANNELS.listCases, (event): Promise<CaseList> => {
    assertTrusted(event);
    return options.cases.list().catch((error: unknown) => {
      throw safeError(error, "The cases could not be listed.");
    });
  });

  ipcMain.handle(IPC_CHANNELS.createCase, (event, input: unknown): Promise<CreateCaseResult> => {
    assertTrusted(event);
    return options.cases.create(input).catch((error: unknown) => {
      throw safeError(error, "The case could not be created.");
    });
  });

  ipcMain.handle(IPC_CHANNELS.openCase, (event, caseId: unknown): Promise<OpenCaseResult> => {
    assertTrusted(event);
    return options.cases.open(caseId).catch((error: unknown) => {
      throw safeError(error, "The case could not be opened.");
    });
  });

  ipcMain.handle(IPC_CHANNELS.showUnreadableFolder, async (event, folderName: unknown): Promise<boolean> => {
    assertTrusted(event);
    const target = await options.cases.unreadableFolderPath(folderName).catch((error: unknown) => {
      throw safeError(error, "The folder could not be shown.");
    });
    if (!target) return false;
    shell.showItemInFolder(target);
    return true;
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

/** The folder dialog's words, in the screen language (the main process draws that dialog). */
const FOLDER_DIALOG: Record<Language, { title: string; button: string }> = {
  en: { title: "Choose the folder for your cases", button: "Choose" },
  es: { title: "Elige la carpeta para tus casos", button: "Elegir" },
};

/**
 * What the interface may see of an error: a refusal of its own input as it is (it holds
 * nothing from the disk), anything else as `message`, with the details logged here.
 */
export function safeError(error: unknown, message: string): Error {
  if (error instanceof Error && error.message.startsWith("Refused:")) return new Error(error.message.slice(0, 200));
  console.error(message, error);
  return new Error(message);
}

/** What the interface gets of the cases folder: the path as display text, never the working one. */
function withoutPath(info: CasesFolderInfo): CasesFolderInfo {
  return { displayPath: info.displayPath, isDefault: info.isDefault, state: info.state };
}
