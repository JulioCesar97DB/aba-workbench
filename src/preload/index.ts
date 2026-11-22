import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { IPC_CHANNELS, type AbaApi, type Connections, type GenerationUpdate } from "../shared/api.ts";

/*
 * Runs sandboxed, before the interface loads. It exposes the functions of AbaApi and
 * nothing else: never ipcRenderer itself, and never an IPC event object (whose sender
 * would hand the interface a way to send any message).
 */
/*
 * The main process asks for the interface's saves before the window closes
 * (src/main/close-guard.ts). The preload always answers, at once when the interface has
 * not set its listener (nothing of it is loaded, so nothing is waiting).
 */
let flushListener: (() => Promise<{ ok: boolean }>) | null = null;
ipcRenderer.on(IPC_CHANNELS.flushSaves, (_event, requestId: unknown) => {
  const flushing = flushListener ? flushListener().then((result) => ({ ok: result.ok === true }), () => ({ ok: false })) : Promise.resolve({ ok: true });
  void flushing.then((result) => ipcRenderer.send(IPC_CHANNELS.savesFlushed, requestId, result));
});

const api: AbaApi = {
  getAppInfo: () => ipcRenderer.invoke(IPC_CHANNELS.getAppInfo),
  startMockGeneration: (generationId) => ipcRenderer.invoke(IPC_CHANNELS.startMockGeneration, generationId),
  cancelGeneration: (generationId) => ipcRenderer.invoke(IPC_CHANNELS.cancelGeneration, generationId),
  getSettings: () => ipcRenderer.invoke(IPC_CHANNELS.getSettings),
  setLanguage: (language) => ipcRenderer.invoke(IPC_CHANNELS.setLanguage, language),
  getCasesFolder: () => ipcRenderer.invoke(IPC_CHANNELS.getCasesFolder),
  chooseCasesFolder: () => ipcRenderer.invoke(IPC_CHANNELS.chooseCasesFolder),
  showCasesFolder: () => ipcRenderer.invoke(IPC_CHANNELS.showCasesFolder),
  listCases: () => ipcRenderer.invoke(IPC_CHANNELS.listCases),
  createCase: (input) => ipcRenderer.invoke(IPC_CHANNELS.createCase, input),
  openCase: (caseId) => ipcRenderer.invoke(IPC_CHANNELS.openCase, caseId),
  showUnreadableFolder: (folderName) => ipcRenderer.invoke(IPC_CHANNELS.showUnreadableFolder, folderName),
  getConnections: () => ipcRenderer.invoke(IPC_CHANNELS.getConnections),
  saveClaudeKey: (key) => ipcRenderer.invoke(IPC_CHANNELS.saveClaudeKey, key),
  checkClaudeKey: () => ipcRenderer.invoke(IPC_CHANNELS.checkClaudeKey),
  removeClaudeKey: () => ipcRenderer.invoke(IPC_CHANNELS.removeClaudeKey),
  signInToChatGpt: () => ipcRenderer.invoke(IPC_CHANNELS.signInToChatGpt),
  cancelChatGptSignIn: () => ipcRenderer.invoke(IPC_CHANNELS.cancelChatGptSignIn),
  checkChatGpt: () => ipcRenderer.invoke(IPC_CHANNELS.checkChatGpt),
  signOutOfChatGpt: () => ipcRenderer.invoke(IPC_CHANNELS.signOutOfChatGpt),
  forgetChatGptAccount: () => ipcRenderer.invoke(IPC_CHANNELS.forgetChatGptAccount),
  openChatGptUsage: () => ipcRenderer.invoke(IPC_CHANNELS.openChatGptUsage),
  dismissChatGptWelcome: () => ipcRenderer.invoke(IPC_CHANNELS.dismissChatGptWelcome),
  startOverConnections: () => ipcRenderer.invoke(IPC_CHANNELS.startOverConnections),
  onConnectionsChange: (listener) => {
    const handler = (_event: IpcRendererEvent, connections: Connections) => listener(connections);
    ipcRenderer.on(IPC_CHANNELS.connectionsChanged, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.connectionsChanged, handler);
    };
  },
  addTextSource: (caseId, input) => ipcRenderer.invoke(IPC_CHANNELS.addTextSource, caseId, input),
  changeSource: (caseId, sourceId, change) => ipcRenderer.invoke(IPC_CHANNELS.changeSource, caseId, sourceId, change),
  removeSource: (caseId, sourceId) => ipcRenderer.invoke(IPC_CHANNELS.removeSource, caseId, sourceId),
  restoreSource: (caseId, sourceId) => ipcRenderer.invoke(IPC_CHANNELS.restoreSource, caseId, sourceId),
  readSourceText: (caseId, sourceId) => ipcRenderer.invoke(IPC_CHANNELS.readSourceText, caseId, sourceId),
  choosePdfs: (caseId) => ipcRenderer.invoke(IPC_CHANNELS.choosePdfs, caseId),
  addDroppedPdf: (caseId, pdf) => ipcRenderer.invoke(IPC_CHANNELS.addDroppedPdf, caseId, pdf),
  addFolderPdf: (caseId, fileName) => ipcRenderer.invoke(IPC_CHANNELS.addFolderPdf, caseId, fileName),
  openSourcePdf: (caseId, sourceId) => ipcRenderer.invoke(IPC_CHANNELS.openSourcePdf, caseId, sourceId),
  listFailedSaves: () => ipcRenderer.invoke(IPC_CHANNELS.listFailedSaves),
  retryFailedSave: (id) => ipcRenderer.invoke(IPC_CHANNELS.retryFailedSave, id),
  onFlushSaves: (listener) => {
    flushListener = listener;
    return () => {
      if (flushListener === listener) flushListener = null;
    };
  },
  onGenerationUpdate: (listener) => {
    const handler = (_event: IpcRendererEvent, update: GenerationUpdate) => listener(update);
    ipcRenderer.on(IPC_CHANNELS.generationUpdate, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.generationUpdate, handler);
    };
  },
};

contextBridge.exposeInMainWorld("aba", api);
