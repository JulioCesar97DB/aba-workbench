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
 *
 * A call that takes longer than `timeoutMs` (30 s by default; a 2 MB text takes about 2 s) ends
 * the thread: that call and every pending one are rejected and the state is "closed". A closed
 * thread's placeholders are gone with it, so the caller starts a new thread and de-identifies
 * every source of the request again; it never mixes results of two threads. An idle thread
 * never keeps the app's process alive.
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

export const DEFAULT_TIMEOUT_MS = 30_000;

export interface ThreadOptions {
  /** The built worker script (out/main/deidentify-worker.js by default). */
  script?: string | URL;
  /** How long one call may take before the thread is ended (30 s by default). */
  timeoutMs?: number;
}

export class DeidentifyThread {
  readonly #worker: Worker;
  readonly #pending = new Map<number, Pending>();
  readonly #listeners = new Set<(state: DeidentifyState) => void>();
  readonly #timeoutMs: number;
  #next = 1;
  #state: DeidentifyState = "idle";
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(sheet: ClientSheet, options: DeidentifyOptions = {}, thread: ThreadOptions | string | URL = {}) {
    const { script = DEFAULT_WORKER_SCRIPT, timeoutMs = DEFAULT_TIMEOUT_MS } = typeof thread === "string" || thread instanceof URL ? { script: thread } : thread;
    this.#timeoutMs = timeoutMs;
    // A 2 MB text needs well under this; a runaway one ends the thread, not the app.
    this.#worker = new Worker(script, { workerData: { sheet, options }, resourceLimits: { maxOldGenerationSizeMb: 1024 } });
    // Idle, it never keeps the process alive; it is held only while a call is pending.
    this.#worker.unref();
    this.#worker.on("message", (message: { id: number; result?: DeidentifyResult; error?: string }) => {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error !== undefined) pending.reject(new Error(message.error));
      else pending.resolve(message.result!);
      this.#settle();
    });
    this.#worker.on("error", (error) => this.#fail(error));
    this.#worker.on("exit", (code) => this.#fail(new Error(`The de-identification thread ended (code ${code}).`)));
  }

  #fail(error: Error): void {
    clearTimeout(this.#timer);
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.#setState("closed");
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
    this.#worker.ref();
    this.#worker.postMessage({ id, text });
    // Calls run in order: the clock runs for the oldest pending one.
    if (this.#pending.size === 1) this.#startClock();
    return result;
  }

  #startClock(): void {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#fail(new Error(`De-identification took longer than ${this.#timeoutMs} ms; the thread was ended.`));
      void this.#worker.terminate();
    }, this.#timeoutMs);
  }

  async close(): Promise<void> {
    if (this.#state === "closed") return;
    clearTimeout(this.#timer);
    this.#setState("closed");
    await this.#worker.terminate();
  }

  #settle(): void {
    if (this.#state === "closed") return;
    if (this.#pending.size === 0) {
      clearTimeout(this.#timer);
      this.#worker.unref();
      this.#setState("idle");
    } else this.#startClock();
  }

  #setState(state: DeidentifyState): void {
    if (state === this.#state) return;
    this.#state = state;
    for (const listener of this.#listeners) listener(state);
  }
}
