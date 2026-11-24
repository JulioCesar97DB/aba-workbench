import { REPORT_SECTIONS, type ReportSectionId } from "../../shared/report-sections.ts";
import { MAX_SECTION_TEXT_LENGTH, normalizeLineEndings } from "../../shared/section-text.ts";
import type { SectionState } from "../../shared/sections.ts";
import type { FailedSave } from "../../shared/sources.ts";
import type { ChipState } from "./components/chip-state.ts";

/*
 * "Pegar lo que ya escribiste" (owner's proposal §4 "4 · Informe", decision T10): the nine
 * sections in one screen, each with a box; what she pastes in a box becomes her version of
 * that section exactly as "Ya la escribí" does on the section's own screen. The rules here
 * have no React, so they are unit-tested (tests/bulk-paste.test.ts); the screen is
 * screens/BulkPaste.tsx.
 */

/** What she has in the boxes, by section. */
export type PastedTexts = Partial<Record<ReportSectionId, string>>;

/** A box with something in it besides spaces and line breaks. */
export function isFilled(text: string | undefined): text is string {
  return text !== undefined && text.trim() !== "";
}

/**
 * Longer than a section can hold (the main process refuses it, counting line breaks as one character). The box says so and is left
 * out of "Guardar" until she shortens it, rather than cutting the paste silently (review round 1, minor 5).
 */
export function isTooLong(text: string | undefined): boolean {
  return text !== undefined && normalizeLineEndings(text).length > MAX_SECTION_TEXT_LENGTH;
}

/** The filled boxes, in ABA Matrix's order: what one press of "Guardar" saves, one call each. Their text goes as she pasted it. */
export function filledBoxes(texts: PastedTexts): Array<{ sectionId: ReportSectionId; text: string }> {
  return REPORT_SECTIONS.flatMap((section) => {
    const text = texts[section.id];
    return isFilled(text) && !isTooLong(text) ? [{ sectionId: section.id, text }] : [];
  });
}

export type BoxOutcome = "saved" | "failed";

/**
 * Saves each filled box through `save` (the section screen's own save: one call per box,
 * with no editing pass, so each is a new version of hers), one after another in ABA
 * Matrix's order. A box that fails does not stop the others. `onEach` hears each outcome
 * as it comes, so the screen shows them one by one.
 */
export async function saveBoxes(
  boxes: ReadonlyArray<{ sectionId: ReportSectionId; text: string }>,
  save: (sectionId: ReportSectionId, text: string) => Promise<boolean>,
  onEach?: (sectionId: ReportSectionId, outcome: BoxOutcome) => void,
): Promise<Partial<Record<ReportSectionId, BoxOutcome>>> {
  const outcomes: Partial<Record<ReportSectionId, BoxOutcome>> = {};
  for (const box of boxes) {
    const ok = await save(box.sectionId, box.text).catch(() => false);
    const outcome: BoxOutcome = ok ? "saved" : "failed";
    outcomes[box.sectionId] = outcome;
    onEach?.(box.sectionId, outcome);
  }
  return outcomes;
}

/** A section's state as its chip says it, on a row of the screen. */
export function sectionChip(state: SectionState): ChipState {
  if (state === "hers") return "hers";
  if (state === "drafted") return "ai-draft";
  if (state === "approved") return "approved";
  return "not-started";
}

/**
 * The texts this screen puts back in its boxes: the newest kept text of each section that came from a box here (`pasted`),
 * from the main process's list (oldest first). A kept text of the section's own screen (an edit, with or without an
 * editing pass) is that screen's alone: saved from here it would become "hers" (UX-6 review round 2, S1).
 */
export function pastedKeptTexts(failures: ReadonlyArray<FailedSave>): Map<ReportSectionId, { id: string; text: string }> {
  const kept = new Map<ReportSectionId, { id: string; text: string }>();
  for (const item of failures) {
    const section = REPORT_SECTIONS.find((candidate) => candidate.id === item.sectionId);
    if (item.about === "section" && item.pasted && section && item.editing === null && item.text !== null) kept.set(section.id, { id: item.id, text: item.text });
  }
  return kept;
}
