import type { Language } from "../shared/api.ts";

/*
 * Nothing the clinician typed is lost when the window closes or the app quits (on
 * Windows and Linux, closing the last window quits). The window's first "close" is held
 * back while the interface saves what is still waiting for a typing pause and every save
 * under way finishes (flush), then the main process's own case work (idle); both are
 * bounded. If a change could not be saved, or saving did not finish in time, she is asked
 * whether to go back (the default) or close anyway. Nothing here imports Electron, so it
 * is unit-tested; src/main/index.ts wires it to the window, the app and the dialog.
 */

/**
 * How long the interface's saves and then the main process's case work have, together,
 * before she is asked (one deadline for both, so the wait is never longer). A save takes
 * milliseconds; this leaves room for a slow network or cloud folder.
 */
export const SAVE_WAIT_MS = 5_000;

export type UnsavedProblem = "failed" | "timeout";

export interface CloseGuardOptions {
  /** Asks the interface to save everything, within `timeoutMs`; "timeout" when it did not answer in time, "gone" when its page has crashed. */
  flush: (timeoutMs: number) => Promise<{ ok: boolean } | "timeout" | "gone">;
  /** Waits for the main process's case work, within `timeoutMs`; false if it did not finish in time. */
  idle: (timeoutMs: number) => Promise<boolean>;
  /** The one deadline for both waits (SAVE_WAIT_MS). */
  timeoutMs?: number;
  now?: () => number;
  /** Asks her what to do about a change that could not be saved. */
  ask: (problem: UnsavedProblem) => Promise<"stay" | "close">;
  /** Closes the window for real (the guard lets that close through). */
  close: () => void;
  /** Quits the app, when the close came from quitting. */
  quit: () => void;
  isQuitting: () => boolean;
  /** She chose to stay: the quit that started this is over. */
  cancelQuit: () => void;
  isDestroyed: () => boolean;
}

/** The window's "close" listener. */
export function createCloseGuard(options: CloseGuardOptions): (event: { preventDefault(): void }) => void {
  let allowed = false;
  let busy = false;
  return (event) => {
    if (allowed) return;
    event.preventDefault();
    if (busy) return;
    busy = true;
    void (async () => {
      let problem: UnsavedProblem | null = null;
      const now = options.now ?? Date.now;
      const deadline = now() + (options.timeoutMs ?? SAVE_WAIT_MS);
      try {
        const answer = await options.flush(Math.max(0, deadline - now()));
        const idle = await options.idle(Math.max(0, deadline - now()));
        if (answer === "timeout" || !idle) problem = "timeout";
        else if (answer !== "gone" && !answer.ok) problem = "failed";
      } catch {
        problem = "timeout";
      }
      busy = false;
      if (options.isDestroyed()) return;
      if (problem && (await options.ask(problem)) === "stay") {
        options.cancelQuit();
        return;
      }
      allowed = true;
      if (options.isQuitting()) options.quit();
      else options.close();
    })();
  };
}

/**
 * Quitting waits for work that must not be cut short (the case work, the last save of the
 * credentials), all at once, then quits: one listener, so one wait can never let the quit
 * through while another is still running. `waits` gives the work to wait for now; each is
 * bounded by its own caller.
 */
export function createQuitWait(waits: () => Array<Promise<unknown>>, quit: () => void): (event: { preventDefault(): void }) => void {
  let waited = false;
  return (event) => {
    if (waited) return;
    const pending = waits();
    if (pending.length === 0) return;
    waited = true;
    event.preventDefault();
    void Promise.allSettled(pending).finally(quit);
  };
}

/** Resolves with `work`'s answer, or `fallback` after `ms`. */
export function withTimeout<T, F>(work: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([work, new Promise<F>((resolve) => (timer = setTimeout(() => resolve(fallback), ms)))]).finally(() => clearTimeout(timer));
}

/** The dialog's words, in the screen language. "Go back" comes first and is the default. */
export const UNSAVED_DIALOG: Record<Language, Record<UnsavedProblem, { message: string; detail: string }> & { stay: string; close: string }> = {
  en: {
    failed: {
      message: "A change could not be saved",
      detail: "Your last change to a source could not be saved, so it would be lost if ABA Workbench closes now. Go back to see what happened and try again.",
    },
    timeout: {
      message: "Your last changes are still being saved",
      detail: "Saving is taking longer than usual. Go back and wait until it says “All changes saved”, or close anyway and lose what is not saved yet.",
    },
    stay: "Go back",
    close: "Close anyway",
  },
  es: {
    failed: {
      message: "No se pudo guardar un cambio",
      detail: "No se pudo guardar tu último cambio en una fuente, así que se perdería si ABA Workbench se cierra ahora. Vuelve para ver qué pasó e inténtalo de nuevo.",
    },
    timeout: {
      message: "Tus últimos cambios todavía se están guardando",
      detail: "Guardar está tardando más de lo normal. Vuelve y espera a que diga «Todos los cambios guardados», o cierra de todos modos y pierde lo que aún no se guardó.",
    },
    stay: "Volver",
    close: "Cerrar de todos modos",
  },
};
