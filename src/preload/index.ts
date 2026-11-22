import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { IPC_CHANNELS, type AbaApi, type GenerationUpdate } from "../shared/api.ts";

/*
 * Runs sandboxed, before the interface loads. It exposes the functions of AbaApi and
 * nothing else: never ipcRenderer itself, and never an IPC event object (whose sender
 * would hand the interface a way to send any message).
 */
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
  onGenerationUpdate: (listener) => {
    const handler = (_event: IpcRendererEvent, update: GenerationUpdate) => listener(update);
    ipcRenderer.on(IPC_CHANNELS.generationUpdate, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.generationUpdate, handler);
    };
  },
};

contextBridge.exposeInMainWorld("aba", api);
