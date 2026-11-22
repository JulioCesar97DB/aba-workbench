import { createContext, useContext, useEffect, useState } from "react";
import { isCaseId, type CaseDetail, type OpenCaseResult } from "../../shared/api.ts";

/*
 * The case open in the workspace. AppShell loads it (window.aba.openCase) when the
 * address enters a case, so the sidebar can show its label and the screens its data;
 * each time the user opens the case again it is read again, which also picks up PDFs put
 * into its folder meanwhile.
 */

export type OpenCaseState = OpenCaseResult | { outcome: "loading" } | { outcome: "error" };

export const OpenCaseContext = createContext<OpenCaseState | null>(null);

/** Loads the case in the address; null outside a case. */
export function useCaseLoader(caseId: string | undefined): OpenCaseState | null {
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
  if (!caseId) return null;
  // An address that is not a case id is not sent to the main process at all.
  if (!isCaseId(caseId)) return { outcome: "not-found" };
  return loaded?.id === caseId ? loaded.state : { outcome: "loading" };
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
