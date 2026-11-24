import assert from "node:assert/strict";
import { test } from "node:test";
import { REPORT_SECTIONS, type ReportSectionId } from "../src/shared/report-sections.ts";
import { isCopied, versionToCopy, type SectionState } from "../src/shared/sections.ts";
import { beforePasting, firstToCopy, markedIn, reviewAction, wordsIn } from "../src/renderer/src/review-view.ts";

/*
 * Revisión y copia (owner's proposal §4 "5 · Revisión y copia", decisions T8 and P2): what
 * each row offers, which row holds the one primary, and what the rail says before pasting.
 */

const [S1, S2, S3, S4] = REPORT_SECTIONS.map((section) => section.id);

function rows(states: Partial<Record<ReportSectionId, SectionState>>, copied: ReportSectionId[] = []) {
  return REPORT_SECTIONS.map((section) => ({ id: section.id, state: states[section.id] ?? ("not-started" as const), copied: copied.includes(section.id) }));
}

test("the version she copies is the approved one, or else the one shown; copied means she copied that one last", () => {
  assert.equal(versionToCopy({ approvedVersion: 2, currentVersion: 3 }), 2);
  assert.equal(versionToCopy({ approvedVersion: null, currentVersion: 3 }), 3);
  assert.equal(versionToCopy({ approvedVersion: null, currentVersion: null }), null);
  assert.equal(isCopied({ approvedVersion: 2, currentVersion: 3, copiedVersion: 2 }), true);
  assert.equal(isCopied({ approvedVersion: 2, currentVersion: 3, copiedVersion: 3 }), false);
  assert.equal(isCopied({ approvedVersion: null, currentVersion: 3, copiedVersion: 3 }), true);
  assert.equal(isCopied({ approvedVersion: null, currentVersion: 4, copiedVersion: 3 }), false);
  assert.equal(isCopied({ approvedVersion: null, currentVersion: null, copiedVersion: null }), false);
});

test("each row's one button names what comes next for that section", () => {
  assert.equal(reviewAction({ state: "not-started", copied: false }), "start");
  assert.equal(reviewAction({ state: "drafted", copied: false }), "review");
  // A draft she copied from its screen is still a draft to review first.
  assert.equal(reviewAction({ state: "drafted", copied: true }), "review");
  assert.equal(reviewAction({ state: "approved", copied: false }), "copy");
  assert.equal(reviewAction({ state: "hers", copied: false }), "copy");
  assert.equal(reviewAction({ state: "approved", copied: true }), "copy-again");
});

test("the one primary Copiar is on the first section ready and not copied yet, in ABA Matrix's order", () => {
  assert.equal(firstToCopy(rows({ [S1]: "approved", [S2]: "approved" })), S1);
  assert.equal(firstToCopy(rows({ [S1]: "approved", [S2]: "hers" }, [S1])), S2);
  // A section not started or a draft before it does not hold the primary.
  assert.equal(firstToCopy(rows({ [S1]: "drafted", [S2]: "not-started", [S3]: "approved" })), S3);
  assert.equal(firstToCopy(rows({ [S1]: "approved" }, [S1])), null);
  assert.equal(firstToCopy(rows({})), null);
});

test("words and marked details are counted in the text she would copy", () => {
  assert.equal(wordsIn(null), null);
  assert.equal(wordsIn("Two words."), 2);
  assert.deepEqual(markedIn(null), { count: 0, allMissing: true });
  assert.deepEqual(markedIn("A [MISSING: date] and [MISSING: phone]."), { count: 2, allMissing: true });
  assert.deepEqual(markedIn("A [MISSING: date] and [CHECK: dose]."), { count: 2, allMissing: false });
});

test("Antes de pegar: drafts not approved and details still marked, in ABA Matrix's order; nothing for a section not started", () => {
  const sections = [
    { summary: { id: S4, state: "approved" as const }, text: "Done [MISSING: x]." },
    { summary: { id: S1, state: "drafted" as const }, text: "Draft [CHECK: y]." },
    { summary: { id: S2, state: "hers" as const }, text: "Clean." },
    { summary: { id: S3, state: "not-started" as const }, text: null },
  ];
  assert.deepEqual(beforePasting(sections), [
    { sectionId: S1, kind: "draft" },
    { sectionId: S1, kind: "marked", marked: { count: 1, allMissing: false } },
    { sectionId: S4, kind: "marked", marked: { count: 1, allMissing: true } },
  ]);
  assert.deepEqual(beforePasting([]), []);
});
