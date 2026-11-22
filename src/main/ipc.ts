import { app, ipcMain, type IpcMainInvokeEvent } from "electron";
import { IPC_CHANNELS, type AppInfo } from "../shared/api.ts";
import { runDevCheckGeneration } from "./dev-check.ts";
import { GenerationRegistry } from "./generations.ts";

/**
 * The main-process side of window.aba (src/shared/api.ts). Every handler first checks
 * that the message comes from the app's own window; everything else is refused.
 */
export function registerIpc(options: { rulesDir: string; isTrustedSender: (event: IpcMainInvokeEvent) => boolean }): {
  cancelAll: () => void;
} {
  const generations = new GenerationRegistry();
  const assertTrusted = (event: IpcMainInvokeEvent) => {
    if (!options.isTrustedSender(event)) throw new Error("Refused: the message does not come from the app's window.");
  };

  ipcMain.handle(IPC_CHANNELS.getAppInfo, (event): AppInfo => {
    assertTrusted(event);
    return { name: app.getName(), version: app.getVersion() };
  });

  ipcMain.handle(IPC_CHANNELS.startMockGeneration, (event, generationId: unknown): void => {
    assertTrusted(event);
    const sender = event.sender;
    const started = generations.start(
      String(generationId),
      (signal) => runDevCheckGeneration({ rulesDir: options.rulesDir, signal }),
      (update) => {
        if (sender.isDestroyed()) generations.cancel(update.generationId);
        else sender.send(IPC_CHANNELS.generationUpdate, update);
      },
    );
    if (!started) throw new Error("Refused: the generation id is not a new UUID.");
  });

  ipcMain.handle(IPC_CHANNELS.cancelGeneration, (event, generationId: unknown): void => {
    assertTrusted(event);
    if (typeof generationId === "string") generations.cancel(generationId);
  });

  return { cancelAll: () => generations.cancelAll() };
}
