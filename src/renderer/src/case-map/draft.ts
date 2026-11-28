import { useEffect, useSyncExternalStore } from "react";
import type { DraftingProvider, GenerationUpdate, MapSaveResult, StartSectionResult } from "../../../shared/api.ts";
import { freshDraft, reduceDraft, reduceReview, type MapDraft, type MapReviewRun } from "./draft-state.ts";

/*
 * "Draft the map" / "Update the map" (step 1, pull request 2), one store for the whole
 * app, like the sections' requests: leaving the case map (or the case) while the AI works
 * loses nothing, and coming back shows where it is. Each of the two requests reports its
 * progress, then its saved parts ("map-saved"), which the screen shows at once. While an
 * answer arrives, each item that passed its own checks comes as a preview ("map-preview"),
 * shown read-only until its request saves; the previews go when it saves or the draft ends.
 */

export type { MapDraft, MapDraftOutcome, MapPreview, MapReviewRun } from "./draft-state.ts";

const byCase = new Map<string, MapDraft>();
const reviewsByCase = new Map<string, MapReviewRun>();
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

function notify() {
  snapshot++;
  for (const listener of listeners) listener();
}

function setReview(next: MapReviewRun) {
  reviewsByCase.set(next.caseId, next);
  notify();
}

function apply(update: GenerationUpdate) {
  const review = [...reviewsByCase.values()].find((run) => run.id === update.generationId);
  const current = review ? undefined : findById(update.generationId);
  const { next, saved } = review ? reduceReview(review, update.event) : current ? reduceDraft(current, update.event, Date.now()) : { next: null, saved: null };
  const caseId = review?.caseId ?? current?.caseId;
  if (saved && caseId) for (const listener of savedListeners) listener(caseId, saved);
  if (next && review) setReview(next as MapReviewRun);
  else if (next) set(next as MapDraft);
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

function fresh(id: string, caseId: string, provider: DraftingProvider): MapDraft {
  return freshDraft(id, caseId, provider, Date.now());
}

/** Starts a draft (or an update) of the case's map; the outcome says why it did not start. */
export async function startMapDraft(caseId: string, provider: DraftingProvider): Promise<StartSectionResult["outcome"] | "error"> {
  ensureSubscribed();
  const id = crypto.randomUUID();
  const previous = byCase.get(caseId);
  set(fresh(id, caseId, provider));
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
    set({ ...fresh(id, caseId, provider), phase: "done", outcome: { kind: "failed", message: "", code: null } });
    return "error";
  }
}

export function stopMapDraft(draft: Pick<MapDraft, "id">): void {
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

/**
 * Whether a finished draft showed items, as they arrived, that were never saved: a request
 * that showed some and did not save (review round 1 of case map speed, M5).
 */
export function previewsNotSaved(draft: Pick<MapDraft, "previewed" | "saved">): boolean {
  return draft.previewed.some((step) => !draft.saved.includes(step));
}

/** Starts "Review the definitions again"; the outcome says why it did not start. */
export async function startMapReview(caseId: string, provider: DraftingProvider): Promise<StartSectionResult["outcome"] | "error"> {
  ensureSubscribed();
  const id = crypto.randomUUID();
  setReview({ id, caseId, phase: "running", outcome: null });
  try {
    const result = await window.aba.startMapReview(caseId, id, provider);
    if (result.outcome !== "started") {
      reviewsByCase.delete(caseId);
      notify();
    }
    return result.outcome;
  } catch {
    setReview({ id, caseId, phase: "done", outcome: "not-run" });
    return "error";
  }
}

/** The case's review run on its own, under way or last finished, or null. */
export function useMapReview(caseId: string): MapReviewRun | null {
  useEffect(ensureSubscribed, []);
  useSyncExternalStore(subscribe, () => snapshot);
  return reviewsByCase.get(caseId) ?? null;
}

export function isDrafting(draft: MapDraft | null): boolean {
  return draft !== null && draft.phase !== "done";
}
