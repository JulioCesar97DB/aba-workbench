import type { GenerationEvent } from "../lib/generation-events.ts";
import { isGenerationId, type GenerationUpdate } from "../shared/api.ts";

/**
 * The generations running in the main process, each with its own way to cancel.
 * Every generation ends with exactly one "finished" update, after its last event.
 */
export class GenerationRegistry {
  readonly #running = new Map<string, AbortController>();

  /** False when the id is not a UUID or is already running; nothing starts then. */
  start(
    generationId: string,
    run: (signal: AbortSignal) => AsyncIterable<GenerationEvent>,
    emit: (update: GenerationUpdate) => void,
  ): boolean {
    if (!isGenerationId(generationId) || this.#running.has(generationId)) return false;
    const controller = new AbortController();
    this.#running.set(generationId, controller);
    void this.#pump(generationId, controller.signal, run, emit);
    return true;
  }

  cancel(generationId: string): boolean {
    const controller = this.#running.get(generationId);
    controller?.abort();
    return controller !== undefined;
  }

  cancelAll(): void {
    for (const controller of this.#running.values()) controller.abort();
  }

  get size(): number {
    return this.#running.size;
  }

  async #pump(
    generationId: string,
    signal: AbortSignal,
    run: (signal: AbortSignal) => AsyncIterable<GenerationEvent>,
    emit: (update: GenerationUpdate) => void,
  ): Promise<void> {
    try {
      for await (const event of run(signal)) {
        if (signal.aborted) break;
        emit({ generationId, event });
      }
    } catch {
      // runGeneration already turns provider failures into error events; this is a bug
      // elsewhere, and its message could hold anything, so a generic one goes out.
      if (!signal.aborted) {
        emit({ generationId, event: { type: "error", code: "internal_error", message: "The generation stopped unexpectedly.", status: null } });
      }
    } finally {
      this.#running.delete(generationId);
      emit({ generationId, event: { type: "finished", cancelled: signal.aborted } });
    }
  }
}
