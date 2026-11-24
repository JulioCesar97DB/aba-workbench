import { REPORT_SECTIONS, type ReportSectionId } from "../../shared/report-sections.ts";
import { countWords, findMarkers } from "../../shared/section-text.ts";
import { isReady, type SectionSummary } from "../../shared/sections.ts";

/*
 * Revisión y copia (owner's proposal §4 "5 · Revisión y copia", mockup 10; decisions T8, P2,
 * P4): what each row offers, which row holds the screen's one primary, and what the rail says
 * before she pastes. No React here, so it is tested on its own (tests/review-view.test.ts).
 */

/**
 * The one button of a row (layout rule 5), naming the next thing for that section: copy it
 * (hers or approved), copy it again (copied as it is now), review the AI's draft first, or
 * start it.
 */
export type ReviewAction = "copy" | "copy-again" | "review" | "start";

export function reviewAction(summary: Pick<SectionSummary, "state" | "copied">): ReviewAction {
  if (summary.state === "not-started") return "start";
  if (summary.state === "drafted") return "review";
  return summary.copied ? "copy-again" : "copy";
}

/** The row with the screen's one primary "Copiar": the first section, in ABA Matrix's order, ready and not copied as it is now. Null when none. */
export function firstToCopy(sections: ReadonlyArray<Pick<SectionSummary, "id" | "state" | "copied">>): ReportSectionId | null {
  const byId = new Map(sections.map((summary) => [summary.id, summary]));
  return (
    REPORT_SECTIONS.find((section) => {
      const summary = byId.get(section.id);
      return isReady(summary) && !summary?.copied;
    })?.id ?? null
  );
}

/** What a section's text still has marked: how many markers, and whether all of them are [MISSING: …]. */
export interface Marked {
  count: number;
  allMissing: boolean;
}

export function markedIn(text: string | null): Marked {
  const markers = text === null ? [] : findMarkers(text);
  return { count: markers.length, allMissing: markers.every((marker) => marker.kind === "missing") };
}

/** A row's words, as the row shows them; null when the section has no text. */
export function wordsIn(text: string | null): number | null {
  return text === null ? null : countWords(text);
}

/**
 * "Antes de pegar" (the rail): what she should know before pasting, section by section in
 * ABA Matrix's order: details still marked in the version she would copy, and AI drafts not
 * approved yet. A section not started has nothing to paste and is not listed.
 */
export type PasteNote = { sectionId: ReportSectionId; kind: "marked"; marked: Marked } | { sectionId: ReportSectionId; kind: "draft" };

export function beforePasting(sections: ReadonlyArray<{ summary: Pick<SectionSummary, "id" | "state">; text: string | null }>): PasteNote[] {
  const byId = new Map(sections.map((item) => [item.summary.id, item]));
  const notes: PasteNote[] = [];
  for (const section of REPORT_SECTIONS) {
    const item = byId.get(section.id);
    if (!item || item.summary.state === "not-started") continue;
    if (item.summary.state === "drafted") notes.push({ sectionId: section.id, kind: "draft" });
    const marked = markedIn(item.text);
    if (marked.count > 0) notes.push({ sectionId: section.id, kind: "marked", marked });
  }
  return notes;
}
