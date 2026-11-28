import type { DraftingProvider, GenerationUpdateEvent, MapSaveResult } from "../../../shared/api.ts";
import type { MapPartId, MapRequestKind } from "../../../shared/case-map.ts";

/*
 * The case map draft's state, and the review run's, as each event of a generation changes
 * them: plain functions, so they are tested in node (tests/map-draft-state.test.ts; review of
 * T3, finding 5). The store in draft.ts holds them and calls these.
 */

/** An item of the answer that passed its checks, not saved yet (case map speed, 2026-11-23). */
export interface MapPreview {
  step: MapRequestKind;
  part: MapPartId;
  /** The preview's own id ("preview:…"), never an item id of the map. */
  id: string;
  item: Record<string, unknown>;
  /** The saved item it is a new version of (an update), shown with it; null for a new item. */
  replaces: string | null;
}

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
  /** When the draft started and when the request at work started (Date.now()), for the time shown. */
  startedAt: number;
  stepStartedAt: number;
  /** Of the answer being written: the items that arrived, and those that passed their checks. */
  arrived: number;
  shown: number;
  /** While a repair runs: how many values it is asked to fix, and what it asks for again (S5). */
  values: number;
  scope: "values" | "items" | "whole";
  /** The items that passed their checks and are not saved yet. */
  previews: MapPreview[];
  /** The requests that showed items as they arrived: one that did not save showed items that were not saved (M5). */
  previewed: MapRequestKind[];
  /** The requests whose parts are saved. */
  saved: MapRequestKind[];
  /** The parts written, over both requests, and the approved ones left as they were. */
  written: MapPartId[];
  kept: MapPartId[];
  /** How many problems the code checks still found after the repair (each value marked [CHECK]). */
  problems: number;
  /** The review of the definitions that follows the behaviors (T3): running, and how it ended (null before it ends, or when it did not run). */
  reviewing: boolean;
  review: "done" | "failed" | null;
  outcome: MapDraftOutcome | null;
}

/** "Review the definitions again" (T3; owner's decision 2A): one request on its own, one per case at a time. */
export interface MapReviewRun {
  id: string;
  caseId: string;
  phase: "running" | "done";
  /** How it ended: its record saved (done or failed), or it did not run (stopped, or an error before anything was saved). */
  outcome: "done" | "failed" | "stopped" | "not-run" | null;
}

/** A map saved by an event: the screen's listeners get it. */
export type SavedMap = Extract<MapSaveResult, { outcome: "saved" }>;

export function freshDraft(id: string, caseId: string, provider: DraftingProvider, now: number): MapDraft {
  return { id, caseId, provider, step: null, phase: "starting", characters: 0, startedAt: now, stepStartedAt: now, arrived: 0, shown: 0, values: 0, scope: "values", previews: [], previewed: [], saved: [], written: [], kept: [], problems: 0, reviewing: false, review: null, outcome: null };
}

/**
 * A draft after one event: its next state (null when the event changes nothing) and the map an
 * event saved, if any. While the review that ends a draft runs, its error or refusal never takes
 * the draft's saved parts away: the review is recorded as failed instead (T3).
 */
export function reduceDraft(current: MapDraft, event: GenerationUpdateEvent, now: number): { next: MapDraft | null; saved: SavedMap | null } {
  switch (event.type) {
    case "map-progress": {
      const newStep = event.step !== current.step;
      // A new answer (the plain-JSON resend) replaces what the last one showed; a repair keeps it.
      const newAnswer = newStep || (event.phase !== "repairing" && event.characters === 0);
      return {
        next: {
          ...current,
          step: event.step,
          phase: event.phase,
          characters: event.characters,
          stepStartedAt: newStep ? now : current.stepStartedAt,
          arrived: event.arrived ?? (newAnswer ? 0 : current.arrived),
          shown: event.shown ?? (newAnswer ? 0 : current.shown),
          values: event.values ?? current.values,
          scope: event.scope ?? current.scope,
          previews: newAnswer ? current.previews.filter((preview) => preview.step !== event.step) : current.previews,
        },
        saved: null,
      };
    }
    case "map-preview":
      return {
        next: {
          ...current,
          previewed: current.previewed.includes(event.step) ? current.previewed : [...current.previewed, event.step],
          previews: [...current.previews.filter((preview) => preview.id !== event.id), { step: event.step, part: event.part, id: event.id, item: event.item, replaces: event.replaces ?? null }],
        },
        saved: null,
      };
    case "map-saved":
      if (event.result.outcome !== "saved") return { next: { ...current, outcome: { kind: "failed", message: "", code: null } }, saved: null };
      return {
        next: {
          ...current,
          saved: [...current.saved, event.step],
          written: [...current.written, ...event.written],
          kept: [...current.kept, ...event.kept],
          problems: current.problems + event.problems,
          // The saved map now holds them: the previews of this request go.
          previews: current.previews.filter((preview) => preview.step !== event.step),
        },
        saved: event.result,
      };
    case "map-review":
      return { next: { ...current, reviewing: true }, saved: null };
    case "map-review-saved":
      return { next: { ...current, reviewing: false, review: event.result.outcome === "saved" ? event.status : "failed" }, saved: event.result.outcome === "saved" ? event.result : null };
    case "refusal":
      return { next: current.reviewing ? null : { ...current, outcome: { kind: "refused" } }, saved: null };
    case "error":
      if (current.reviewing) return { next: null, saved: null };
      return { next: { ...current, outcome: current.saved.length > 0 ? { kind: "partial", message: event.message, code: event.code } : { kind: "failed", message: event.message, code: event.code } }, saved: null };
    case "finished": {
      const outcome: MapDraftOutcome =
        current.outcome ?? (current.saved.length === 2 ? { kind: "saved" } : current.saved.length > 0 ? { kind: "partial", message: null, code: null } : event.cancelled ? { kind: "stopped" } : { kind: "failed", message: "", code: null });
      // Nothing more is saved: whatever was only previewed goes.
      return { next: { ...current, phase: "done", outcome, previews: [], reviewing: false }, saved: null };
    }
    default:
      return { next: null, saved: null };
  }
}

/** A review she asked for on its own, after one event; its record saved (done or failed), or finished without one (stopped, or it did not run). */
export function reduceReview(run: MapReviewRun, event: GenerationUpdateEvent): { next: MapReviewRun | null; saved: SavedMap | null } {
  if (event.type === "map-review-saved") return { next: { ...run, outcome: event.result.outcome === "saved" ? event.status : "failed" }, saved: event.result.outcome === "saved" ? event.result : null };
  if (event.type === "finished") return { next: { ...run, phase: "done", outcome: run.outcome ?? (event.cancelled ? "stopped" : "not-run") }, saved: null };
  return { next: null, saved: null };
}

/**
 * Whether "Review the definitions again" is offered (owner's decision 2A): the map has
 * behaviors, an AI is connected, and neither a draft nor a review runs. While a review runs,
 * its line offers Stop instead.
 */
export function reviewOffered(state: { hasBehaviors: boolean; connected: boolean; drafting: boolean }): boolean {
  return state.hasBehaviors && state.connected && !state.drafting;
}

/** Whether the map's AI action ("Draft / Update the map") is offered: never while a draft or a review runs (review of T3, nit 10). */
export function draftOffered(state: { connected: boolean; drafting: boolean; reviewing: boolean }): boolean {
  return state.connected && !state.drafting && !state.reviewing;
}
