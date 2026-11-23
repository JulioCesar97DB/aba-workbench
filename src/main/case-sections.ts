import { z } from "zod";
import type { ContextSection } from "../lib/rules.ts";
import { REPORT_SECTIONS, type ReportSectionId } from "../shared/report-sections.ts";
import { MAX_NOTES_LENGTH, MAX_REQUEST_LENGTH, MAX_SECTION_TEXT_LENGTH, normalizeLineEndings, type SectionShape } from "../shared/section-text.ts";
import { sectionState, type ConsistencyResult, type SectionDetail, type SectionRequestInput, type SectionSummary, type SectionVersion, type VersionKind } from "../shared/sections.ts";
import type { CaseData, GenerationRecord, StoredSection, StoredVersion } from "./case-file.ts";

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
  };
}

export function sectionSummaries(data: CaseData): SectionSummary[] {
  return REPORT_SECTIONS.map((section) => sectionSummary(data, section.id));
}

function versionView(version: StoredVersion): SectionVersion {
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
    sourcesUsed: generation?.sourcesUsed.map((source) => source.title) ?? [],
    consistency: version.consistency ? consistencyView(version.consistency) : null,
    text: version.text,
  };
}

function consistencyView(stored: NonNullable<StoredVersion["consistency"]>): ConsistencyResult {
  const status = stored.status === "none" || stored.status === "found" || stored.status === "nothing-to-compare" ? stored.status : "failed";
  return { status, items: stored.items };
}

/** Saves the consistency check's result on a version. Null when the version is gone. */
export function setConsistency(data: CaseData, id: ReportSectionId, number: number, consistency: NonNullable<StoredVersion["consistency"]>): CaseData | null {
  const section = storedSection(data, id);
  const index = section.versions.findIndex((version) => version.number === number);
  if (index === -1) return null;
  const versions = [...section.versions];
  versions[index] = { ...versions[index], consistency };
  return withSection(data, id, { ...section, versions });
}

export function sectionDetail(data: CaseData, id: ReportSectionId, instructions: string, shape: SectionShape = { paragraphs: null, words: null }): SectionDetail {
  return { ...sectionSummary(data, id), versions: storedSection(data, id).versions.map(versionView), instructions, shape };
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
  if (editing !== null && newest && newest.number === editing && (newest.kind === "hers" || newest.kind === "edited") && !newest.generation) {
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
  const current = currentOf(section);
  if (current && stateOf(section) === "hers") return current;
  return [...section.versions].reverse().find((version) => version.kind === "hers") ?? null;
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
