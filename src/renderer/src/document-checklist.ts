import type { SourceSummary, SourceType } from "../../shared/sources.ts";

/*
 * "Lo que suele tener una evaluación inicial" (owner's decision T14): the documents an
 * initial assessment usually has, in the order the Documentos step lists them. Display
 * only: built from the source types (SOURCE_TYPES), nothing is stored. Each row adds a
 * pasted text or a PDF of its own type, so the clinician never picks a type from a menu of
 * English names (audit U5). With documents, they are listed in this order, each under its
 * type's place, and the expected types not added yet stay as dashed rows.
 *
 * Plain data and rules, no React, so tests/document-checklist.test.ts can check them.
 */

export interface ChecklistRow {
  type: SourceType;
  /** False for a type that is not part of every assessment: no dashed row for it once the case has documents. */
  expected: boolean;
  /** Where a document usually comes from: "text-or-pdf", "notes" (her own notes) or "pdf" (a score report). */
  form: "text-or-pdf" | "notes" | "pdf";
}

/**
 * The rows, in order. ABLLS-R has a row of its own after BASC-3 (owner's answer on UX-4),
 * optional: a dashed row only in the empty checklist. "Other" is never expected.
 */
export const CHECKLIST: readonly ChecklistRow[] = [
  { type: "cde", expected: true, form: "text-or-pdf" },
  { type: "parent-interview", expected: true, form: "notes" },
  { type: "direct-observation", expected: true, form: "notes" },
  { type: "fba-questionnaire", expected: true, form: "text-or-pdf" },
  { type: "vineland-3", expected: true, form: "pdf" },
  { type: "basc-3", expected: true, form: "pdf" },
  { type: "iep", expected: true, form: "text-or-pdf" },
  { type: "ablls-r", expected: false, form: "pdf" },
  { type: "other", expected: false, form: "text-or-pdf" },
];

/** The checklist row a document is listed under: its own type's, or "other" for a type with no row. */
export function checklistTypeOf(type: SourceType): SourceType {
  return CHECKLIST.some((row) => row.type === type) ? type : "other";
}

export type DocumentListEntry = { kind: "document"; source: SourceSummary } | { kind: "missing"; row: ChecklistRow };

/**
 * The list of a step with documents: each row of the checklist in turn, its documents
 * (oldest first, as added) or, when it has none and is expected, a dashed row.
 */
export function documentList(active: readonly SourceSummary[]): DocumentListEntry[] {
  const entries: DocumentListEntry[] = [];
  for (const row of CHECKLIST) {
    const documents = active.filter((source) => checklistTypeOf(source.type) === row.type);
    if (documents.length > 0) entries.push(...documents.map((source) => ({ kind: "document" as const, source })));
    else if (row.expected) entries.push({ kind: "missing", row });
  }
  return entries;
}

/**
 * The rail's checks (P5's soft hint): the three that let her move on (CDE, parent
 * interview, direct observation), the score reports, and the IEP, which is optional.
 */
export interface StepChecks {
  /** The three core documents that are still missing, in checklist order. */
  coreMissing: SourceType[];
  /** The score reports (Vineland-3, BASC-3) still missing. */
  scoresMissing: SourceType[];
  hasIep: boolean;
}

export const CORE_TYPES: readonly SourceType[] = ["cde", "parent-interview", "direct-observation"];
export const SCORE_TYPES: readonly SourceType[] = ["vineland-3", "basc-3"];

export function stepChecks(active: readonly SourceSummary[]): StepChecks {
  const has = new Set(active.map((source) => source.type));
  return {
    coreMissing: CORE_TYPES.filter((type) => !has.has(type)),
    scoresMissing: SCORE_TYPES.filter((type) => !has.has(type)),
    hasIep: has.has("iep"),
  };
}

/** A PDF in the case's folder, as "Ignorar" knows it: a changed file (other size or date) shows again. */
export function folderFileKey(file: { name: string; bytes: number; modifiedAt: string }): string {
  return `${file.name}\u0000${file.bytes}\u0000${file.modifiedAt}`;
}
