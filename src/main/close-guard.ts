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

/** How long the interface has to finish its saves before she is asked. */
export const FLUSH_TIMEOUT_MS = 5_000;
/** How long the main process's case work then has to finish. */
export const IDLE_TIMEOUT_MS = 5_000;

export type UnsavedProblem = "failed" | "timeout";

export interface CloseGuardOptions {
  /** Asks the interface to save everything; "timeout" when it did not answer in time, "gone" when its page has crashed. */
  flush: () => Promise<{ ok: boolean } | "timeout" | "gone">;
  /** Waits for the main process's case work; false if it did not finish in time. */
  idle: () => Promise<boolean>;
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
      try {
        const answer = await options.flush();
        const idle = await options.idle();
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
