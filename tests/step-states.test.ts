import assert from "node:assert/strict";
import { test } from "node:test";
import { REPORT_SECTIONS } from "../src/shared/report-sections.ts";
import type { SectionSummary } from "../src/shared/sections.ts";
import { readySections, stepCount, stepState, type StepInputs } from "../src/renderer/src/step-states.ts";

/*
 * The sidebar's step states and counts (owner's decision T18): computed from the case's
 * data, nothing stored.
 */

const sections = (...states: Array<SectionSummary["state"]>) => states.map((state) => ({ state }));
const none: StepInputs = { sources: 0, caseMap: { approved: 0, withContent: 0 }, sections: [] };

test("step states: a new case has every built step not started and the others not built yet", () => {
  assert.equal(stepState("sources", none), "not-started");
  assert.equal(stepState("case-map", none), "not-started");
  assert.equal(stepState("report", none), "not-started");
  assert.equal(stepState("interventions", none), "later");
  assert.equal(stepState("review", none), "later");
});

test("step states: sources are done from the first one", () => {
  assert.equal(stepState("sources", { ...none, sources: 1 }), "done");
  assert.deepEqual(stepCount("sources", { ...none, sources: 7 }), { shown: "7", spoken: { key: "sources", values: { count: 7 } } });
  assert.equal(stepCount("sources", none), null);
});

test("step states: the case map is in progress until every part with content is approved", () => {
  assert.equal(stepState("case-map", { ...none, caseMap: { approved: 0, withContent: 2 } }), "in-progress");
  assert.equal(stepState("case-map", { ...none, caseMap: { approved: 1, withContent: 2 } }), "in-progress");
  assert.equal(stepState("case-map", { ...none, caseMap: { approved: 2, withContent: 2 } }), "done");
  assert.deepEqual(stepCount("case-map", { ...none, caseMap: { approved: 1, withContent: 2 } })?.shown, "1/2");
  assert.equal(stepCount("case-map", none), null);
});

test("step states: the report counts the sections that are hers or approved", () => {
  const some = { ...none, sections: sections("approved", "drafted", "hers", "not-started") };
  assert.equal(readySections(some.sections), 2);
  assert.equal(stepState("report", some), "in-progress");
  assert.deepEqual(stepCount("report", some), { shown: `2/${REPORT_SECTIONS.length}`, spoken: { key: "report", values: { done: 2, total: REPORT_SECTIONS.length } } });
  // A draft waiting for her makes the report in progress, but not ready.
  assert.equal(stepState("report", { ...none, sections: sections("drafted") }), "in-progress");
  assert.equal(stepCount("report", none)?.shown, `0/${REPORT_SECTIONS.length}`);
  const all = { ...none, sections: REPORT_SECTIONS.map((_, index) => ({ state: index % 2 === 0 ? ("approved" as const) : ("hers" as const) })) };
  assert.equal(stepState("report", all), "done");
});
