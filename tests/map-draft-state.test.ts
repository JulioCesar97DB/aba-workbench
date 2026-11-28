import assert from "node:assert/strict";
import { test } from "node:test";
import { draftOffered, freshDraft, reduceDraft, reduceReview, reviewOffered, type MapDraft, type MapReviewRun } from "../src/renderer/src/case-map/draft-state.ts";
import type { GenerationUpdateEvent, MapSaveResult } from "../src/shared/api.ts";

/*
 * The case map draft's state and the review run's on the screen (T3; review of T3, finding 5):
 * how each event changes them, and when the review and the draft are offered.
 */

const savedMap = { outcome: "saved", map: { parts: {}, definitionReview: null, revision: "r" }, summary: { approved: 0, withContent: 1 }, version: null, itemId: null } as unknown as Extract<MapSaveResult, { outcome: "saved" }>;
const draft = (): MapDraft => freshDraft("g-1", "case-1", "openai", 1000);
function run(start: MapDraft, events: GenerationUpdateEvent[]): { draft: MapDraft; saved: number } {
  let current = start;
  let saved = 0;
  for (const event of events) {
    const step = reduceDraft(current, event, 2000);
    if (step.saved) saved++;
    if (step.next) current = step.next;
  }
  return { draft: current, saved };
}
const mapSaved = (step: "map-facts" | "map-behaviors"): GenerationUpdateEvent => ({ type: "map-saved", step, result: savedMap, written: [], kept: [], problems: 0 });

test("a draft whose review fails still ends saved: the review's error and refusal never make it partial", () => {
  for (const failure of [{ type: "error", code: "rate_limited", message: "Too many requests", status: 429 }, { type: "refusal", discard: true, category: null, explanation: null }] as GenerationUpdateEvent[]) {
    const { draft: end, saved } = run(draft(), [mapSaved("map-facts"), mapSaved("map-behaviors"), { type: "map-review", phase: "reviewing" }, failure, { type: "finished", cancelled: false }]);
    assert.deepEqual(end.outcome, { kind: "saved" });
    assert.equal(end.reviewing, false);
    assert.equal(saved, 2);
  }
});

test("a draft's review saved, done or failed, says so, and hands the saved map to the screen", () => {
  const done = run(draft(), [mapSaved("map-facts"), mapSaved("map-behaviors"), { type: "map-review", phase: "reviewing" }, { type: "map-review-saved", result: savedMap, status: "done", findings: 2 }, { type: "finished", cancelled: false }]);
  assert.equal(done.draft.review, "done");
  assert.equal(done.saved, 3);
  assert.deepEqual(done.draft.outcome, { kind: "saved" });
  const failed = run(draft(), [mapSaved("map-facts"), mapSaved("map-behaviors"), { type: "map-review", phase: "reviewing" }, { type: "map-review-saved", result: savedMap, status: "failed", findings: 0 }]);
  assert.equal(failed.draft.review, "failed");
  const unsaved = run(draft(), [mapSaved("map-facts"), mapSaved("map-behaviors"), { type: "map-review", phase: "reviewing" }, { type: "map-review-saved", result: { outcome: "not-saved" } as unknown as MapSaveResult, status: "done", findings: 0 }]);
  assert.equal(unsaved.draft.review, "failed", "a record that could not be saved is a review that did not run");
});

test("an error before the review still fails or cuts the draft as before", () => {
  const error: GenerationUpdateEvent = { type: "error", code: "rate_limited", message: "Too many requests", status: 429 };
  assert.equal(run(draft(), [error]).draft.outcome?.kind, "failed");
  assert.equal(run(draft(), [mapSaved("map-facts"), error]).draft.outcome?.kind, "partial");
});

test("a review run on its own: saved done or failed, stopped, or not run", () => {
  const start: MapReviewRun = { id: "g-2", caseId: "case-1", phase: "running", outcome: null };
  const savedDone = reduceReview(start, { type: "map-review-saved", result: savedMap, status: "done", findings: 1 });
  assert.equal(savedDone.next?.outcome, "done");
  assert.ok(savedDone.saved);
  assert.deepEqual(reduceReview(savedDone.next!, { type: "finished", cancelled: false }).next, { ...start, phase: "done", outcome: "done" });
  assert.equal(reduceReview(start, { type: "map-review-saved", result: savedMap, status: "failed", findings: 0 }).next?.outcome, "failed");
  assert.equal(reduceReview(start, { type: "finished", cancelled: true }).next?.outcome, "stopped", "a stopped review shows as stopped");
  assert.equal(reduceReview(start, { type: "finished", cancelled: false }).next?.outcome, "not-run");
  assert.equal(reduceReview(start, { type: "map-review", phase: "reviewing" }).next, null);
});

test("Review the definitions again is offered only with behaviors, an AI, and no draft running; the draft is not offered while a review runs", () => {
  assert.equal(reviewOffered({ hasBehaviors: true, connected: true, drafting: false }), true);
  assert.equal(reviewOffered({ hasBehaviors: true, connected: true, drafting: true }), false, "never while a draft runs");
  assert.equal(reviewOffered({ hasBehaviors: false, connected: true, drafting: false }), false);
  assert.equal(reviewOffered({ hasBehaviors: true, connected: false, drafting: false }), false);
  assert.equal(draftOffered({ connected: true, drafting: false, reviewing: false }), true);
  assert.equal(draftOffered({ connected: true, drafting: false, reviewing: true }), false, "never while a review she started runs");
  assert.equal(draftOffered({ connected: false, drafting: false, reviewing: false }), false);
});
