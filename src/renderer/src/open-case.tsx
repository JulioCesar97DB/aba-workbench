import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { isCaseId, type CaseDetail, type OpenCaseResult } from "../../shared/api.ts";
import type { CaseSources } from "../../shared/sources.ts";

/*
 * The case open in the workspace. AppShell loads it (window.aba.openCase) when the
 * address enters a case, so the sidebar can show its label and the screens its data;
 * each time the user opens the case again it is read again, which also picks up PDFs put
 * into its folder meanwhile. A change saved from a screen (a source added, say) answers
 * with the case's sources as saved, which replace the ones held here (useSetCaseSources).
 */

export type OpenCaseState = OpenCaseResult | { outcome: "loading" } | { outcome: "error" };

export const OpenCaseContext = createContext<OpenCaseState | null>(null);
export const SetCaseSourcesContext = createContext<((caseId: string, sources: CaseSources) => void) | null>(null);
/** Replaces parts of the opened case with what a save answered (its sections' states, its notes, its case map's summary). */
export const PatchOpenedCaseContext = createContext<((caseId: string, patch: Partial<Pick<CaseDetail, "sections" | "notes" | "caseMap">>) => void) | null>(null);

/** Loads the case in the address; null outside a case. */
export function useCaseLoader(caseId: string | undefined): {
  state: OpenCaseState | null;
  setSources: (caseId: string, sources: CaseSources) => void;
  patch: (caseId: string, patch: Partial<Pick<CaseDetail, "sections" | "notes" | "caseMap">>) => void;
} {
  const [loaded, setLoaded] = useState<{ id: string; state: OpenCaseState } | null>(null);
  useEffect(() => {
    if (!caseId || !isCaseId(caseId)) return;
    let current = true;
    window.aba.openCase(caseId).then(
      (state) => {
        if (current) setLoaded({ id: caseId, state });
      },
      () => {
        if (current) setLoaded({ id: caseId, state: { outcome: "error" } });
      },
    );
    return () => {
      current = false;
    };
  }, [caseId]);
  const setSources = useCallback((id: string, sources: CaseSources) => {
    setLoaded((previous) => {
      if (previous?.id !== id || previous.state.outcome !== "opened") return previous;
      const opened = previous.state.case;
      return { id, state: { outcome: "opened", case: { ...opened, sources, files: sources.files, pdfCount: sources.files.length, updatedAt: sources.updatedAt } } };
    });
  }, []);
  const patch = useCallback((id: string, change: Partial<Pick<CaseDetail, "sections" | "notes" | "caseMap">>) => {
    setLoaded((previous) => {
      if (previous?.id !== id || previous.state.outcome !== "opened") return previous;
      return { id, state: { outcome: "opened", case: { ...previous.state.case, ...change } } };
    });
  }, []);
  const state = useMemo((): OpenCaseState | null => {
    if (!caseId) return null;
    // An address that is not a case id is not sent to the main process at all.
    if (!isCaseId(caseId)) return { outcome: "not-found" };
    return loaded?.id === caseId ? loaded.state : { outcome: "loading" };
  }, [caseId, loaded]);
  return { state, setSources, patch };
}

export function useOpenCaseState(): OpenCaseState | null {
  return useContext(OpenCaseContext);
}

/** The opened case, for the screens inside it (CaseRoute renders them only once it is opened). */
export function useOpenedCase(): CaseDetail {
  const state = useContext(OpenCaseContext);
  if (state?.outcome !== "opened") throw new Error("useOpenedCase is used outside an opened case.");
  return state.case;
}

/** Replaces the opened case's sources with the ones a save answered. */
export function useSetCaseSources(): (caseId: string, sources: CaseSources) => void {
  const set = useContext(SetCaseSourcesContext);
  if (!set) throw new Error("useSetCaseSources is used outside AppShell.");
  return set;
}

/** Replaces the opened case's sections or notes with the ones a save answered. */
export function usePatchOpenedCase(): (caseId: string, patch: Partial<Pick<CaseDetail, "sections" | "notes" | "caseMap">>) => void {
  const patch = useContext(PatchOpenedCaseContext);
  if (!patch) throw new Error("usePatchOpenedCase is used outside AppShell.");
  return patch;
}
