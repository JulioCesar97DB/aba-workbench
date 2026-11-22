/*
 * A section's text as the workspace handles it: paragraphs, the markers the model leaves
 * for missing or conflicting facts, the checks shown beside the text, and the text put on
 * the clipboard for ABA Matrix. Plain functions with no imports, shared by the main
 * process and the interface, so they are unit-tested.
 */

/** The longest section text the app keeps (her pasted text, an AI version, an edit): about 30 pages. */
export const MAX_SECTION_TEXT_LENGTH = 100_000;
/** The longest request in her own words, instruction or note. */
export const MAX_REQUEST_LENGTH = 4_000;
export const MAX_INSTRUCTIONS_LENGTH = 10_000;
export const MAX_NOTES_LENGTH = 10_000;

/** Line endings as "\n", whatever system or app the text came from. */
export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** A section's paragraphs: the text split on blank lines, each trimmed, empty ones dropped. */
export function splitParagraphs(text: string): string[] {
  return normalizeLineEndings(text)
    .split(/\n[ \t]*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== "");
}

/** Paragraphs as the app writes them: one blank line between each, nothing around them. */
export function joinParagraphs(paragraphs: readonly string[]): string {
  return paragraphs.join("\n\n");
}

/** An AI version's text as it is kept: its paragraphs, separated by one blank line. */
export function tidySectionText(text: string): string {
  return joinParagraphs(splitParagraphs(text));
}

/**
 * The text with one paragraph replaced by `replacement` (which may come back as more than
 * one paragraph, or with spaces around it). Every other paragraph is kept exactly.
 * Null when there is no paragraph at that index.
 */
export function replaceParagraph(text: string, index: number, replacement: string): string | null {
  const paragraphs = splitParagraphs(text);
  if (!Number.isInteger(index) || index < 0 || index >= paragraphs.length) return null;
  const next = splitParagraphs(replacement);
  if (next.length === 0) return null;
  return joinParagraphs([...paragraphs.slice(0, index), ...next, ...paragraphs.slice(index + 1)]);
}

export interface SectionMarker {
  kind: "missing" | "check";
  /** What the marker says after "MISSING:" or "CHECK:". */
  note: string;
  /** The paragraph it is in (0-based). */
  paragraph: number;
}

const MARKER = /\[(MISSING|CHECK)\s*:\s*([^\]]*)\]/gu;

/** The [MISSING: ...] and [CHECK: ...] markers in a text, in order. */
export function findMarkers(text: string): SectionMarker[] {
  const markers: SectionMarker[] = [];
  splitParagraphs(text).forEach((paragraph, index) => {
    for (const match of paragraph.matchAll(MARKER)) {
      markers.push({ kind: match[1] === "MISSING" ? "missing" : "check", note: match[2].trim(), paragraph: index });
    }
  });
  return markers;
}

export function countWords(text: string): number {
  return text.split(/\s+/u).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

/** What a section's rules declare about its shape (src/lib/rules.ts, loadSectionShape). */
export interface SectionShape {
  paragraphs: { min: number; max: number } | null;
  words: { min: number; max: number } | null;
}

export type StructureIssue =
  | { kind: "paragraphs"; count: number; min: number; max: number }
  | { kind: "words"; count: number; min: number; max: number }
  /** Headings, lists, bold or tables: ABA Matrix takes plain paragraphs. */
  | { kind: "formatting"; paragraph: number };

/**
 * The structure check beside the text: plain paragraphs only, and as many paragraphs and
 * words as the section's rules ask for, when they say. Counted here, no AI call.
 */
export function checkStructure(text: string, shape: SectionShape): StructureIssue[] {
  const issues: StructureIssue[] = [];
  const paragraphs = splitParagraphs(text);
  if (shape.paragraphs && (paragraphs.length < shape.paragraphs.min || paragraphs.length > shape.paragraphs.max)) {
    issues.push({ kind: "paragraphs", count: paragraphs.length, ...shape.paragraphs });
  }
  const words = countWords(text);
  if (shape.words && (words < shape.words.min || words > shape.words.max)) issues.push({ kind: "words", count: words, ...shape.words });
  paragraphs.forEach((paragraph, index) => {
    const formatted = paragraph
      .split("\n")
      .some((line) => /^\s*(#{1,6}\s|[-*•]\s|\d+[.)]\s|\|)/u.test(line) || /\*\*[^*]+\*\*|__[^_]+__/u.test(line));
    if (formatted) issues.push({ kind: "formatting", paragraph: index });
  });
  return issues;
}
