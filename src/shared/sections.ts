import type { ReportSectionId } from "./report-sections.ts";
import type { SectionShape } from "./section-text.ts";

/*
 * A case's report sections as the interface sees them: each section's state, its
 * versions, and the requests the interface may make. Plain data only, shared by the main
 * process (which keeps them in the case's data file) and the interface.
 */

/**
 * - "not-started": nothing yet.
 * - "hers": the text she wrote herself (pasted from ABA Matrix, or typed) is the current one.
 * - "drafted": the current version was written by the AI.
 * - "approved": she approved a version; it is what she copies to ABA Matrix.
 */
export type SectionState = "not-started" | "hers" | "drafted" | "approved";

/**
 * How a version came to be:
 * - "hers": her own text, pasted or typed ("I already wrote it");
 * - "draft": written by the AI from the sources;
 * - "change": the AI rewrote the whole text as she asked;
 * - "paragraph": the AI rewrote one paragraph as she asked;
 * - "improve": the AI improved her own text;
 * - "edited": she edited a version by hand.
 */
export type VersionKind = "hers" | "draft" | "change" | "paragraph" | "improve" | "edited";

export const AI_VERSION_KINDS: readonly VersionKind[] = ["draft", "change", "paragraph", "improve"];

export interface SectionVersion {
  /** 1, 2, 3...: the version's number within the section, never reused. */
  number: number;
  kind: VersionKind;
  createdAt: string;
  /** Her request, in her own words, for "change" and "paragraph". */
  request: string | null;
  /** The paragraph she marked (0-based), for "paragraph". */
  paragraphIndex: number | null;
  /** The version it was made from. */
  basedOn: number | null;
  /** Who wrote an AI version: the model that actually answered, and its provider. */
  model: string | null;
  provider: "anthropic" | "openai" | "mock" | null;
  /** What it cost in USD, when the price is known (null with ChatGPT sign-in, which spends the plan). */
  costUsd: number | null;
  /** The sources it was written from: their ids, and their titles as the model saw them. */
  sourcesUsed: Array<{ id: string; title: string }>;
  /** For an AI version: whether it contradicts her sections, checked by the AI right after it was written. */
  consistency: ConsistencyResult | null;
  /** What that check cost, when known. */
  checkCostUsd: number | null;
  text: string;
}

/**
 * The consistency check of an AI version against her sections (hers or approved):
 * - "none": no contradiction found;
 * - "found": `items` lists each one, in English, as the model wrote it;
 * - "nothing-to-compare": she has no other section written or approved yet (no AI call made);
 * - "failed": the check could not run (the version itself is saved).
 */
export interface ConsistencyResult {
  status: "none" | "found" | "nothing-to-compare" | "failed";
  items: string[];
  /** Her sections changed since the check (another version approved or written): it may no longer hold. */
  stale: boolean;
}

export interface SectionSummary {
  id: ReportSectionId;
  state: SectionState;
  /** The version shown, or null when there is none. */
  currentVersion: number | null;
  /** The version she approved, or null. */
  approvedVersion: number | null;
  versionCount: number;
  /** What the AI cost for this section so far, in USD (versions and checks whose price is known; ChatGPT sign-in adds nothing). */
  costUsd: number;
}

export interface SectionDetail extends SectionSummary {
  /** Oldest first. */
  versions: SectionVersion[];
  /** Her standing instructions for this section, for all her cases. */
  instructions: string;
  /** What the section's rules ask of its shape, for the structure check. */
  shape: SectionShape;
  /**
   * The case's save time (updatedAt) this snapshot was read at. Every save of the case
   * makes it later, so of two snapshots the later revision is the newer one: an answer
   * that comes back late never replaces a newer one on screen.
   */
  revision: string;
}

/** Whether a snapshot of the section is older than the one shown (an answer that came back late). */
export function isOlderRevision(next: string, shown: string): boolean {
  const [a, b] = [Date.parse(next), Date.parse(shown)];
  return Number.isFinite(a) && Number.isFinite(b) && a < b;
}

/** What she asks the AI from the section's screen. */
export type SectionRequestInput =
  | { kind: "draft" }
  | { kind: "change"; fromVersion: number; request: string }
  | { kind: "paragraph"; fromVersion: number; paragraphIndex: number; request: string }
  | { kind: "improve"; fromVersion: number };

/** A section's state, from its versions and what she approved. */
export function sectionState(versions: ReadonlyArray<Pick<SectionVersion, "number" | "kind">>, currentVersion: number | null, approvedVersion: number | null): SectionState {
  if (versions.length === 0) return "not-started";
  if (approvedVersion !== null) return "approved";
  const current = versions.find((version) => version.number === currentVersion) ?? versions.at(-1);
  return current?.kind === "hers" || current?.kind === "edited" ? "hers" : "drafted";
}
