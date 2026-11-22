import type { GenerationEvent } from "../lib/generation-events.ts";
import { isGenerationId, type GenerationUpdate } from "../shared/api.ts";

/**
 * How many generations one window may run at once. A generation spends the user's money
 * once real providers are connected, so the number is small; the interface runs one.
 */
export const MAX_RUNNING_PER_WINDOW = 2;

export type StartResult = "started" | "invalid-id" | "busy";

interface Running {
  /** Who started it: the id of the page's webContents. */
  owner: number;
  controller: AbortController;
  /** The page that started it is gone (reload, navigation, crash, close): send nothing more. */
  orphaned: boolean;
}

/**
 * The generations running in the main process. Each belongs to the page that started it
 * and can be cancelled only by that page; when the page goes away, its generations stop.
 * A generation ends with exactly one "finished" update after its last event, unless its
 * page went away, in which case nothing more is sent.
 */
export class GenerationRegistry {
  readonly #running = new Map<string, Running>();
  readonly #maxPerOwner: number;

  constructor(maxPerOwner = MAX_RUNNING_PER_WINDOW) {
    this.#maxPerOwner = maxPerOwner;
  }

  /** Nothing starts unless the id is a new UUID and the owner is under its limit. */
  start(
    owner: number,
    generationId: string,
    run: (signal: AbortSignal) => AsyncIterable<GenerationEvent>,
    emit: (update: GenerationUpdate) => void,
  ): StartResult {
    if (!isGenerationId(generationId) || this.#running.has(generationId)) return "invalid-id";
    if (this.countFor(owner) >= this.#maxPerOwner) return "busy";
    const entry: Running = { owner, controller: new AbortController(), orphaned: false };
    this.#running.set(generationId, entry);
    void this.#pump(generationId, entry, run, emit);
    return "started";
  }

  /** Cancels one of the owner's generations; false when it is not running or not theirs. */
  cancel(owner: number, generationId: string): boolean {
    const entry = this.#running.get(generationId);
    if (!entry || entry.owner !== owner) return false;
    entry.controller.abort();
    return true;
  }

  /** The owner's page went away: stop its generations and send nothing more for them. */
  orphan(owner: number): number {
    let stopped = 0;
    for (const entry of this.#running.values()) {
      if (entry.owner !== owner) continue;
      entry.orphaned = true;
      entry.controller.abort();
      stopped++;
    }
    return stopped;
  }

  countFor(owner: number): number {
    let count = 0;
    for (const entry of this.#running.values()) if (entry.owner === owner) count++;
    return count;
  }

  get size(): number {
    return this.#running.size;
  }

  async #pump(
    generationId: string,
    entry: Running,
    run: (signal: AbortSignal) => AsyncIterable<GenerationEvent>,
    emit: (update: GenerationUpdate) => void,
  ): Promise<void> {
    const { signal } = entry.controller;
    const send = (update: GenerationUpdate) => {
      if (!entry.orphaned) emit(update);
    };
    try {
      for await (const event of run(signal)) {
        if (signal.aborted) break;
        send({ generationId, event });
      }
    } catch {
      // runGeneration already turns provider failures into error events; this is a bug
      // elsewhere, and its message could hold anything, so a generic one goes out.
      if (!signal.aborted) {
        send({ generationId, event: { type: "error", code: "internal_error", message: "The generation stopped unexpectedly.", status: null } });
      }
    } finally {
      this.#running.delete(generationId);
      send({ generationId, event: { type: "finished", cancelled: signal.aborted } });
    }
  }
}
