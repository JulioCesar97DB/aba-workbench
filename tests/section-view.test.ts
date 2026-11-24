import assert from "node:assert/strict";
import { test } from "node:test";
import { relativeDay } from "../src/renderer/src/format.ts";
import { en } from "../src/renderer/src/i18n/en.ts";
import { es } from "../src/renderer/src/i18n/es.ts";
import { canImproveFromEditor, changedParagraphs, copiedLead, improveFromEditorVersion, improveFromVersion, isCorrection, nextSection, nextStep, paragraphBeingWritten, versionChip } from "../src/renderer/src/section-view.ts";
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

test("Next step on the last unfinished section is Review and copy, but not \"all ready\" until this one is (review round 2, S-1)", () => {
  const states = (ready: number[], current?: SectionState) =>
    REPORT_SECTIONS.map((section, index) => ({ id: section.id, state: (ready.includes(index) ? "approved" : index === 8 && current ? current : "drafted") as SectionState }));
  const others = [0, 1, 2, 3, 4, 5, 6, 7];
  // The other eight ready, this one an AI draft not approved: not every section is ready.
  assert.deepEqual(nextStep(states(others, "drafted"), REPORT_SECTIONS[8].id), { kind: "review", allReady: false });
  // Not started at all: not ready either.
  assert.deepEqual(nextStep(states(others).filter((summary) => summary.id !== REPORT_SECTIONS[8].id), REPORT_SECTIONS[8].id), { kind: "review", allReady: false });
  // Approved, or written by her: now all nine are.
  assert.deepEqual(nextStep(states(others, "approved"), REPORT_SECTIONS[8].id), { kind: "review", allReady: true });
  assert.deepEqual(nextStep(states(others, "hers"), REPORT_SECTIONS[8].id), { kind: "review", allReady: true });
  // Another section still to do: that one.
  assert.deepEqual(nextStep(states([0, 1, 2, 3, 4, 5, 6]), REPORT_SECTIONS[8].id), { kind: "section", section: REPORT_SECTIONS[7] });
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

test("the copied line says how many details are still marked, and of which kind (P2), from the copy's own answer (UX-7 review round 1, S1)", () => {
  assert.deepEqual(copiedLead({ markers: 0, allMissing: true }), { key: "copiedLead" });
  assert.deepEqual(copiedLead({ markers: 2, allMissing: true }), { key: "copiedMissing", count: 2 });
  assert.deepEqual(copiedLead({ markers: 2, allMissing: false }), { key: "copiedMarked", count: 2 });
  assert.deepEqual(copiedLead({ markers: 1, allMissing: false }), { key: "copiedMarked", count: 1 });
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

test("Improve it with the AI from the editor: only her text, as she has it on screen (review round 1, S1)", () => {
  const draft = version(2, "draft", null, "The AI's text.");
  const hers = version(1, "hers", null, "Her text.");
  // An AI draft opened in the editor and left as it was is not her text.
  assert.equal(canImproveFromEditor("The AI's text.", draft), false);
  // Once she changed it, what is on screen is hers.
  assert.equal(canImproveFromEditor("The AI's text, corrected by her.", draft), true);
  // Her own version, untouched, is her text as it is.
  assert.equal(canImproveFromEditor("Her text.", hers), true);
  // A new text she pastes, once there is one.
  assert.equal(canImproveFromEditor("  ", null), false);
  assert.equal(canImproveFromEditor("Pasted.", null), true);
  // After saving what is on screen: the version this pass wrote, never the one she opened.
  assert.equal(improveFromVersion(3, draft), 3);
  assert.equal(improveFromVersion(null, hers), 1);
  assert.equal(improveFromVersion(null, draft), null);
  assert.equal(improveFromVersion(null, null), null);
});

/**
 * One editing pass as the screen runs it: her text on screen, the version the pass has
 * written so far, and a flush that saves what is on screen (one version per pass: the
 * first save makes the next version, later saves update it).
 */
function editingPass(opened: SectionVersion | null, nextNumber: number, initial: string) {
  const pass = { onScreen: initial, saved: initial, version: null as number | null, sent: [] as { version: number; text: string }[], flushes: 0 };
  const flush = async () => {
    pass.flushes += 1;
    // The save goes to the main process and back before the pass knows its version.
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (pass.onScreen !== pass.saved) {
      pass.version ??= nextNumber;
      pass.saved = pass.onScreen;
      pass.sent.push({ version: pass.version, text: pass.onScreen });
    }
    return true;
  };
  const press = () => improveFromEditorVersion({ onScreen: pass.onScreen, opened, flush, passVersion: () => pass.version });
  return { pass, press, opened };
}

test("Improve it with the AI from the editor sends what is on screen when she presses it, saved as her text first (review round 1, S1)", async () => {
  const draft = version(2, "draft", null, "The AI's text.");
  // She opens the AI's draft, types a correction and presses at once: nothing of this pass is saved yet.
  const quick = editingPass(draft, 3, draft.text);
  quick.pass.onScreen = "The AI's text, with her correction.";
  assert.equal(await quick.press(), 3);
  assert.deepEqual(quick.pass.sent, [{ version: 3, text: "The AI's text, with her correction." }]);

  // An earlier save of this pass, then more typing: the newest text is saved into the pass's version, and that is sent.
  const later = editingPass(draft, 3, draft.text);
  later.pass.onScreen = "First correction.";
  assert.equal(await later.press(), 3);
  later.pass.onScreen = "First correction. And a second one.";
  assert.equal(await later.press(), 3);
  assert.equal(later.pass.saved, "First correction. And a second one.");

  // The AI's draft opened and left as it was: nothing is sent, and nothing is saved as hers.
  const untouched = editingPass(draft, 3, draft.text);
  assert.equal(await untouched.press(), null);
  assert.equal(untouched.pass.flushes, 0);

  // Her own version, untouched: that version, as it is.
  const hers = version(1, "hers", null, "Her text.");
  const own = editingPass(hers, 3, hers.text);
  assert.equal(await own.press(), 1);
  assert.deepEqual(own.pass.sent, []);

  // A pasted text, pressed before the typing pause: saved first, then that version.
  const pasted = editingPass(null, 1, "");
  pasted.pass.onScreen = "Her pasted text.";
  assert.equal(await pasted.press(), 1);
  // An empty box sends nothing.
  assert.equal(await editingPass(null, 1, "").press(), null);
});
