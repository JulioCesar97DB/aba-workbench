/*
 * The de-identification worker thread: built as out/main/deidentify-worker.js and started by
 * DeidentifyThread (off-thread.ts) inside the main process, so a 2 MB text never holds up the
 * main process's event loop (and through it the window). It keeps one Deidentifier for its
 * sheet: the same placeholders across every text it is given.
 */
import { parentPort, workerData } from "node:worker_threads";
import { Deidentifier, type DeidentifyOptions } from "./deidentify.ts";
import type { ClientSheet } from "./sheet.ts";

export interface ThreadRequest {
  id: number;
  text: string;
}

const { sheet, options } = workerData as { sheet: ClientSheet; options: DeidentifyOptions };
const deidentifier = new Deidentifier(sheet, options);

parentPort?.on("message", (request: ThreadRequest) => {
  try {
    parentPort?.postMessage({ id: request.id, result: deidentifier.deidentify(request.text) });
  } catch (error) {
    parentPort?.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) });
  }
});
