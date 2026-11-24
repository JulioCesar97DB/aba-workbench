import { REPORT_SECTIONS, type ReportSection, type ReportSectionId } from "../../shared/report-sections.ts";
import { splitParagraphs } from "../../shared/section-text.ts";
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
 * "Siguiente paso" for a section (owner's proposal §4, "Next"): the next section not ready;
 * with none left, "Review and copy". That says every section is ready only when this one is
 * ready too: on the last unfinished section, the others being ready is not all of them
 * (UX-3 review round 2, S-1).
 */
export function nextStep(sections: ReadonlyArray<Pick<SectionSummary, "id" | "state">>, currentId: ReportSectionId): { kind: "section"; section: ReportSection } | { kind: "review"; allReady: boolean } {
  const section = nextSection(sections, currentId);
  if (section) return { kind: "section", section };
  return { kind: "review", allReady: ready(sections.find((summary) => summary.id === currentId)) };
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

/**
 * What the copied line says first: plain "Copied.", or how many details are still marked,
 * and of which kind. From what the main process put on the clipboard (the copy's own
 * answer, `markers` and `allMissing`), never from a text the screen may not have yet.
 */
export function copiedLead(copied: { markers: number; allMissing: boolean }): { key: "copiedLead" } | { key: "copiedMissing" | "copiedMarked"; count: number } {
  if (copied.markers === 0) return { key: "copiedLead" };
  return { key: copied.allMissing ? "copiedMissing" : "copiedMarked", count: copied.markers };
}

/** Her own text: what she pasted, or edited by hand (a hand edit is her word on the facts, even of an AI text). */
export function isHerText(version: Pick<SectionVersion, "kind">): boolean {
  return version.kind === "hers" || version.kind === "edited";
}

/**
 * "Mejorarla con la IA" from the editor (UX-3 review round 1, S1) improves what she has on
 * screen, as her text. So it is offered when the box holds text that is hers: anything she
 * typed, or a version that is already her text, untouched. An AI version opened in the
 * editor and left as it was is not her text, and is not sent as if it were.
 * `opened` is the version the editor opened on (null when she pastes a new text).
 */
export function canImproveFromEditor(onScreen: string, opened: Pick<SectionVersion, "kind" | "text"> | null): boolean {
  if (onScreen.trim() === "") return false;
  return opened === null || isHerText(opened) || onScreen !== opened.text;
}

/**
 * Which version to improve once what is on screen is saved: the version this editing pass
 * wrote (it holds what she has on screen), or, when there was nothing to save, the version
 * she opened, if it is her text. Null: nothing of hers to improve.
 */
export function improveFromVersion(passVersion: number | null, opened: Pick<SectionVersion, "kind" | "number"> | null): number | null {
  if (passVersion !== null) return passVersion;
  return opened !== null && isHerText(opened) ? opened.number : null;
}

/**
 * "Mejorarla con la IA" pressed in the editor (UX-3 review round 1, S1): the version to
 * improve, or null to send nothing. What she has on screen is saved first (`flush`); only
 * then is the version this editing pass wrote read (`passVersion`), since that save may be
 * the one that makes it. Reading it before the save would send an earlier version.
 */
export async function improveFromEditorVersion({
  onScreen,
  opened,
  flush,
  passVersion,
}: {
  onScreen: string;
  opened: Pick<SectionVersion, "kind" | "number" | "text"> | null;
  flush: () => Promise<boolean>;
  passVersion: () => number | null;
}): Promise<number | null> {
  if (!canImproveFromEditor(onScreen, opened)) return null;
  if (!(await flush())) return null;
  return improveFromVersion(passVersion(), opened);
}
