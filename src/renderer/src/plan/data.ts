import { useCallback, useEffect, useRef, useState } from "react";
import type { MapSaveResult, PlanDecisionInput } from "../../../shared/api.ts";
import type { CaseMapView } from "../../../shared/case-map.ts";
import type { PlanInstructionsView, PlanPartId, PlanView } from "../../../shared/plan.ts";
import { isOlderRevision } from "../../../shared/sections.ts";
import { onRetried } from "../case-saves.tsx";
import { usePatchOpenedCase } from "../open-case.tsx";

/*
 * The plan as the Plan step holds it (step 3; the Plan step's D1 to D4): read once when the
 * step opens, then replaced by every answer, which is the whole plan as saved. Each plan
 * part has its editing pass, the version her changes and decisions keep writing to, as the
 * map's parts do; an answer of an older revision never replaces a newer one.
 */

export type PlanState =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ready"; plan: PlanView; map: CaseMapView; instructions: PlanInstructionsView };

export function usePlanData(caseId: string) {
  const [state, setState] = useState<PlanState>({ status: "loading" });
  const [actionFailed, setActionFailed] = useState(false);
  const editing = useRef<Partial<Record<PlanPartId, number>>>({});
  const patch = usePatchOpenedCase();

  const load = useCallback(async () => {
    const result = await window.aba.getPlan(caseId).catch(() => null);
    setState(result?.outcome === "read" ? { status: "ready", plan: result.plan, map: result.map, instructions: result.instructions } : { status: "failed" });
  }, [caseId]);

  useEffect(() => {
    void load(); // eslint-disable-line react-hooks/set-state-in-effect -- the first read of the plan
  }, [load]);

  // "Try again" saved what she typed in a plan item: read the plan again.
  useEffect(
    () =>
      onRetried((item) => {
        if (item.about === "map" && item.caseId === caseId) void load();
      }),
    [caseId, load],
  );

  /** Takes an answer: the plan as saved (unless an older answer), the sidebar's counts, and the editing passes it names. */
  const accept = useCallback(
    (result: MapSaveResult | null, part?: PlanPartId): boolean => {
      if (result?.outcome !== "saved") return false;
      setState((previous) =>
        previous.status !== "ready"
          ? previous
          : isOlderRevision(result.plan.revision, previous.plan.revision)
            ? previous
            : { ...previous, plan: result.plan, map: result.map },
      );
      patch(caseId, { plan: result.planSummary, caseMap: result.summary });
      if (part && result.version !== null) editing.current[part] = result.version;
      for (const [name, version] of Object.entries(result.versions ?? {})) editing.current[name as PlanPartId] = version;
      return true;
    },
    [caseId, patch],
  );

  const act = useCallback(
    async (work: () => Promise<MapSaveResult>, part?: PlanPartId): Promise<MapSaveResult | null> => {
      setActionFailed(false);
      const result = await work().catch(() => null);
      if (!accept(result, part)) setActionFailed(true);
      return result;
    },
    [accept],
  );

  /** Her decisions (D2, D4); "Aceptar lo que queda" with `onlyUndecided`. */
  const decide = useCallback(
    (changes: PlanDecisionInput[], onlyUndecided = false) => (changes.length === 0 ? Promise.resolve(null) : act(() => window.aba.decidePlanItems(caseId, changes, { ...editing.current }, onlyUndecided))),
    [act, caseId],
  );

  /** Adds an item by hand (hers, accepted): its id, or null when it could not be saved. */
  const add = useCallback(
    async (part: PlanPartId, input: Record<string, unknown>): Promise<string | null> => {
      const result = await act(() => window.aba.addMapItem(caseId, part, "items", JSON.stringify(input), editing.current[part] ?? null), part);
      return result?.outcome === "saved" ? result.itemId : null;
    },
    [act, caseId],
  );

  const editingFor = useCallback((part: PlanPartId) => editing.current[part] ?? null, []);

  const setInstructions = useCallback((instructions: PlanInstructionsView) => setState((previous) => (previous.status === "ready" ? { ...previous, instructions } : previous)), []);

  return { state, load, accept, decide, add, editingFor, actionFailed, setInstructions };
}

export type PlanData = ReturnType<typeof usePlanData>;
