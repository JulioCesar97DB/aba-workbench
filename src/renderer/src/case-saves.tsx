import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CaseSources, SourceSaveFailure } from "../../shared/sources.ts";
import { useSetCaseSources } from "./open-case.tsx";

/*
 * Every change to a case's sources is saved at once: there is no Save button to forget.
 * This keeps the one state the screens show ("Saving…", "All changes saved", or what
 * could not be saved and a way to try again), for the whole case, so a change made in
 * the text editor and still saving when the clinician goes back to the list shows there
 * too. It lives above the case's screens (CaseRoute), so leaving a screen never drops a
 * save under way.
 *
 * Each save has a key: the thing it changes ("text:<id>" for a source's text, say). A
 * failed save is offered again ("Try again") until a later save with the same key
 * succeeds, which replaces it: trying the older one again would undo the newer.
 */

export type SaveFailure = SourceSaveFailure["outcome"] | "error";

export type SaveState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "saved" }
  | { status: "failed"; failure: SaveFailure; retry: () => void };

/** What a save answers: the case's sources as saved, or why not. */
export type SaveAnswer<T> = { ok: true; sources: CaseSources; value: T } | { ok: false; failure: SaveFailure };

interface CaseSaves {
  state: SaveState;
  /** Runs one save; its answer replaces the case's sources on screen. */
  run<T>(key: string, save: () => Promise<SaveAnswer<T>>): Promise<SaveAnswer<T>>;
}

const CaseSavesContext = createContext<CaseSaves | null>(null);

export function CaseSavesProvider({ caseId, children }: { caseId: string; children: ReactNode }) {
  const setSources = useSetCaseSources();
  const [pending, setPending] = useState(0);
  const [failures, setFailures] = useState<ReadonlyMap<string, { failure: SaveFailure; retry: () => void }>>(new Map());
  const [savedOnce, setSavedOnce] = useState(false);
  const runRef = useRef<CaseSaves["run"] | null>(null);

  const run = useCallback(
    async <T,>(key: string, save: () => Promise<SaveAnswer<T>>): Promise<SaveAnswer<T>> => {
      setPending((count) => count + 1);
      let answer: SaveAnswer<T>;
      try {
        answer = await save();
      } catch {
        answer = { ok: false, failure: "error" };
      }
      setPending((count) => count - 1);
      if (answer.ok) {
        setSources(caseId, answer.sources);
        setSavedOnce(true);
        setFailures((previous) => {
          if (!previous.has(key)) return previous;
          const next = new Map(previous);
          next.delete(key);
          return next;
        });
      } else {
        const failure = answer.failure;
        setFailures((previous) => new Map(previous).set(key, { failure, retry: () => void runRef.current?.(key, save) }));
      }
      return answer;
    },
    [caseId, setSources],
  );
  useEffect(() => {
    runRef.current = run;
  }, [run]);

  const state = useMemo((): SaveState => {
    if (pending > 0) return { status: "saving" };
    const last = [...failures.values()].at(-1);
    if (last) return { status: "failed", ...last };
    return savedOnce ? { status: "saved" } : { status: "idle" };
  }, [pending, failures, savedOnce]);

  const value = useMemo(() => ({ state, run }), [state, run]);
  return <CaseSavesContext value={value}>{children}</CaseSavesContext>;
}

export function useCaseSaves(): CaseSaves {
  const saves = useContext(CaseSavesContext);
  if (!saves) throw new Error("useCaseSaves is used outside a case.");
  return saves;
}

/** A source change's answer, as a SaveAnswer. */
export function sourceAnswer(result: { outcome: "saved"; sources: CaseSources; sourceId: string } | SourceSaveFailure): SaveAnswer<string> {
  return result.outcome === "saved" ? { ok: true, sources: result.sources, value: result.sourceId } : { ok: false, failure: result.outcome };
}
