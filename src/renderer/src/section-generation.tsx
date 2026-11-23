import { useEffect, useSyncExternalStore } from "react";
import type { DraftingProvider, GenerationUpdate, SectionSaveResult, StartSectionResult } from "../../shared/api.ts";
import type { ReportSectionId } from "../../shared/report-sections.ts";
import type { SectionRequestInput } from "../../shared/sections.ts";

/*
 * The AI's requests from the section screen, one store for the whole app: leaving the
 * section (or the case) while the AI writes does not lose what it is doing, and coming
 * back shows it. Each request streams its text; the new version arrives in "saved", and
 * the check against her sections in "checked".
 */

export type GenerationOutcome =
  | { kind: "saved" }
  | { kind: "stopped" }
  | { kind: "failed"; message: string }
  | { kind: "incomplete" }
  | { kind: "refused" }
  | { kind: "not-saved" };

export interface SectionGeneration {
  id: string;
  caseId: string;
  sectionId: ReportSectionId;
  request: SectionRequestInput;
  phase: "starting" | "thinking" | "writing" | "checking" | "done";
  text: string;
  outcome: GenerationOutcome | null;
}

const byKey = new Map<string, SectionGeneration>();
const listeners = new Set<() => void>();
let snapshot = 0;
/** Told each saved section, so the screen and the sidebar show it. */
type SavedListener = (caseId: string, result: Extract<SectionSaveResult, { outcome: "saved" }>, kind: "version" | "check") => void;
const savedListeners = new Set<SavedListener>();

const keyOf = (caseId: string, sectionId: string) => `${caseId}/${sectionId}`;

function set(next: SectionGeneration) {
  byKey.set(keyOf(next.caseId, next.sectionId), next);
  snapshot++;
  for (const listener of listeners) listener();
}

function findById(id: string): SectionGeneration | undefined {
  for (const generation of byKey.values()) if (generation.id === id) return generation;
  return undefined;
}

function apply(update: GenerationUpdate) {
  const current = findById(update.generationId);
  if (!current) return;
  const event = update.event;
  switch (event.type) {
    case "status":
      set({ ...current, phase: event.phase });
      return;
    case "text":
      set({ ...current, phase: "writing", text: current.text + event.delta });
      return;
    case "refusal":
      // The provider's contract: a refusal invalidates every word received.
      set({ ...current, text: "", outcome: { kind: "refused" } });
      return;
    case "done":
      if (!event.complete && !current.outcome) set({ ...current, outcome: { kind: "incomplete" } });
      return;
    case "error":
      set({ ...current, outcome: { kind: "failed", message: event.message } });
      return;
    case "saved":
      if (event.result.outcome === "saved") {
        const saved = event.result;
        for (const listener of savedListeners) listener(current.caseId, saved, "version");
        set({ ...current, phase: "checking", outcome: { kind: "saved" } });
      } else {
        set({ ...current, outcome: { kind: "not-saved" } });
      }
      return;
    case "checked":
      if (event.result.outcome === "saved") {
        const saved = event.result;
        for (const listener of savedListeners) listener(current.caseId, saved, "check");
      }
      return;
    case "finished":
      set({ ...current, phase: "done", outcome: current.outcome ?? (event.cancelled ? { kind: "stopped" } : { kind: "incomplete" }) });
      return;
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

/** Starts a request; the outcome says why it did not start. */
export async function startSectionGeneration(caseId: string, sectionId: ReportSectionId, provider: DraftingProvider, request: SectionRequestInput): Promise<StartSectionResult["outcome"] | "error"> {
  ensureSubscribed();
  const id = crypto.randomUUID();
  const previous = byKey.get(keyOf(caseId, sectionId));
  set({ id, caseId, sectionId, request, phase: "starting", text: "", outcome: null });
  try {
    const result = await window.aba.startSectionGeneration(caseId, sectionId, id, provider, request);
    if (result.outcome !== "started") {
      if (previous) set(previous);
      else {
        byKey.delete(keyOf(caseId, sectionId));
        snapshot++;
        for (const listener of listeners) listener();
      }
    }
    return result.outcome;
  } catch {
    set({ id, caseId, sectionId, request, phase: "done", text: "", outcome: { kind: "failed", message: "" } });
    return "error";
  }
}

export function stopSectionGeneration(generation: SectionGeneration): void {
  void window.aba.cancelGeneration(generation.id);
}

/** Forgets a finished request's message (she read it, or started another). */
export function dismissSectionGeneration(caseId: string, sectionId: string): void {
  const current = byKey.get(keyOf(caseId, sectionId));
  if (!current || current.phase !== "done") return;
  byKey.delete(keyOf(caseId, sectionId));
  snapshot++;
  for (const listener of listeners) listener();
}

/** The section's request under way or last finished, or null. */
export function useSectionGeneration(caseId: string, sectionId: string): SectionGeneration | null {
  useEffect(ensureSubscribed, []);
  useSyncExternalStore(subscribe, () => snapshot);
  return byKey.get(keyOf(caseId, sectionId)) ?? null;
}

/** Called with every section saved by a request (the new version, then its check). */
export function useOnSectionSaved(listener: SavedListener): void {
  useEffect(() => {
    savedListeners.add(listener);
    return () => {
      savedListeners.delete(listener);
    };
  }, [listener]);
}

export function isRunning(generation: SectionGeneration | null): boolean {
  return generation !== null && generation.phase !== "done";
}
