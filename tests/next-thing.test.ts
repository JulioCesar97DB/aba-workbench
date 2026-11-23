import assert from "node:assert/strict";
import { test } from "node:test";
import { REPORT_SECTIONS, type ReportSectionId } from "../src/shared/report-sections.ts";
import type { SectionState } from "../src/shared/sections.ts";
import { currentStep, everythingDone, nextThing, nextThingPath, stepStates, type NextInputs } from "../src/renderer/src/next-thing.ts";

/*
 * "Lo siguiente" (owner's proposal §6, decisions T7 and P8): the first rule that applies,
 * computed from the case's data, nothing stored. Each rule on its own, then the order
 * between them.
 */

const ID = "4b8c1f2e-3d4a-4b5c-8d6e-7f8091a2b3c4";
const [S1, S2, S3] = REPORT_SECTIONS.map((section) => section.id);

/** The nine sections, all in one state, with some changed. */
function sections(all: SectionState, changes: Partial<Record<ReportSectionId, SectionState>> = {}): NextInputs["sections"] {
  return REPORT_SECTIONS.map((section) => ({ id: section.id, state: changes[section.id] ?? all }));
}

const fresh: NextInputs = { unsaved: false, sources: 0, caseMap: { approved: 0, withContent: 0 }, mapPartToApprove: null, sections: sections("not-started") };
const withDocs: NextInputs = { ...fresh, sources: 3 };

test("rule 1: a change not saved comes before everything, even in a finished case", () => {
  assert.deepEqual(nextThing({ ...fresh, unsaved: true }), { kind: "unsaved" });
  assert.deepEqual(nextThing({ ...withDocs, sections: sections("approved"), unsaved: true }), { kind: "unsaved" });
  // The case's step is still that of its work: "unsaved" does not move it.
  assert.equal(currentStep({ ...fresh, unsaved: true }), "sources");
  assert.equal(nextThingPath(ID, { kind: "unsaved" }), `/cases/${ID}`);
});

test("rule 2: no document asks for the documents, whatever else the case holds", () => {
  assert.deepEqual(nextThing(fresh), { kind: "add-documents" });
  // Removed documents are not counted by the caller; sections or a map without documents still ask for them first.
  assert.deepEqual(nextThing({ ...fresh, sections: sections("not-started", { [S2]: "drafted" }), caseMap: { approved: 0, withContent: 2 } }), { kind: "add-documents" });
  assert.equal(currentStep(fresh), "sources");
  assert.equal(nextThingPath(ID, { kind: "add-documents" }), `/cases/${ID}/sources`);
});

test("rule 3: an AI draft not approved, the first in ABA Matrix's order, before the map", () => {
  const inputs = { ...withDocs, caseMap: { approved: 0, withContent: 3 }, mapPartToApprove: "behaviors" as const, sections: sections("not-started", { [S3]: "drafted", [S2]: "drafted", [S1]: "hers" }) };
  assert.deepEqual(nextThing(inputs), { kind: "review-draft", sectionId: S2 });
  assert.equal(currentStep(inputs), "report");
  assert.equal(nextThingPath(ID, { kind: "review-draft", sectionId: S2 }), `/cases/${ID}/report/${S2}`);
  // An approved section is no draft to review.
  assert.notEqual(nextThing({ ...withDocs, sections: sections("approved") }).kind, "review-draft");
});

test("rule 4: a part of the map with content and not approved, named when known", () => {
  const inputs = { ...withDocs, caseMap: { approved: 2, withContent: 4 }, mapPartToApprove: "behaviors" as const };
  assert.deepEqual(nextThing(inputs), { kind: "approve-map", part: "behaviors" });
  assert.equal(currentStep(inputs), "case-map");
  assert.equal(nextThingPath(ID, { kind: "approve-map", part: "behaviors" }), `/cases/${ID}/case-map?part=behaviors`);
  // Not known yet (the summary reads the map after the case): the map, without its part.
  assert.deepEqual(nextThing({ ...inputs, mapPartToApprove: null }), { kind: "approve-map", part: null });
  assert.equal(nextThingPath(ID, { kind: "approve-map", part: null }), `/cases/${ID}/case-map`);
  // Every part with content approved: the rule passes.
  assert.notEqual(nextThing({ ...withDocs, caseMap: { approved: 4, withContent: 4 } }).kind, "approve-map");
});

test("rule 5: documents but no map and no section yet asks for the map", () => {
  assert.deepEqual(nextThing(withDocs), { kind: "build-map" });
  assert.equal(currentStep(withDocs), "case-map");
  assert.equal(nextThingPath(ID, { kind: "build-map" }), `/cases/${ID}/case-map`);
  // A section of hers already written: the map is not asked for first (it is optional).
  assert.deepEqual(nextThing({ ...withDocs, sections: sections("not-started", { [S1]: "hers" }) }), { kind: "start-section", sectionId: S2 });
});

test("rule 6: the first section not started, in ABA Matrix's order", () => {
  const approvedMap = { approved: 5, withContent: 5 };
  assert.deepEqual(nextThing({ ...withDocs, caseMap: approvedMap }), { kind: "start-section", sectionId: S1 });
  assert.deepEqual(nextThing({ ...withDocs, caseMap: approvedMap, sections: sections("not-started", { [S1]: "approved", [S3]: "hers" }) }), { kind: "start-section", sectionId: S2 });
  // A section missing from the inputs is not started.
  assert.deepEqual(nextThing({ ...withDocs, caseMap: approvedMap, sections: [{ id: S1, state: "approved" }] }), { kind: "start-section", sectionId: S2 });
  assert.equal(currentStep({ ...withDocs, caseMap: approvedMap }), "report");
});

test("rule 8: every section hers or approved, the map approved or never made: everything is done", () => {
  const done = { ...withDocs, caseMap: { approved: 5, withContent: 5 }, sections: sections("approved", { [S2]: "hers" }) };
  assert.deepEqual(nextThing(done), { kind: "all-ready" });
  assert.equal(currentStep(done), null);
  assert.equal(everythingDone(done), true);
  assert.equal(nextThingPath(ID, { kind: "all-ready" }), `/cases/${ID}/report`);
  // The map is optional: nine sections of hers with no map are done too.
  assert.deepEqual(nextThing({ ...withDocs, sections: sections("hers") }), { kind: "all-ready" });
  assert.equal(everythingDone(withDocs), false);
});

test("the order: unsaved, documents, drafts, map, new map, first section, done", () => {
  const everything: NextInputs = { unsaved: true, sources: 0, caseMap: { approved: 0, withContent: 2 }, mapPartToApprove: "client", sections: sections("not-started", { [S2]: "drafted" }) };
  const seen: string[] = [];
  let inputs = everything;
  for (;;) {
    const thing = nextThing(inputs);
    seen.push(thing.kind);
    if (thing.kind === "unsaved") inputs = { ...inputs, unsaved: false };
    else if (thing.kind === "add-documents") inputs = { ...inputs, sources: 1 };
    else if (thing.kind === "review-draft") inputs = { ...inputs, sections: sections("not-started") };
    else if (thing.kind === "approve-map") inputs = { ...inputs, caseMap: { approved: 0, withContent: 0 }, mapPartToApprove: null };
    else if (thing.kind === "build-map") inputs = { ...inputs, caseMap: { approved: 3, withContent: 3 } };
    else if (thing.kind === "start-section") inputs = { ...inputs, sections: sections("approved") };
    else break;
  }
  assert.deepEqual(seen, ["unsaved", "add-documents", "review-draft", "approve-map", "build-map", "start-section", "all-ready"]);
});

test("Home's five segments are the sidebar's step states, the two steps not built yet included", () => {
  assert.deepEqual(
    stepStates({ sources: 2, caseMap: { approved: 1, withContent: 3 }, sections: sections("not-started", { [S1]: "hers" }) }).map((entry) => `${entry.step}:${entry.state}`),
    ["sources:done", "case-map:in-progress", "interventions:later", "report:in-progress", "review:later"],
  );
});
