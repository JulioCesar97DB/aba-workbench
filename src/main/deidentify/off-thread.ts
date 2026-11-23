/*
 * De-identification off the main process's event loop: a worker thread inside the main
 * process (not another process: the process boundary is unchanged). The part-2 screen shows
 * `state`: "preparing" from the moment a text is handed over until its result is back, so the
 * window is never frozen and never silent while a long PDF text is read.
 *
 *   const thread = new DeidentifyThread(sheet, { today });
 *   thread.onState((state) => send("deidentify-state", state));
 *   const result = await thread.deidentify(text);   // in order, the same placeholders across texts
 *   await thread.close();
 */
import path from "node:path";
import { Worker } from "node:worker_threads";
import type { DeidentifyOptions, DeidentifyResult } from "./deidentify.ts";
import type { ClientSheet } from "./sheet.ts";

export type DeidentifyState = "idle" | "preparing" | "closed";

interface Pending {
  resolve: (result: DeidentifyResult) => void;
  reject: (error: Error) => void;
}

/** The built worker: out/main/deidentify-worker.js, next to the main process bundle. */
export const DEFAULT_WORKER_SCRIPT = path.join(import.meta.dirname, "deidentify-worker.js");

export class DeidentifyThread {
  readonly #worker: Worker;
  readonly #pending = new Map<number, Pending>();
  readonly #listeners = new Set<(state: DeidentifyState) => void>();
  #next = 1;
  #state: DeidentifyState = "idle";

  constructor(sheet: ClientSheet, options: DeidentifyOptions = {}, script: string | URL = DEFAULT_WORKER_SCRIPT) {
    // A 2 MB text needs well under this; a runaway one ends the thread, not the app.
    this.#worker = new Worker(script, { workerData: { sheet, options }, resourceLimits: { maxOldGenerationSizeMb: 1024 } });
    this.#worker.on("message", (message: { id: number; result?: DeidentifyResult; error?: string }) => {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error !== undefined) pending.reject(new Error(message.error));
      else pending.resolve(message.result!);
      this.#settle();
    });
    const fail = (error: Error) => {
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
      this.#setState("closed");
    };
    this.#worker.on("error", fail);
    this.#worker.on("exit", (code) => fail(new Error(`The de-identification thread ended (code ${code}).`)));
  }

  get state(): DeidentifyState {
    return this.#state;
  }

  /** Called on every change of state; returns the function that stops it. */
  onState(listener: (state: DeidentifyState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** "preparing" is set before this returns, so the screen can show it before any work starts. */
  deidentify(text: string): Promise<DeidentifyResult> {
    if (this.#state === "closed") return Promise.reject(new Error("The de-identification thread is closed."));
    const id = this.#next++;
    const result = new Promise<DeidentifyResult>((resolve, reject) => this.#pending.set(id, { resolve, reject }));
    this.#setState("preparing");
    this.#worker.postMessage({ id, text });
    return result;
  }

  async close(): Promise<void> {
    if (this.#state === "closed") return;
    this.#setState("closed");
    await this.#worker.terminate();
  }

  #settle(): void {
    if (this.#state !== "closed" && this.#pending.size === 0) this.#setState("idle");
  }

  #setState(state: DeidentifyState): void {
    if (state === this.#state) return;
    this.#state = state;
    for (const listener of this.#listeners) listener(state);
  }
}
