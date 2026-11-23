import assert from "node:assert/strict";
import { test } from "node:test";
import { relativeDay } from "../src/renderer/src/format.ts";
import { en } from "../src/renderer/src/i18n/en.ts";
import { es } from "../src/renderer/src/i18n/es.ts";
import { changedParagraphs, copiedLead, isCorrection, nextSection, paragraphBeingWritten, versionChip } from "../src/renderer/src/section-view.ts";
import { REPORT_SECTIONS } from "../src/shared/report-sections.ts";
import type { SectionState, SectionVersion } from "../src/shared/sections.ts";

/*
 * The section screen's rules that are not drawing (owner's proposal §4, UX-3): which chip
 * a version gets, which section comes next, what changed, what the copied line says.
 */

function version(number: number, kind: SectionVersion["kind"], basedOn: number | null = null, text = `Text ${number}.`): SectionVersion {
  return {
    number,
    kind,
    createdAt: "2026-11-23T11:20:00.000Z",
    request: null,
    paragraphIndex: null,
    basedOn,
    model: kind === "hers" || kind === "edited" ? null : "gpt-5",
    provider: kind === "hers" || kind === "edited" ? null : "openai",
    costUsd: null,
    sourcesUsed: [],
    consistency: null,
    checkCostUsd: null,
    text,
  };
}

test("an edit counts as corrected by her only when it goes back to an AI version", () => {
  const versions = [version(1, "hers"), version(2, "edited", 1), version(3, "draft"), version(4, "edited", 3), version(5, "edited", 4)];
  assert.equal(isCorrection(versions, versions[1]), false);
  assert.equal(isCorrection(versions, versions[3]), true);
  assert.equal(isCorrection(versions, versions[4]), true);
  assert.equal(isCorrection(versions, versions[2]), false);
});

test("one chip in the header: approved and copied first, else what the version is", () => {
  const versions = [version(1, "draft"), version(2, "edited", 1), version(3, "hers"), version(4, "change", 1)];
  const detail = { versions, approvedVersion: 2 };
  assert.equal(versionChip(detail, versions[0], null), "ai-draft");
  assert.equal(versionChip(detail, versions[3], null), "ai-draft");
  assert.equal(versionChip(detail, versions[2], null), "hers");
  assert.equal(versionChip(detail, versions[1], null), "approved");
  assert.equal(versionChip(detail, versions[1], 2), "copied");
  // Copying a version that is not the approved one does not make it "Copied".
  assert.equal(versionChip(detail, versions[0], 1), "ai-draft");
  assert.equal(versionChip({ versions, approvedVersion: null }, versions[1], null), "corrected");
});

test("the next section is the first after this one, in ABA Matrix's order, that is not ready; then those before it", () => {
  const states = (ready: number[]) => REPORT_SECTIONS.map((section, index) => ({ id: section.id, state: (ready.includes(index) ? "approved" : "drafted") as SectionState }));
  assert.equal(nextSection(states([]), REPORT_SECTIONS[1].id)?.id, REPORT_SECTIONS[2].id);
  assert.equal(nextSection(states([2, 3]), REPORT_SECTIONS[1].id)?.id, REPORT_SECTIONS[4].id);
  assert.equal(nextSection(states([0, 2, 3, 4, 5, 6, 7, 8]), REPORT_SECTIONS[8].id)?.id, REPORT_SECTIONS[1].id);
  assert.equal(nextSection(states([0, 1, 2, 3, 4, 5, 6, 7]), REPORT_SECTIONS[8].id), null);
  // A section with nothing yet is not ready either.
  assert.equal(nextSection([], REPORT_SECTIONS[8].id)?.id, REPORT_SECTIONS[0].id);
});

test("see what changed: a paragraph new or different from the version it came from; one moved is not", () => {
  assert.deepEqual(changedParagraphs("A.\n\nB, shorter.\n\nC.", "A.\n\nB.\n\nC."), [false, true, false]);
  assert.deepEqual(changedParagraphs("C.\n\nA.", "A.\n\nC."), [false, false]);
  assert.deepEqual(changedParagraphs("A.\n\nNew.", "A."), [false, true]);
});

test("the paragraph being written is the last one begun, and 1 before any text", () => {
  assert.equal(paragraphBeingWritten(""), 1);
  assert.equal(paragraphBeingWritten("One."), 1);
  assert.equal(paragraphBeingWritten("One.\n\nTwo.\n\nThr"), 3);
});

test("the copied line says how many details are still marked, and of which kind (P2)", () => {
  assert.deepEqual(copiedLead("All there."), { key: "copiedLead" });
  assert.deepEqual(copiedLead("Score [MISSING: percentile]. Age [MISSING: date of birth]."), { key: "copiedMissing", count: 2 });
  assert.deepEqual(copiedLead("Score [MISSING: percentile].\n\nSchool [CHECK: name]."), { key: "copiedMarked", count: 2 });
  for (const strings of [en, es]) {
    assert.match(strings.section.copiedMissing_one, /\[MISSING: …\]/);
    assert.match(strings.section.copiedMarked_other, /\[CHECK: …\]/);
  }
});

test("a version's day: today, yesterday, or neither, on this computer's calendar", () => {
  const now = new Date(2026, 10, 23, 9, 0);
  assert.equal(relativeDay(new Date(2026, 10, 23, 0, 5).toISOString(), now), "today");
  assert.equal(relativeDay(new Date(2026, 10, 22, 23, 55).toISOString(), now), "yesterday");
  assert.equal(relativeDay(new Date(2026, 10, 21, 12, 0).toISOString(), now), null);
});
