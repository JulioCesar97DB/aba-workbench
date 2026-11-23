/*
 * The reading process in the app: an Electron utility process running the bundled
 * child (out/main/pdf-text-child.js, a second main-process entry in electron.vite.config.ts).
 * Used through extractPdfTextIsolated (isolated.ts).
 * - Its heap is capped and code generation from strings is off (CHILD_JS_FLAGS): a utility
 *   process takes V8 flags through --js-flags; a bare --max-old-space-size is ignored
 *   (checked on Electron 45.4.1).
 * - Its whole memory is checked every 250 ms, and it is killed above CHILD_MEMORY_LIMIT_MB
 *   ("too-large"): a decompressed stream lives outside the heap the flag caps.
 * - It gets an environment of its own, with one variable: none of the app's (such as a
 *   provider key set in a shell profile) reaches it. It still runs with the user's file and network access:
 *   a Node.js utility process cannot be sandboxed.
 */
import { app, utilityProcess } from "electron";
import path from "node:path";
import { CHILD_JS_FLAGS, CHILD_MEMORY_LIMIT_MB, type ChildHandle } from "./isolated.ts";

export function spawnElectronPdfChild(): ChildHandle {
  const child = utilityProcess.fork(path.join(import.meta.dirname, "pdf-text-child.js"), [], {
    serviceName: "ABA Workbench PDF reader",
    execArgv: [`--js-flags=${CHILD_JS_FLAGS}`],
    // Electron 45 reads an empty env as "inherit everything"; one variable of our own replaces the whole environment.
    env: { ABA_WORKBENCH_PDF_READER: "1" },
    stdio: "ignore",
  });
  let overLimit = false;
  const watch = setInterval(() => {
    const metric = child.pid === undefined ? undefined : app.getAppMetrics().find((m) => m.pid === child.pid);
    // workingSetSize is in kilobytes.
    if (metric && metric.memory.workingSetSize > CHILD_MEMORY_LIMIT_MB * 1024) {
      overLimit = true;
      child.kill();
    }
  }, 250);
  child.once("exit", () => clearInterval(watch));
  return {
    postMessage: (message) => child.postMessage(message),
    onMessage: (listener) => child.on("message", listener),
    onExit: (listener) => child.on("exit", (code) => listener(code, overLimit ? "too-large" : undefined)),
    kill: () => {
      clearInterval(watch);
      child.kill();
    },
  };
}
