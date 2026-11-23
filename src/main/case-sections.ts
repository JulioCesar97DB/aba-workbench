import { z } from "zod";
import type { ContextSection } from "../lib/rules.ts";
import { REPORT_SECTIONS, type ReportSectionId } from "../shared/report-sections.ts";
import { MAX_NOTES_LENGTH, MAX_REQUEST_LENGTH, MAX_SECTION_TEXT_LENGTH, normalizeLineEndings, type SectionShape } from "../shared/section-text.ts";
import { AI_VERSION_KINDS, sectionState, type ConsistencyResult, type SectionDetail, type SectionRequestInput, type SectionSummary, type SectionVersion, type VersionKind } from "../shared/sections.ts";
import type { CaseData, GenerationRecord, StoredSection, StoredUsage, StoredVersion } from "./case-file.ts";

/*
 * A case's report sections, inside its data file (src/main/case-file.ts, version 3):
 * what the interface may send, and the changes made to the data. Pure functions on
 * CaseData: nothing here touches the disk, so it is unit-tested.
 *
 * Nothing is ever lost (owner's decision, 2026-11-22): every AI answer and every editing
 * pass of hers is a new version; going back to a version only moves the current pointer.
 * The one version that changes is the one she is typing in, while she types.
 */

export const SectionIdSchema = z.enum(REPORT_SECTIONS.map((section) => section.id) as [ReportSectionId, ...ReportSectionId[]]);
const VersionInputSchema = z.int().min(1).max(1_000_000);
const RequestTextSchema = z.string().trim().min(1).max(MAX_REQUEST_LENGTH);

export const SectionTextSchema = z.string().max(MAX_SECTION_TEXT_LENGTH * 2);
export const EditingSchema = VersionInputSchema.nullable();
export const VersionSchema = VersionInputSchema;
export const ApproveSchema = VersionInputSchema.nullable();
export const NotesSchema = z.string().max(MAX_NOTES_LENGTH * 2);

export const SectionRequestSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("draft") }),
  z.strictObject({ kind: z.literal("change"), fromVersion: VersionInputSchema, request: RequestTextSchema }),
  z.strictObject({ kind: z.literal("paragraph"), fromVersion: VersionInputSchema, paragraphIndex: z.int().min(0).max(10_000), request: RequestTextSchema }),
  z.strictObject({ kind: z.literal("improve"), fromVersion: VersionInputSchema }),
]);

/** Why a change cannot be made, before anything is saved (refused as "Refused: ..."). */
export class SectionInputError extends Error {}

const KNOWN_KINDS: readonly VersionKind[] = ["hers", "draft", "change", "paragraph", "improve", "edited"];

function emptySection(): StoredSection {
  return { currentVersion: null, approvedVersion: null, versions: [] };
}

export function storedSection(data: CaseData, id: ReportSectionId): StoredSection {
  return data.sections[id] ?? emptySection();
}

function withSection(data: CaseData, id: ReportSectionId, section: StoredSection): CaseData {
  return { ...data, sections: { ...data.sections, [id]: section } };
}

function findVersion(section: StoredSection, number: number | null): StoredVersion | undefined {
  return number === null ? undefined : section.versions.find((version) => version.number === number);
}

/** The version shown: the current one, or the newest when the pointer names none. */
function currentOf(section: StoredSection): StoredVersion | undefined {
  return findVersion(section, section.currentVersion) ?? section.versions.at(-1);
}

function kindOf(version: StoredVersion): VersionKind {
  // A kind a newer app wrote is shown as an edit: hers to review, never mistaken for an AI draft.
  return (KNOWN_KINDS as readonly string[]).includes(version.kind) ? (version.kind as VersionKind) : "edited";
}

/** Her text before any AI version: "hers" stays her state through her own edits. */
function stateOf(section: StoredSection): SectionSummary["state"] {
  const versions = section.versions.map((version) => ({ number: version.number, kind: kindOf(version) }));
  const state = sectionState(versions, currentOf(section)?.number ?? null, section.approvedVersion);
  if (state !== "hers") return state;
  const current = currentOf(section);
  if (current && kindOf(current) === "edited" && versions.some((version) => version.kind !== "hers" && version.kind !== "edited" && version.number < current.number)) return "drafted";
  return state;
}

export function sectionSummary(data: CaseData, id: ReportSectionId): SectionSummary {
  const section = storedSection(data, id);
  return {
    id,
    state: stateOf(section),
    currentVersion: currentOf(section)?.number ?? null,
    approvedVersion: findVersion(section, section.approvedVersion)?.number ?? null,
    versionCount: section.versions.length,
    costUsd: sectionCost(section),
  };
}

/** What the AI cost for this section so far: every version and every check whose price is known (review, low 2). */
function sectionCost(section: StoredSection): number {
  return section.versions.reduce((sum, version) => sum + (version.generation?.costUsd ?? 0) + checksCost(version), 0);
}

/** What the checks of one version cost: the latest, and every earlier one that "Check again" replaced (review round 1, P1). */
function checksCost(version: StoredVersion): number {
  return (version.consistency?.costUsd ?? 0) + (version.consistency?.earlierCostUsd ?? 0);
}

export function sectionSummaries(data: CaseData): SectionSummary[] {
  return REPORT_SECTIONS.map((section) => sectionSummary(data, section.id));
}

function versionView(version: StoredVersion, context: ReadonlyArray<{ id: string; version: number }>): SectionVersion {
  const generation = version.generation;
  const provider = generation?.provider;
  return {
    number: version.number,
    kind: kindOf(version),
    createdAt: version.createdAt,
    request: version.request ?? null,
    paragraphIndex: version.paragraphIndex ?? null,
    basedOn: version.basedOn ?? null,
    model: generation?.servedModel ?? null,
    provider: provider === "anthropic" || provider === "openai" || provider === "mock" ? provider : null,
    costUsd: generation?.costUsd ?? null,
    sourcesUsed: generation?.sourcesUsed.map(({ id, title }) => ({ id, title })) ?? [],
    consistency: version.consistency ? consistencyView(version.consistency, context) : null,
    checkCostUsd: version.consistency && (version.consistency.costUsd !== null || (version.consistency.earlierCostUsd ?? 0) > 0) ? checksCost(version) : null,
    text: version.text,
  };
}

function consistencyView(stored: NonNullable<StoredVersion["consistency"]>, context: ReadonlyArray<{ id: string; version: number }>): ConsistencyResult {
  const status = stored.status === "none" || stored.status === "found" || stored.status === "nothing-to-compare" ? stored.status : "failed";
  const key = (list: ReadonlyArray<{ id: string; version: number }>) =>
    list
      .map((entry) => `${entry.id}@${entry.version}`)
      .sort()
      .join(",");
  // Her sections changed since the check: what it said may no longer hold (review M5).
  return { status, items: stored.items, stale: key(stored.sectionsCompared) !== key(context) };
}

/** Two token records added up (an absent one counts as nothing). */
function addUsage(a: StoredUsage | undefined, b: StoredUsage | undefined): StoredUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  const reasoning = a.reasoningTokens == null && b.reasoningTokens == null ? null : (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0);
  return {
    uncachedInputTokens: a.uncachedInputTokens + b.uncachedInputTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: reasoning,
  };
}

/**
 * Saves the consistency check's result on a version. Null when the version is gone. A
 * check run again replaces the result, but what the earlier checks of the version cost
 * and used is carried over (earlierCostUsd, earlierUsage), so a failed "Check again"
 * never takes money already spent out of the totals (review round 1, P1).
 */
export function setConsistency(data: CaseData, id: ReportSectionId, number: number, consistency: NonNullable<StoredVersion["consistency"]>): CaseData | null {
  const section = storedSection(data, id);
  const index = section.versions.findIndex((version) => version.number === number);
  if (index === -1) return null;
  const versions = [...section.versions];
  const earlier = versions[index].consistency;
  if (earlier) {
    const earlierCostUsd = (earlier.earlierCostUsd ?? 0) + (earlier.costUsd ?? 0);
    const earlierUsage = addUsage(earlier.earlierUsage, earlier.usage);
    consistency = { ...consistency, ...(earlierCostUsd > 0 ? { earlierCostUsd } : {}), ...(earlierUsage ? { earlierUsage } : {}) };
  }
  versions[index] = { ...versions[index], consistency };
  return withSection(data, id, { ...section, versions });
}

export function sectionDetail(data: CaseData, id: ReportSectionId, instructions: string, shape: SectionShape = { paragraphs: null, words: null }): SectionDetail {
  const context = contextSections(data, id).map(({ id: sectionId, version }) => ({ id: sectionId, version }));
  return { ...sectionSummary(data, id), versions: storedSection(data, id).versions.map((version) => versionView(version, context)), instructions, shape };
}

function nextNumber(section: StoredSection): number {
  return section.versions.reduce((max, version) => Math.max(max, version.number), 0) + 1;
}

function checkedText(raw: string): string {
  const text = normalizeLineEndings(raw);
  if (text.length > MAX_SECTION_TEXT_LENGTH) throw new SectionInputError("Refused: the text is too long.");
  return text;
}

/**
 * Her own text (pasted, typed or an edit). `editing` is the version this editing pass
 * made: it is updated in place while it is still the newest version and hers. Otherwise a
 * new version starts: "hers" when the section has none yet, "edited" after. A new version
 * takes the approval away (she approves again). Null when nothing changed.
 */
export function saveOwnText(data: CaseData, id: ReportSectionId, raw: string, editing: number | null, now: string): { data: CaseData; version: number } | null {
  const text = checkedText(raw);
  const section = storedSection(data, id);
  const newest = section.versions.at(-1);
  // Her editing pass updates its own version in place, unless that version is approved:
  // approved text never changes (review, low 1); the edit then becomes a new version.
  if (editing !== null && newest && newest.number === editing && (newest.kind === "hers" || newest.kind === "edited") && !newest.generation && section.approvedVersion !== newest.number) {
    if (newest.text === text) return null;
    const versions = [...section.versions.slice(0, -1), { ...newest, text, updatedAt: now }];
    return { data: withSection(data, id, { ...section, versions, currentVersion: newest.number }), version: newest.number };
  }
  const current = currentOf(section);
  if (current && current.text === text) return null;
  if (!current && text.trim() === "") return null;
  const number = nextNumber(section);
  const version: StoredVersion = {
    number,
    kind: section.versions.length === 0 ? "hers" : "edited",
    createdAt: now,
    updatedAt: now,
    ...(current ? { basedOn: current.number } : {}),
    // Her hand fix of the version she approved stays final for the other sections while she has not approved it again.
    ...(current && section.approvedVersion === current.number ? { fromApproved: true as const } : {}),
    text,
  };
  return { data: withSection(data, id, withoutApproval({ ...section, versions: [...section.versions, version], currentVersion: number })), version: number };
}

function withoutApproval(section: StoredSection): StoredSection {
  const { approvedAt: _was, ...rest } = section;
  void _was;
  return { ...rest, approvedVersion: null };
}

/** A version the AI wrote, added as the current one. The approval is taken away. */
export function addAiVersion(
  data: CaseData,
  id: ReportSectionId,
  input: { kind: Exclude<VersionKind, "hers" | "edited">; text: string; basedOn: number | null; request: string | null; paragraphIndex: number | null; generation: GenerationRecord; now: string },
): { data: CaseData; version: number } {
  const section = storedSection(data, id);
  const number = nextNumber(section);
  const version: StoredVersion = {
    number,
    kind: input.kind,
    createdAt: input.now,
    ...(input.basedOn !== null ? { basedOn: input.basedOn } : {}),
    ...(input.request !== null ? { request: input.request } : {}),
    ...(input.paragraphIndex !== null ? { paragraphIndex: input.paragraphIndex } : {}),
    text: checkedText(input.text),
    generation: input.generation,
  };
  return { data: withSection(data, id, withoutApproval({ ...section, versions: [...section.versions, version], currentVersion: number })), version: number };
}

/** Shows another version. Null when the section has no such version. */
export function setCurrentVersion(data: CaseData, id: ReportSectionId, number: number): CaseData | null {
  const section = storedSection(data, id);
  if (!findVersion(section, number)) return null;
  return withSection(data, id, { ...section, currentVersion: number });
}

/** Approves a version (and shows it), or takes the approval back (null). Null when there is no such version. */
export function approveVersion(data: CaseData, id: ReportSectionId, number: number | null, now: string): CaseData | null {
  const section = storedSection(data, id);
  if (number === null) return withSection(data, id, withoutApproval(section));
  if (!findVersion(section, number)) return null;
  return withSection(data, id, { ...section, approvedVersion: number, approvedAt: now, currentVersion: number });
}

/** The text a request starts from. Null when the version is not there. */
export function versionText(data: CaseData, id: ReportSectionId, number: number): string | null {
  return findVersion(storedSection(data, id), number)?.text ?? null;
}

/** Whether the request names a version the section has. */
export function requestVersionExists(data: CaseData, id: ReportSectionId, request: SectionRequestInput): boolean {
  return request.kind === "draft" || versionText(data, id, request.fromVersion) !== null;
}

/**
 * The text of a section that the other sections may build on: the approved version, or
 * else her own text (owner's decision: unapproved AI drafts are never context; her
 * pasted text stays in force until she approves an AI version).
 */
export function finalVersion(data: CaseData, id: ReportSectionId): StoredVersion | null {
  const section = storedSection(data, id);
  const approved = findVersion(section, section.approvedVersion);
  if (approved) return approved;
  // Her newest text with no AI version in its lineage: what she pasted, and every edit
  // she made of it (review B2), not an AI version she edited; and her edit of a version
  // she had approved, with her edits of that (review round 2, L1).
  const own = ownVersions(section);
  for (let index = section.versions.length - 1; index >= 0; index--) {
    if (own.has(section.versions[index].number)) return section.versions[index];
  }
  return null;
}

/** The numbers of the versions that are final for the other sections: "hers", her edit of the approved version, or her edit of one of those. */
function ownVersions(section: StoredSection): Set<number> {
  const byNumber = new Map(section.versions.map((version) => [version.number, version]));
  const known = new Map<number, boolean>();
  const isOwn = (version: StoredVersion, depth = 0): boolean => {
    const cached = known.get(version.number);
    if (cached !== undefined) return cached;
    let own = false;
    if (version.generation || depth > section.versions.length) own = false;
    else if (version.kind === "hers") own = true;
    else if (version.kind === "edited") {
      const base = version.basedOn === undefined ? undefined : byNumber.get(version.basedOn);
      own = version.fromApproved === true || base === undefined ? true : isOwn(base, depth + 1);
    }
    known.set(version.number, own);
    return own;
  };
  return new Set(section.versions.filter((version) => isOwn(version)).map((version) => version.number));
}

/**
 * Whether she wrote a version by hand: her pasted or typed text ("hers"), or any edit she
 * made by hand ("edited"), her edit of an AI version included. Every fact in it is her
 * decision. Not the same as ownVersions, which decides what the other sections may build
 * on (an edit of an unapproved AI draft is not final for them, review B2).
 */
function isHandWritten(version: StoredVersion): boolean {
  return !version.generation && (version.kind === "hers" || version.kind === "edited");
}

/**
 * Her own text of a section, for the check of a new AI version of it (owner's request,
 * 2026-11-23: "Improve" changed her 3:00-6:00 p.m. to 5:30 unflagged): her latest
 * hand-written or hand-edited version before that version, her edit of an AI version
 * included (review round 1, F1: a fact she fixed by hand is her latest word on it). Null
 * for a version that is not the AI's, or when she wrote nothing by hand before it.
 */
export function ownTextBefore(data: CaseData, id: ReportSectionId, number: number): { version: number; text: string } | null {
  const section = storedSection(data, id);
  const checked = findVersion(section, number);
  if (!checked || !AI_VERSION_KINDS.includes(kindOf(checked))) return null;
  let found: StoredVersion | null = null;
  for (const version of section.versions) {
    if (!isHandWritten(version) || version.number >= number || version.text.trim() === "") continue;
    if (!found || version.number > found.number) found = version;
  }
  return found ? { version: found.number, text: found.text } : null;
}

/**
 * What she asked for between her own text and a version: the requests of the change and
 * paragraph versions on the way from that version back to her text (each version's
 * basedOn), oldest first. A difference she asked for is not a contradiction of her text
 * (review round 1, F1).
 */
export function requestsSince(data: CaseData, id: ReportSectionId, number: number, ownVersion: number): string[] {
  const section = storedSection(data, id);
  const requests: string[] = [];
  let version = findVersion(section, number);
  for (let steps = 0; version && version.number > ownVersion && steps <= section.versions.length; steps++) {
    if (version.generation && version.request?.trim()) requests.unshift(version.request.trim());
    version = version.basedOn === undefined ? undefined : findVersion(section, version.basedOn);
  }
  return requests;
}

/** Her other sections that are hers or approved, in the report's order, for a request about `id`. */
export function contextSections(data: CaseData, id: ReportSectionId): Array<ContextSection & { id: ReportSectionId; version: number }> {
  const out: Array<ContextSection & { id: ReportSectionId; version: number }> = [];
  for (const section of REPORT_SECTIONS) {
    if (section.id === id) continue;
    const version = finalVersion(data, section.id);
    if (version && version.text.trim() !== "") out.push({ id: section.id, title: section.title, text: version.text, version: version.number });
  }
  return out;
}

/** Her notes for the session under way, as typed. */
export function setNotes(data: CaseData, raw: string, now: string): CaseData | null {
  const text = normalizeLineEndings(raw);
  if (text.length > MAX_NOTES_LENGTH) throw new SectionInputError("Refused: the notes are too long.");
  if ((data.sessionNotes?.text ?? "") === text) return null;
  return { ...data, sessionNotes: { ...data.sessionNotes, text, startedAt: data.sessionNotes?.startedAt ?? now, updatedAt: now } };
}

/** "Start a new session": the notes are archived (kept in the file, never sent again) and the box starts empty. */
export function startNewSession(data: CaseData, now: string): CaseData | null {
  const notes = data.sessionNotes;
  if (!notes) return null;
  const next: CaseData = notes.text.trim() === "" ? { ...data } : { ...data, sessionNotesArchive: [...(data.sessionNotesArchive ?? []), { ...notes, endedAt: now }] };
  delete next.sessionNotes;
  return next;
}

/** The notes the AI sees: the session's, or none. */
export function sessionNotes(data: CaseData): string {
  return data.sessionNotes?.text ?? "";
}
