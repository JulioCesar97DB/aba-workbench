import assert from "node:assert/strict";
import { test } from "node:test";
import { REPORT_SECTIONS } from "../src/shared/report-sections.ts";
import type { SectionSummary } from "../src/shared/sections.ts";
import { copiedSections, readySections, stepCount, stepState, type StepInputs } from "../src/renderer/src/step-states.ts";

/*
 * The sidebar's step states and counts (owner's decision T18): computed from the case's
 * data, nothing stored.
 */

const sections = (...states: Array<SectionSummary["state"]>) => states.map((state) => ({ state, copied: false }));
const none: StepInputs = { sources: 0, caseMap: { approved: 0, withContent: 0 }, sections: [] };

test("step states: a new case has every step not started", () => {
  assert.equal(stepState("sources", none), "not-started");
  assert.equal(stepState("case-map", none), "not-started");
  assert.equal(stepState("report", none), "not-started");
  assert.equal(stepState("interventions", none), "not-started");
  assert.equal(stepState("review", none), "not-started");
});

test("step states: the plan counts its items decided, and is done once none waits (the Plan step, PR 1)", () => {
  assert.equal(stepState("interventions", { ...none, plan: { decided: 0, total: 0 } }), "not-started");
  assert.equal(stepCount("interventions", { ...none, plan: { decided: 0, total: 0 } }), null);
  assert.equal(stepState("interventions", { ...none, plan: { decided: 18, total: 102 } }), "in-progress");
  assert.deepEqual(stepCount("interventions", { ...none, plan: { decided: 18, total: 102 } }), { shown: "18/102", spoken: { key: "plan", values: { decided: 18, total: 102 } } });
  assert.equal(stepState("interventions", { ...none, plan: { decided: 4, total: 4 } }), "done");
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
  const all = { ...none, sections: REPORT_SECTIONS.map((_, index) => ({ state: index % 2 === 0 ? ("approved" as const) : ("hers" as const), copied: false })) };
  assert.equal(stepState("report", all), "done");
});

test("step states: Review and copy counts the sections copied as they are now (T8), once one is ready to copy", () => {
  const total = REPORT_SECTIONS.length;
  // Nothing to copy yet: no count, not started.
  assert.equal(stepCount("review", { ...none, sections: sections("drafted", "not-started") }), null);
  assert.equal(stepState("review", { ...none, sections: sections("drafted") }), "not-started");
  // One ready: "0/9".
  const one = { ...none, sections: sections("approved", "not-started") };
  assert.deepEqual(stepCount("review", one), { shown: `0/${total}`, spoken: { key: "review", values: { copied: 0, total } } });
  // Copied ones: in progress, then done at nine.
  const some = { ...none, sections: REPORT_SECTIONS.map((_, index) => ({ state: "approved" as const, copied: index < 6 })) };
  assert.equal(copiedSections(some.sections), 6);
  assert.equal(stepState("review", some), "in-progress");
  assert.equal(stepCount("review", some)?.shown, `6/${total}`);
  const all = { ...none, sections: REPORT_SECTIONS.map(() => ({ state: "hers" as const, copied: true })) };
  assert.equal(stepState("review", all), "done");
});
