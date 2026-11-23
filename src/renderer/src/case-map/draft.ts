import { useEffect, useSyncExternalStore } from "react";
import type { DraftingProvider, GenerationUpdate, MapSaveResult, StartSectionResult } from "../../../shared/api.ts";
import type { MapPartId, MapRequestKind } from "../../../shared/case-map.ts";

/*
 * "Draft the map" / "Update the map" (step 1, pull request 2), one store for the whole
 * app, like the sections' requests: leaving the case map (or the case) while the AI works
 * loses nothing, and coming back shows where it is. Each of the two requests reports its
 * progress, then its saved parts ("map-saved"), which the screen shows at once.
 */

export type MapDraftOutcome =
  /** Both requests saved their parts. */
  | { kind: "saved" }
  /**
   * Stopped (or failed) after the first request saved its parts. A failure keeps the
   * provider's error code (src/renderer/src/ai-errors.ts says what it means) and its English
   * message, which the screen shows only under "Technical details" (owner's decision T11).
   */
  | { kind: "partial"; message: string | null; code: string | null }
  | { kind: "stopped" }
  | { kind: "failed"; message: string; code: string | null }
  | { kind: "refused" };

export interface MapDraft {
  id: string;
  caseId: string;
  provider: DraftingProvider;
  /** The request at work, once it started. */
  step: MapRequestKind | null;
  phase: "starting" | "writing" | "repairing" | "plain-json" | "done";
  /** How much of the answer has arrived. */
  characters: number;
  /** The requests whose parts are saved. */
  saved: MapRequestKind[];
  /** The parts written, over both requests, and the approved ones left as they were. */
  written: MapPartId[];
  kept: MapPartId[];
  /** How many problems the code checks still found after the repair (each value marked [CHECK]). */
  problems: number;
  outcome: MapDraftOutcome | null;
}

const byCase = new Map<string, MapDraft>();
const notStarted = new Set<string>();
const stopRequested = new Set<string>();
const listeners = new Set<() => void>();
type SavedListener = (caseId: string, result: Extract<MapSaveResult, { outcome: "saved" }>) => void;
const savedListeners = new Set<SavedListener>();
let snapshot = 0;

function set(next: MapDraft) {
  byCase.set(next.caseId, next);
  snapshot++;
  for (const listener of listeners) listener();
}

function findById(id: string): MapDraft | undefined {
  for (const draft of byCase.values()) if (draft.id === id) return draft;
  return undefined;
}

function apply(update: GenerationUpdate) {
  const current = findById(update.generationId);
  if (!current) return;
  const event = update.event;
  switch (event.type) {
    case "map-progress":
      set({ ...current, step: event.step, phase: event.phase, characters: event.characters });
      return;
    case "map-saved":
      if (event.result.outcome === "saved") {
        const result = event.result;
        for (const listener of savedListeners) listener(current.caseId, result);
        set({ ...current, saved: [...current.saved, event.step], written: [...current.written, ...event.written], kept: [...current.kept, ...event.kept], problems: current.problems + event.problems });
      } else {
        set({ ...current, outcome: { kind: "failed", message: "", code: null } });
      }
      return;
    case "refusal":
      set({ ...current, outcome: { kind: "refused" } });
      return;
    case "error":
      set({ ...current, outcome: current.saved.length > 0 ? { kind: "partial", message: event.message, code: event.code } : { kind: "failed", message: event.message, code: event.code } });
      return;
    case "finished": {
      const outcome: MapDraftOutcome =
        current.outcome ?? (current.saved.length === 2 ? { kind: "saved" } : current.saved.length > 0 ? { kind: "partial", message: null, code: null } : event.cancelled ? { kind: "stopped" } : { kind: "failed", message: "", code: null });
      set({ ...current, phase: "done", outcome });
      return;
    }
    default:
      return;
  }
}

let subscribed = false;
function ensureSubscribed() {
  if (subscribed) return;
  subscribed = true;
  window.aba.onGenerationUpdate(apply);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Starts a draft (or an update) of the case's map; the outcome says why it did not start. */
export async function startMapDraft(caseId: string, provider: DraftingProvider): Promise<StartSectionResult["outcome"] | "error"> {
  ensureSubscribed();
  const id = crypto.randomUUID();
  const previous = byCase.get(caseId);
  set({ id, caseId, provider, step: null, phase: "starting", characters: 0, saved: [], written: [], kept: [], problems: 0, outcome: null });
  notStarted.add(id);
  try {
    const result = await window.aba.startMapDraft(caseId, id, provider);
    notStarted.delete(id);
    if (result.outcome === "started" && stopRequested.has(id)) void window.aba.cancelGeneration(id);
    stopRequested.delete(id);
    if (result.outcome !== "started") {
      if (previous) set(previous);
      else {
        byCase.delete(caseId);
        snapshot++;
        for (const listener of listeners) listener();
      }
    }
    return result.outcome;
  } catch {
    notStarted.delete(id);
    set({ id, caseId, provider, step: null, phase: "done", characters: 0, saved: [], written: [], kept: [], problems: 0, outcome: { kind: "failed", message: "", code: null } });
    return "error";
  }
}

export function stopMapDraft(draft: MapDraft): void {
  if (notStarted.has(draft.id)) stopRequested.add(draft.id);
  void window.aba.cancelGeneration(draft.id);
}

/** Forgets a finished draft's message (she read it). */
export function dismissMapDraft(caseId: string): void {
  const current = byCase.get(caseId);
  if (!current || current.phase !== "done") return;
  byCase.delete(caseId);
  snapshot++;
  for (const listener of listeners) listener();
}

/** The case's draft under way or last finished, or null. */
export function useMapDraft(caseId: string): MapDraft | null {
  useEffect(ensureSubscribed, []);
  useSyncExternalStore(subscribe, () => snapshot);
  return byCase.get(caseId) ?? null;
}

/** Called with the whole map each time a request of a draft saved its parts. */
export function useOnMapSaved(listener: SavedListener): void {
  useEffect(() => {
    savedListeners.add(listener);
    return () => {
      savedListeners.delete(listener);
    };
  }, [listener]);
}

export function isDrafting(draft: MapDraft | null): boolean {
  return draft !== null && draft.phase !== "done";
}
