import assert from "node:assert/strict";
import { test } from "node:test";
import { REPORT_SECTIONS, type ReportSectionId } from "../src/shared/report-sections.ts";
import { filledBoxes, isFilled, saveBoxes, sectionChip } from "../src/renderer/src/bulk-paste.ts";

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
