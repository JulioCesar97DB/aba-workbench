import assert from "node:assert/strict";
import { test } from "node:test";
import { newCaseData, type CaseData } from "../src/main/case-file.ts";
import { addMapItem, approveMapPart, removeMapItem } from "../src/main/case-map.ts";
import { saveOwnText } from "../src/main/case-sections.ts";
import { caseProgress, listedCase } from "../src/main/cases.ts";
import { REPORT_SECTIONS } from "../src/shared/report-sections.ts";

/*
 * How far a case is, as Home lists it (owner's decisions T7 and P8): read from the case's
 * data each time, through the sections' and the case map's own read functions; nothing is
 * stored. Invented data only.
 */

const ID = "5d1e2f3a-4b5c-4d6e-8f70-8192a3b4c5d6";
const T0 = "2026-11-23T10:00:00.000Z";
const T1 = "2026-11-23T10:01:00.000Z";
const claim = (value: string) => ({ value, check: null });

function blank(): CaseData {
  return newCaseData({ id: ID, label: "Invented progress case", clientAge: null, now: new Date(T0) });
}

test("a new case: no documents, no map, every section not started", () => {
  assert.deepEqual(caseProgress(blank()), {
    sources: 0,
    caseMap: { approved: 0, withContent: 0 },
    mapPartToApprove: null,
    sections: REPORT_SECTIONS.map((section) => ({ id: section.id, state: "not-started" })),
  });
});

test("documents are counted without the removed ones", () => {
  const data = blank();
  // Only removedAt is read here; the rest of a source's shape is the sources' own tests'.
  const sources = [{ id: "a" }, { id: "b", removedAt: T1 }, { id: "c" }] as unknown as CaseData["sources"];
  assert.equal(caseProgress({ ...data, sources }).sources, 2);
});

test("the map's first part with content not approved, in the map's order; sections by state", () => {
  let data = blank();
  data = addMapItem(data, "behaviors", "items", { name: claim("Invented behavior") }, null, T1).data;
  const caregivers = addMapItem(data, "caregivers", "items", { role: claim("Mother") }, null, T1);
  data = caregivers.data;
  let progress = caseProgress(data);
  assert.deepEqual(progress.caseMap, { approved: 0, withContent: 2 });
  // Caregivers come before behaviors in the map.
  assert.equal(progress.mapPartToApprove, "caregivers");

  data = approveMapPart(data, "caregivers", caregivers.version, T1) ?? data;
  progress = caseProgress(data);
  assert.deepEqual(progress.caseMap, { approved: 1, withContent: 2 });
  assert.equal(progress.mapPartToApprove, "behaviors");

  const saved = saveOwnText(data, "medical-necessity", "Her own invented paragraph.", null, T1);
  assert.ok(saved);
  progress = caseProgress(saved.data);
  assert.equal(progress.sections.find((section) => section.id === "medical-necessity")?.state, "hers");
  assert.equal(progress.sections.filter((section) => section.state === "not-started").length, REPORT_SECTIONS.length - 1);
});

test("a part approved while empty is not counted: approved never says more than the parts with content (review round 1, M2)", () => {
  let data = blank();
  const behaviors = addMapItem(data, "behaviors", "items", { name: claim("Invented behavior") }, null, T1);
  data = behaviors.data;
  const caregivers = addMapItem(data, "caregivers", "items", { role: claim("Mother") }, null, T1);
  data = approveMapPart(caregivers.data, "caregivers", caregivers.version, T1) ?? caregivers.data;
  // "Risks" gets a version with no items (an added item, then removed), and is approved.
  const risk = addMapItem(data, "risks", "items", { what: claim("Invented risk") }, null, T1);
  const removed = removeMapItem(risk.data, "risks", "items", risk.itemId, risk.version, T1);
  assert.ok(removed !== "item-not-found");
  data = approveMapPart(removed.data, "risks", removed.version, T1) ?? removed.data;
  const progress = caseProgress(data);
  assert.deepEqual(progress.caseMap, { approved: 1, withContent: 2 });
  assert.equal(progress.mapPartToApprove, "behaviors");
});

test("a case whose progress cannot be read is still listed, without it, and the reason is logged (review round 1, M6)", () => {
  const logged: string[] = [];
  const listed = listedCase(blank(), (message) => logged.push(message), () => {
    throw new Error("a value this version does not expect");
  });
  assert.equal(listed.progress, null);
  assert.equal(listed.label, "Invented progress case");
  assert.deepEqual(logged, ["A case's progress could not be read (a value this version does not expect)."]);
  // A readable case gets its progress.
  assert.notEqual(listedCase(blank(), () => undefined).progress, null);
});
