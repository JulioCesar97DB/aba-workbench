import { REPORT_SECTIONS, type ReportSection, type ReportSectionId } from "../../shared/report-sections.ts";
import { findMarkers, splitParagraphs } from "../../shared/section-text.ts";
import { AI_VERSION_KINDS, type SectionDetail, type SectionSummary, type SectionVersion } from "../../shared/sections.ts";
import type { ChipState } from "./components/chip-state.ts";

/*
 * The section screen's rules that are not about drawing it: which chip a version gets,
 * which section comes next, which paragraphs changed, what the copied line says. No React
 * here, so tests/section-view.test.ts checks them on their own.
 */

/** Whether a version is the AI's (a draft, a change, a paragraph, an improvement). */
export function isAiVersion(version: Pick<SectionVersion, "kind">): boolean {
  return AI_VERSION_KINDS.includes(version.kind);
}

/**
 * Whether she edited by hand a text the AI wrote: an edit whose chain of versions (each
 * one's `basedOn`) reaches an AI version before her own pasted text.
 */
export function isCorrection(versions: readonly SectionVersion[], version: SectionVersion): boolean {
  if (version.kind !== "edited") return false;
  const byNumber = new Map(versions.map((candidate) => [candidate.number, candidate]));
  let step: SectionVersion | undefined = version;
  const seen = new Set<number>();
  while (step && !seen.has(step.number)) {
    seen.add(step.number);
    if (isAiVersion(step)) return true;
    if (step.kind === "hers") return false;
    step = step.basedOn === null ? undefined : byNumber.get(step.basedOn);
  }
  return false;
}

/**
 * The chip for the version shown (one chip in the header): approved (or copied, once she
 * copied that approved version on this screen), else what the version is.
 */
export function versionChip(detail: Pick<SectionDetail, "versions" | "approvedVersion">, version: SectionVersion, copiedVersion: number | null): ChipState {
  if (detail.approvedVersion === version.number) return copiedVersion === version.number ? "copied" : "approved";
  if (version.kind === "hers") return "hers";
  if (version.kind === "edited") return isCorrection(detail.versions, version) ? "corrected" : "hers";
  return "ai-draft";
}

/** A section she can copy as it is: hers, or approved (the sidebar's "ready", step-states.ts). */
function ready(summary: Pick<SectionSummary, "state"> | undefined): boolean {
  return summary?.state === "hers" || summary?.state === "approved";
}

/**
 * The next section to work on (owner's proposal §4, "Next"): the first one after this
 * one, in ABA Matrix's order, that is not ready; then the first not ready before it. Null
 * when every other section is ready.
 */
export function nextSection(sections: ReadonlyArray<Pick<SectionSummary, "id" | "state">>, currentId: ReportSectionId): ReportSection | null {
  const states = new Map(sections.map((summary) => [summary.id, summary]));
  const index = REPORT_SECTIONS.findIndex((section) => section.id === currentId);
  const order = [...REPORT_SECTIONS.slice(index + 1), ...REPORT_SECTIONS.slice(0, Math.max(index, 0))];
  return order.find((section) => !ready(states.get(section.id))) ?? null;
}

/**
 * For each paragraph of a version, whether it is new or different from the version it was
 * made from ("see what changed"). A paragraph counts as unchanged when the earlier text has
 * it word for word anywhere, so a paragraph moved is not marked.
 */
export function changedParagraphs(text: string, baseText: string): boolean[] {
  const before = new Set(splitParagraphs(baseText).map((paragraph) => paragraph.trim()));
  return splitParagraphs(text).map((paragraph) => !before.has(paragraph.trim()));
}

/** The paragraph the AI is on while it streams a whole text (1-based; 1 before any text). */
export function paragraphBeingWritten(streamed: string): number {
  return Math.max(1, splitParagraphs(streamed).length);
}

/** What the copied line says first: plain "Copied.", or how many details are still marked, and of which kind. */
export function copiedLead(text: string): { key: "copiedLead" } | { key: "copiedMissing" | "copiedMarked"; count: number } {
  const markers = findMarkers(text);
  if (markers.length === 0) return { key: "copiedLead" };
  return { key: markers.every((marker) => marker.kind === "missing") ? "copiedMissing" : "copiedMarked", count: markers.length };
}
