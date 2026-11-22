/*
 * The reading process in the app: an Electron utility process running the bundled
 * child (out/main/pdf-text-child.js, a second main-process entry in electron.vite.config.ts),
 * with its own heap cap. Used through extractPdfTextIsolated (isolated.ts).
 */
import { utilityProcess } from "electron";
import path from "node:path";
import { CHILD_HEAP_MB, type ChildHandle } from "./isolated.ts";

export function spawnElectronPdfChild(): ChildHandle {
  const child = utilityProcess.fork(path.join(import.meta.dirname, "pdf-text-child.js"), [], {
    serviceName: "ABA Workbench PDF reader",
    // A utility process takes V8 flags through --js-flags; a bare --max-old-space-size is ignored (checked on Electron 45.4.1).
    execArgv: [`--js-flags=--max-old-space-size=${CHILD_HEAP_MB}`],
    stdio: "ignore",
  });
  return {
    postMessage: (message) => child.postMessage(message),
    onMessage: (listener) => child.on("message", listener),
    onExit: (listener) => child.on("exit", listener),
    kill: () => void child.kill(),
  };
}
