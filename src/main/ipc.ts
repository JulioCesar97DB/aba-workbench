import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent, type WebContents } from "electron";
import {
  IPC_CHANNELS,
  isCaseId,
  type AiPreferences,
  type AppInfo,
  type CaseList,
  type CasesFolderInfo,
  type ChatGptSignInResult,
  type ChatGptSignOutResult,
  type CheckConnectionResult,
  type ChooseCasesFolderResult,
  type Connections,
  type CreateCaseResult,
  type Language,
  type OpenCaseResult,
  type RemoveConnectionResult,
  type SaveClaudeKeyResult,
  type Settings,
  type StartOverResult,
  type StartSectionResult,
  isGenerationId,
} from "../shared/api.ts";
import type { AddPdfsResult, FailedSave, ReadSourceTextResult, SourceSaveResult } from "../shared/sources.ts";
import type { CaseLibrary } from "./cases.ts";
import type { FailedSaves } from "./failed-saves.ts";
import type { ConnectionService } from "./connections.ts";
import { inspectCasesFolder } from "./cases-folder.ts";
import { runDevCheckGeneration } from "./dev-check.ts";
import { GenerationRegistry, MAX_RUNNING_PER_WINDOW } from "./generations.ts";
import type { SettingsStore } from "./settings.ts";
import type { SectionService } from "./sections.ts";
import { defaultModel } from "../shared/models.ts";

/**
 * The main-process side of window.aba (src/shared/api.ts). Every handler first checks
 * that the message comes from the app's own window; everything else is refused.
 */
export function registerIpc(options: {
  rulesDir: string;
  settings: SettingsStore;
  cases: CaseLibrary;
  /** Changes to sources that could not be saved (src/main/failed-saves.ts); every change goes through it. */
  failedSaves: FailedSaves;
  connections: ConnectionService;
  sections: SectionService;
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean;
}): void {
  const generations = new GenerationRegistry();
  const aiPreferences = async (): Promise<AiPreferences> => {
    const saved = await options.settings.get();
    return {
      models: { anthropic: saved.models?.anthropic ?? defaultModel("anthropic"), openai: saved.models?.openai ?? defaultModel("openai") },
      lastProvider: saved.lastProvider ?? null,
    };
  };
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

  /*
   * The AI connections (src/main/connections.ts checks every argument). They answer with
   * states and outcomes only: no key or token ever crosses to the interface, and an
   * unexpected error reaches it as a fixed sentence (the key is never in the log either).
   */
  ipcMain.handle(IPC_CHANNELS.getConnections, (event): Promise<Connections> => {
    assertTrusted(event);
    return options.connections.get().catch((error: unknown) => {
      throw safeError(error, "The AI connections could not be checked.");
    });
  });

  ipcMain.handle(IPC_CHANNELS.saveClaudeKey, (event, key: unknown): Promise<SaveClaudeKeyResult> => {
    assertTrusted(event);
    return options.connections.saveClaudeKey(key).catch((error: unknown) => {
      throw safeError(error, "The Claude key could not be saved.");
    });
  });

  ipcMain.handle(IPC_CHANNELS.checkClaudeKey, (event): Promise<CheckConnectionResult> => {
    assertTrusted(event);
    return options.connections.checkClaudeKey().catch((error: unknown) => {
      throw safeError(error, "The Claude key could not be checked.");
    });
  });

  ipcMain.handle(IPC_CHANNELS.removeClaudeKey, (event): Promise<RemoveConnectionResult> => {
    assertTrusted(event);
    return options.connections.removeClaudeKey().catch((error: unknown) => {
      throw safeError(error, "The Claude key could not be removed.");
    });
  });

  // Opens the system browser at OpenAI's page and resolves when the attempt ends.
  ipcMain.handle(IPC_CHANNELS.signInToChatGpt, (event): Promise<ChatGptSignInResult> => {
    assertTrusted(event);
    return options.connections.signInToChatGpt().catch((error: unknown) => {
      throw safeError(error, "The ChatGPT sign-in could not be started.");
    });
  });

  ipcMain.handle(IPC_CHANNELS.cancelChatGptSignIn, (event): void => {
    assertTrusted(event);
    options.connections.cancelChatGptSignIn();
  });

  ipcMain.handle(IPC_CHANNELS.checkChatGpt, (event): Promise<CheckConnectionResult> => {
    assertTrusted(event);
    return options.connections.checkChatGpt().catch((error: unknown) => {
      throw safeError(error, "The ChatGPT sign-in could not be checked.");
    });
  });

  ipcMain.handle(IPC_CHANNELS.signOutOfChatGpt, (event): Promise<ChatGptSignOutResult> => {
    assertTrusted(event);
    return options.connections.signOutOfChatGpt().catch((error: unknown) => {
      throw safeError(error, "The ChatGPT sign-out could not be finished.");
    });
  });

  ipcMain.handle(IPC_CHANNELS.forgetChatGptAccount, (event): Promise<RemoveConnectionResult> => {
    assertTrusted(event);
    return options.connections.forgetChatGptAccount().catch((error: unknown) => {
      throw safeError(error, "The ChatGPT account could not be forgotten.");
    });
  });

  ipcMain.handle(IPC_CHANNELS.startOverConnections, (event): Promise<StartOverResult> => {
    assertTrusted(event);
    return options.connections.startOver().catch((error: unknown) => {
      throw safeError(error, "The saved connections could not be set aside.");
    });
  });

  ipcMain.handle(IPC_CHANNELS.dismissChatGptWelcome, (event): Promise<void> => {
    assertTrusted(event);
    return options.connections.dismissChatGptWelcome().catch((error: unknown) => {
      throw safeError(error, "That could not be saved, so it may show again next time.");
    });
  });

  // A fixed address: the interface cannot make the app open any other.
  ipcMain.handle(IPC_CHANNELS.openChatGptUsage, async (event): Promise<void> => {
    assertTrusted(event);
    await shell.openExternal(CHATGPT_USAGE_URL);
  });

  /*
   * A case's sources. CaseLibrary checks every argument (ids, the change, a dropped
   * PDF's name and size). The only paths here are the ones the system's file dialog
   * gives, which the user chose, and the case's own copy of a PDF, to open it.
   */
  const sourceCall = <T>(work: () => Promise<T>, message: string): Promise<T> =>
    work().catch((error: unknown) => {
      throw safeError(error, message);
    });

  ipcMain.handle(IPC_CHANNELS.addTextSource, (event, caseId: unknown, input: unknown): Promise<SourceSaveResult> => {
    assertTrusted(event);
    return sourceCall(() => options.failedSaves.save(caseId, { kind: "add-text", input }), "The text could not be added.");
  });

  ipcMain.handle(IPC_CHANNELS.changeSource, (event, caseId: unknown, sourceId: unknown, change: unknown): Promise<SourceSaveResult> => {
    assertTrusted(event);
    return sourceCall(() => options.failedSaves.save(caseId, { kind: "change", sourceId: sourceId as string, change: change as Record<string, unknown> }), "The source could not be saved.");
  });

  ipcMain.handle(IPC_CHANNELS.removeSource, (event, caseId: unknown, sourceId: unknown): Promise<SourceSaveResult> => {
    assertTrusted(event);
    return sourceCall(() => options.failedSaves.save(caseId, { kind: "removed", sourceId: sourceId as string, removed: true }), "The source could not be removed.");
  });

  ipcMain.handle(IPC_CHANNELS.restoreSource, (event, caseId: unknown, sourceId: unknown): Promise<SourceSaveResult> => {
    assertTrusted(event);
    return sourceCall(() => options.failedSaves.save(caseId, { kind: "removed", sourceId: sourceId as string, removed: false }), "The source could not be restored.");
  });

  ipcMain.handle(IPC_CHANNELS.listFailedSaves, (event): FailedSave[] => {
    assertTrusted(event);
    return options.failedSaves.list();
  });

  ipcMain.handle(IPC_CHANNELS.retryFailedSave, (event, id: unknown): Promise<SourceSaveResult> => {
    assertTrusted(event);
    return sourceCall(() => options.failedSaves.retry(id), "The change could not be saved.");
  });

  ipcMain.handle(IPC_CHANNELS.readSourceText, (event, caseId: unknown, sourceId: unknown): Promise<ReadSourceTextResult> => {
    assertTrusted(event);
    return sourceCall(() => options.cases.readSourceText(caseId, sourceId), "The text could not be read.");
  });

  ipcMain.handle(IPC_CHANNELS.choosePdfs, async (event, caseId: unknown): Promise<AddPdfsResult> => {
    assertTrusted(event);
    // Refused before any dialog opens.
    if (!isCaseId(caseId)) throw new Error("Refused: not a case id.");
    const window = BrowserWindow.fromWebContents(event.sender);
    const { language } = await options.settings.get();
    const words = PDF_DIALOG[language];
    const dialogOptions: Electron.OpenDialogOptions = {
      title: words.title,
      message: words.title,
      buttonLabel: words.button,
      defaultPath: app.getPath("home"),
      filters: [{ name: "PDF", extensions: ["pdf"] }],
      properties: ["openFile", "multiSelections", "dontAddToRecent"],
    };
    const result = window ? await dialog.showOpenDialog(window, dialogOptions) : await dialog.showOpenDialog(dialogOptions);
    if (result.canceled || result.filePaths.length === 0) return { outcome: "cancelled" };
    return sourceCall(() => options.cases.addChosenPdfs(caseId, result.filePaths.slice(0, 100)), "The PDFs could not be added.");
  });

  ipcMain.handle(IPC_CHANNELS.addDroppedPdf, (event, caseId: unknown, pdf: unknown): Promise<AddPdfsResult> => {
    assertTrusted(event);
    return sourceCall(() => options.cases.addDroppedPdf(caseId, pdf), "The PDF could not be added.");
  });

  ipcMain.handle(IPC_CHANNELS.addFolderPdf, (event, caseId: unknown, fileName: unknown): Promise<AddPdfsResult> => {
    assertTrusted(event);
    return sourceCall(() => options.cases.addFolderPdf(caseId, fileName), "The PDF could not be added.");
  });

  ipcMain.handle(IPC_CHANNELS.openSourcePdf, async (event, caseId: unknown, sourceId: unknown): Promise<boolean> => {
    assertTrusted(event);
    const file = await sourceCall(() => options.cases.sourcePdfPath(caseId, sourceId), "The PDF could not be opened.");
    if (!file) return false;
    return (await shell.openPath(file)) === "";
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

  /*
   * The report's sections (src/main/sections.ts checks every argument). A section's
   * generation belongs to the page that started it, like the development check's.
   */
  const sectionCall = <T>(work: () => Promise<T>, message: string): Promise<T> =>
    work().catch((error: unknown) => {
      throw safeError(error, message);
    });

  ipcMain.handle(IPC_CHANNELS.getSection, (event, caseId: unknown, sectionId: unknown) => {
    assertTrusted(event);
    return sectionCall(() => options.sections.get(caseId, sectionId), "The section could not be read.");
  });

  ipcMain.handle(IPC_CHANNELS.saveSectionText, (event, caseId: unknown, sectionId: unknown, text: unknown, editing: unknown) => {
    assertTrusted(event);
    return sectionCall(() => options.sections.saveText(caseId, sectionId, text, editing), "The text could not be saved.");
  });

  ipcMain.handle(IPC_CHANNELS.setCurrentVersion, (event, caseId: unknown, sectionId: unknown, version: unknown) => {
    assertTrusted(event);
    return sectionCall(() => options.sections.setCurrent(caseId, sectionId, version), "The version could not be shown.");
  });

  ipcMain.handle(IPC_CHANNELS.approveSection, (event, caseId: unknown, sectionId: unknown, version: unknown) => {
    assertTrusted(event);
    return sectionCall(() => options.sections.approve(caseId, sectionId, version), "The approval could not be saved.");
  });

  ipcMain.handle(IPC_CHANNELS.saveSectionInstructions, (event, sectionId: unknown, text: unknown) => {
    assertTrusted(event);
    return sectionCall(() => options.sections.saveInstructions(sectionId, text), "The instructions could not be saved.");
  });

  ipcMain.handle(IPC_CHANNELS.saveSessionNotes, (event, caseId: unknown, text: unknown) => {
    assertTrusted(event);
    return sectionCall(() => options.sections.saveNotes(caseId, text), "The notes could not be saved.");
  });

  ipcMain.handle(IPC_CHANNELS.startNewSession, (event, caseId: unknown) => {
    assertTrusted(event);
    return sectionCall(() => options.sections.startNewSession(caseId), "A new session could not be started.");
  });

  ipcMain.handle(IPC_CHANNELS.copySection, (event, caseId: unknown, sectionId: unknown, version: unknown) => {
    assertTrusted(event);
    return sectionCall(() => options.sections.copy(caseId, sectionId, version), "The section could not be copied.");
  });

  ipcMain.handle(IPC_CHANNELS.getAiPreferences, (event) => {
    assertTrusted(event);
    return sectionCall(aiPreferences, "The AI settings could not be read.");
  });

  ipcMain.handle(IPC_CHANNELS.setModel, (event, provider: unknown, model: unknown) => {
    assertTrusted(event);
    return sectionCall(async () => {
      await options.settings.setModel(provider, model);
      return aiPreferences();
    }, "The model could not be saved.");
  });

  ipcMain.handle(IPC_CHANNELS.startSectionGeneration, async (event, caseId: unknown, sectionId: unknown, generationId: unknown, provider: unknown, request: unknown): Promise<StartSectionResult> => {
    assertTrusted(event);
    if (!isGenerationId(generationId)) throw new Error("Refused: the generation id is not a new UUID.");
    const sender = event.sender;
    if (generations.countFor(sender.id) >= MAX_RUNNING_PER_WINDOW) return { outcome: "busy" };
    const ready = await sectionCall(() => options.sections.prepareGeneration(caseId, sectionId, provider, request), "The request could not be started.");
    if (ready.outcome !== "ready") return { outcome: ready.outcome };
    watch(sender);
    const result = generations.start(sender.id, generationId, ready.run, (update) => {
      if (!sender.isDestroyed()) sender.send(IPC_CHANNELS.generationUpdate, update);
    });
    if (result === "invalid-id") throw new Error("Refused: the generation id is not a new UUID.");
    return result === "busy" ? { outcome: "busy" } : { outcome: "started" };
  });

  ipcMain.handle(IPC_CHANNELS.cancelGeneration, (event, generationId: unknown): void => {
    assertTrusted(event);
    if (typeof generationId === "string") generations.cancel(event.sender.id, generationId);
  });
}

/** Where ChatGPT shows its usage and each app's access to the user's plan (OpenAI's UI guidelines). */
export const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";

/** The PDF dialog's words, in the screen language. */
const PDF_DIALOG: Record<Language, { title: string; button: string }> = {
  en: { title: "Choose PDFs to add to this case", button: "Add" },
  es: { title: "Elige los PDF que quieres agregar a este caso", button: "Agregar" },
};

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
