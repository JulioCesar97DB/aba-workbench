import assert from "node:assert/strict";
import { test } from "node:test";
import { REPORT_SECTIONS, type ReportSectionId } from "../src/shared/report-sections.ts";
import { MAX_SECTION_TEXT_LENGTH } from "../src/shared/section-text.ts";
import { filledBoxes, isFilled, isTooLong, pastedKeptTexts, saveBoxes, sectionChip } from "../src/renderer/src/bulk-paste.ts";
import type { FailedSave } from "../src/shared/sources.ts";

/*
 * "Pegar lo que ya escribiste" (owner's decision T10): the filled boxes in ABA Matrix's
 * order, one save per box, a failure never stopping the others.
 */

const [S1, S2, S3, , S5] = REPORT_SECTIONS.map((section) => section.id);

test("bulk paste: a box counts as filled only with something besides spaces and line breaks", () => {
  assert.equal(isFilled(undefined), false);
  assert.equal(isFilled(""), false);
  assert.equal(isFilled("  \n\n\t "), false);
  assert.equal(isFilled(" x "), true);
});

test("bulk paste: the filled boxes come in ABA Matrix's order, whatever order she filled them in, with her text as pasted", () => {
  const boxes = filledBoxes({ [S5]: "Fifth.\n", [S1]: "  First.\n\nSecond paragraph.  ", [S2]: "   ", [S3]: "" });
  assert.deepEqual(boxes, [
    { sectionId: S1, text: "  First.\n\nSecond paragraph.  " },
    { sectionId: S5, text: "Fifth.\n" },
  ]);
  assert.deepEqual(filledBoxes({}), []);
});

test("bulk paste: one save per filled box, one after another, in order; a failure or an error does not stop the others", async () => {
  const calls: Array<[ReportSectionId, string]> = [];
  let running = 0;
  const heard: Array<[ReportSectionId, string]> = [];
  const outcomes = await saveBoxes(
    filledBoxes({ [S1]: "one", [S2]: "two", [S3]: "three", [S5]: "five" }),
    async (sectionId, text) => {
      running++;
      assert.equal(running, 1, "never two saves at once");
      calls.push([sectionId, text]);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running--;
      if (sectionId === S2) return false;
      if (sectionId === S3) throw new Error("disk gone");
      return true;
    },
    (sectionId, outcome) => heard.push([sectionId, outcome]),
  );
  assert.deepEqual(calls, [
    [S1, "one"],
    [S2, "two"],
    [S3, "three"],
    [S5, "five"],
  ]);
  assert.deepEqual(outcomes, { [S1]: "saved", [S2]: "failed", [S3]: "failed", [S5]: "saved" });
  assert.deepEqual(heard, [
    [S1, "saved"],
    [S2, "failed"],
    [S3, "failed"],
    [S5, "saved"],
  ]);
});

test("bulk paste: nothing filled, nothing saved", async () => {
  let called = false;
  assert.deepEqual(
    await saveBoxes([], async () => {
      called = true;
      return true;
    }),
    {},
  );
  assert.equal(called, false);
});

test("bulk paste: each row's chip says the section's state", () => {
  assert.equal(sectionChip("not-started"), "not-started");
  assert.equal(sectionChip("hers"), "hers");
  assert.equal(sectionChip("drafted"), "ai-draft");
  assert.equal(sectionChip("approved"), "approved");
});

test("bulk paste: a text longer than a section can hold is left out of the save, never cut (review round 1, minor 5)", () => {
  const max = MAX_SECTION_TEXT_LENGTH;
  assert.equal(isTooLong("x".repeat(max)), false);
  assert.equal(isTooLong("x".repeat(max + 1)), true);
  // Counted as the main process counts it: a Windows line break is one character.
  assert.equal(isTooLong(`${"x".repeat(max - 1)}\r\n`), false);
  assert.deepEqual(filledBoxes({ [S1]: "x".repeat(max + 1), [S2]: "fits" }), [{ sectionId: S2, text: "fits" }]);
});

test("bulk paste: only kept texts pasted here come back in the boxes, the newest of each section (review round 2, S1)", () => {
  const item = (id: string, sectionId: string, text: string | null, pasted: boolean, editing: number | null = null, about: FailedSave["about"] = "section"): FailedSave => ({
    id,
    caseId: "case",
    label: "Invented case",
    failure: "not-saved",
    about,
    sectionId,
    text,
    editing,
    mapItem: null,
    pasted,
  });
  const kept = pastedKeptTexts([
    item("1", "background-information", "Older paste.", true),
    item("2", "background-information", "Newer paste.", true),
    // The section screen's first save of a hand edit (no editing pass): that screen's alone.
    item("3", "medical-necessity", "Her hand edit of the AI draft.", false),
    // The section screen's later saves of a pass, her instructions, and an id that is no section: never here.
    item("4", "risk-assessment", "An edit in a pass.", false, 2),
    item("5", "crisis-plan", "Her instructions.", false, null, "instructions"),
    item("6", "not-a-section", "Text.", true),
  ]);
  assert.deepEqual([...kept], [["background-information", { id: "2", text: "Newer paste." }]]);
});
