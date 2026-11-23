import { z } from "zod";
import { isCaseId, type CaseFile } from "../shared/api.ts";
import {
  checkSourceTitle,
  isSourceDate,
  isSourceType,
  MAX_PDF_BYTES,
  MAX_SOURCE_TEXT_LENGTH,
  MAX_SOURCES,
  normalizeSourceText,
  SOURCE_TYPES,
  type CaseSources,
  type SourceChange,
  type SourceSummary,
  type SourceType,
} from "../shared/sources.ts";
import { LARGEST_PDF_FOR, pdfSizeWarning } from "../lib/limits.ts";
import type { CaseData, StoredPdfSource, StoredSource } from "./case-file.ts";

/*
 * A case's sources, inside its data file (src/main/case-file.ts, version 2): what the
 * interface may send, and the changes made to the data. Pure functions on CaseData:
 * nothing here touches the disk (src/main/cases.ts reads and saves; src/main/case-pdfs.ts
 * copies PDFs), so it is unit-tested.
 *
 * Nothing is ever deleted (owner's decision, 2026-11-22): removing a source marks it
 * removedAt, keeping its text and its PDF; restoring clears the mark.
 */

/* What the interface may send. Strings are capped before anything else looks at them. */

const TypeSchema = z.enum(SOURCE_TYPES);
const TitleInputSchema = z.string().max(1000).nullable();
const DateInputSchema = z.string().max(20).refine(isSourceDate).nullable();
// A few characters over the cap: a text one line ending longer is still refused by its own check.
const TextInputSchema = z.string().max(MAX_SOURCE_TEXT_LENGTH * 2);

export const NewTextSourceSchema = z.strictObject({
  type: TypeSchema,
  title: TitleInputSchema.optional(),
  date: DateInputSchema.optional(),
  text: TextInputSchema,
});

export const SourceChangeSchema = z
  .strictObject({
    type: TypeSchema.optional(),
    title: TitleInputSchema.optional(),
    date: DateInputSchema.optional(),
    text: TextInputSchema.optional(),
  })
  .refine((change) => Object.keys(change).length > 0);

export const SourceIdSchema = z.string().max(64).refine(isCaseId);

/** A PDF dropped onto the window: a plain name (no path) and at most MAX_PDF_BYTES bytes. */
export const DroppedPdfSchema = z.strictObject({
  name: z.string().min(1).max(255),
  data: z.instanceof(Uint8Array).refine((data) => data.byteLength <= MAX_PDF_BYTES),
});

export const FolderPdfNameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((name) => name !== "." && name !== ".." && !/[/\\\p{Cc}]/u.test(name));

/** Why a change cannot be made, before anything is saved. */
export class SourceInputError extends Error {}

function checkedTitle(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const checked = checkSourceTitle(raw);
  if (!checked.ok) throw new SourceInputError(`Refused: the title is ${checked.problem}.`);
  return checked.title;
}

function checkedText(raw: string): string {
  const text = normalizeSourceText(raw);
  if (text.length > MAX_SOURCE_TEXT_LENGTH) throw new SourceInputError("Refused: the text is too long.");
  return text;
}

/** Title and date are left out of the file when not given. */
function withOptional<T extends object>(entry: T, title: string | null, date: string | null): T & { title?: string; date?: string } {
  const out: T & { title?: string; date?: string } = { ...entry };
  delete out.title;
  delete out.date;
  if (title !== null) out.title = title;
  if (date !== null) out.date = date;
  return out;
}

function assertRoom(data: CaseData, count: number): void {
  if (data.sources.length + count > MAX_SOURCES) throw new SourceInputError(`Refused: a case holds at most ${MAX_SOURCES} sources.`);
}

export function addTextSource(data: CaseData, input: z.infer<typeof NewTextSourceSchema>, options: { id: string; now: string }): CaseData {
  assertRoom(data, 1);
  const entry = withOptional(
    { id: options.id, kind: "text" as const, type: input.type, addedAt: options.now, updatedAt: options.now, text: checkedText(input.text) },
    checkedTitle(input.title),
    input.date ?? null,
  );
  return { ...data, sources: [...data.sources, entry] };
}

export function addPdfSource(data: CaseData, input: { id: string; file: string; bytes: number; type: SourceType; now: string }): CaseData {
  assertRoom(data, 1);
  const entry: StoredPdfSource = { id: input.id, kind: "pdf", type: input.type, addedAt: input.now, updatedAt: input.now, file: input.file, bytes: input.bytes };
  return { ...data, sources: [...data.sources, entry] };
}

/** The data with one source changed, or null when no source has that id. Keys a later version added to it are kept. */
export function changeSource(data: CaseData, id: string, change: SourceChange, now: string): CaseData | null {
  const index = data.sources.findIndex((source) => source.id === id);
  if (index === -1) return null;
  const current = data.sources[index];
  if (change.text !== undefined && current.kind !== "text") throw new SourceInputError("Refused: only a pasted text has text.");
  const title = change.title === undefined ? (current.title ?? null) : checkedTitle(change.title);
  const date = change.date === undefined ? (current.date ?? null) : change.date;
  let next: StoredSource = withOptional({ ...current, updatedAt: now }, title, date);
  if (change.type !== undefined) next = { ...next, type: change.type };
  if (change.text !== undefined && next.kind === "text") next = { ...next, text: checkedText(change.text) };
  const sources = [...data.sources];
  sources[index] = next;
  return { ...data, sources };
}

/** Marks a source removed (or no longer removed). Null when no source has that id. */
export function setRemoved(data: CaseData, id: string, removed: boolean, now: string): CaseData | null {
  const index = data.sources.findIndex((source) => source.id === id);
  if (index === -1) return null;
  const sources = [...data.sources];
  const { removedAt: _was, ...rest } = sources[index];
  void _was;
  sources[index] = removed ? { ...rest, removedAt: now, updatedAt: now } : { ...rest, updatedAt: now };
  return { ...data, sources };
}

/**
 * A text with the marks of Markdown taken out, for showing only (owner's decision T15): a
 * text pasted from ChatGPT or a notes app often has them. Heading marks ("## "), quote marks
 * ("> "), bullets ("- ", "* ", "+ "), rules ("---"), a table's lines (its "| --- |" row goes,
 * its cells are joined with " · "), bold and italic stars or underscores
 * around words, and backticks. Numbered lists stay (their numbers say something). The saved
 * text is never changed.
 */
export function withoutMarkdownMarks(text: string): string {
  return text
    .replace(/^[ \t]*\|?(?:[ \t]*:?-{3,}:?[ \t]*\|)+[ \t]*:?-{0,}:?[ \t]*$/gmu, "")
    .replace(/^[ \t]*\|(.*)\|[ \t]*$/gmu, (_row, cells: string) => cells.split("|").map((cell) => cell.trim()).join(" · "))
    .replace(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gmu, "")
    .replace(/^[ \t]{0,3}#{1,6}(?:[ \t]+|$)/gmu, "")
    .replace(/^[ \t]*>[ \t]?/gmu, "")
    .replace(/^[ \t]*[-*+][ \t]+/gmu, "")
    .replace(/(^|[^\p{L}\p{N}*_])(\*\*|__)(?=\S)([^\n]*?\S)\2(?![\p{L}\p{N}])/gmu, "$1$3")
    .replace(/(^|[^\p{L}\p{N}*_])([*_])(?=\S)([^*_\n]*?\S)\2(?![\p{L}\p{N}])/gmu, "$1$3")
    .replace(/`([^`\n]+)`/gu, "$1");
}

/** One line of a text's first words, without Markdown's marks: what the list shows to recognize it. */
export function textPreview(text: string, length = 160): string {
  const line = withoutMarkdownMarks(text.slice(0, length * 4)).replace(/\s+/gu, " ").trim();
  if (line.length <= length) return line;
  // Cut between whole characters (a surrogate pair is never split).
  return `${[...line.slice(0, length + 1)].slice(0, -1).join("").trimEnd()}…`;
}

/** The sources as the interface sees them, with the PDFs found in the folder. */
export function caseSources(data: CaseData, folderFiles: readonly CaseFile[]): CaseSources {
  const present = new Set(folderFiles.map((file) => file.name));
  const sources = data.sources.map((source): SourceSummary => {
    const base = {
      id: source.id,
      type: isSourceType(source.type) ? source.type : "other",
      title: source.title ?? null,
      date: source.date ?? null,
      addedAt: source.addedAt,
      updatedAt: source.updatedAt,
      removedAt: source.removedAt ?? null,
    } as const;
    if (source.kind === "text") return { ...base, kind: "text", characters: source.text.length, preview: textPreview(source.text) };
    return { ...base, kind: "pdf", fileName: source.file, bytes: source.bytes, present: present.has(source.file), sizeWarning: pdfSizeWarning(source.bytes) };
  });
  const totalPdfBytes = data.sources.reduce((sum, source) => (source.kind === "pdf" && !source.removedAt ? sum + source.bytes : sum), 0);
  return {
    sources,
    files: folderFiles.map(({ name, bytes, modifiedAt }) => ({ name, bytes, modifiedAt })),
    totalPdfWarning: pdfSizeWarning(totalPdfBytes),
    pdfLimits: { chatgpt: LARGEST_PDF_FOR.openai, claude: LARGEST_PDF_FOR.anthropic },
    updatedAt: data.updatedAt,
  };
}

/** A pasted text's whole text, or null when no pasted text has that id. */
export function sourceText(data: CaseData, id: string): string | null {
  const source = data.sources.find((entry) => entry.id === id);
  return source?.kind === "text" ? source.text : null;
}
