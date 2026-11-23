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
 * Where each paragraph is in the text: its start and end, without the spaces around it.
 * The same paragraphs as splitParagraphs, in the text as it is (line endings made "\n").
 */
export function paragraphSpans(text: string): Array<{ start: number; end: number }> {
  const normalized = normalizeLineEndings(text);
  const spans: Array<{ start: number; end: number }> = [];
  const separator = /\n[ \t]*\n/g;
  let from = 0;
  const push = (start: number, end: number) => {
    while (start < end && /\s/u.test(normalized[start])) start++;
    while (end > start && /\s/u.test(normalized[end - 1])) end--;
    if (end > start) spans.push({ start, end });
  };
  for (let match = separator.exec(normalized); match !== null; match = separator.exec(normalized)) {
    push(from, match.index);
    from = match.index + match[0].length;
    // A run of blank lines: the next search starts on the last line break of this one.
    separator.lastIndex = from - 1;
    from = separator.lastIndex;
  }
  push(from, normalized.length);
  return spans;
}

/**
 * The text with one paragraph replaced by `replacement` (trimmed). Everything else is
 * kept exactly as it was, character for character: the other paragraphs and the spaces
 * and blank lines between them (review M2). Null when there is no paragraph at that
 * index or the replacement is empty.
 */
export function replaceParagraph(text: string, index: number, replacement: string): string | null {
  const normalized = normalizeLineEndings(text);
  const spans = paragraphSpans(normalized);
  if (!Number.isInteger(index) || index < 0 || index >= spans.length) return null;
  const next = joinParagraphs(splitParagraphs(replacement));
  if (next === "") return null;
  const { start, end } = spans[index];
  return normalized.slice(0, start) + next + normalized.slice(end);
}

/**
 * Whether a paragraph change's answer is that paragraph and not more (review M1): at most
 * two paragraphs, none of the section's other paragraphs repeated in it, and not much
 * longer than the paragraph it replaces. A model that returns the whole section anyway
 * would otherwise make a version that repeats the text around it.
 */
export function isParagraphAnswer(currentText: string, index: number, answer: string): boolean {
  const current = splitParagraphs(currentText);
  const marked = current[index];
  const answered = splitParagraphs(answer);
  if (marked === undefined || answered.length === 0 || answered.length > 2) return false;
  const others = current.filter((paragraph, at) => at !== index && paragraph.length >= 40);
  if (others.some((paragraph) => answer.includes(paragraph))) return false;
  const length = answered.join("\n\n").length;
  return length <= Math.max(4 * marked.length, marked.length + 1500);
}

/** Text whose paragraphs are separated by single line breaks, as many text boxes copy it: one paragraph with lines inside. */
export function hasLinesInParagraphs(text: string): boolean {
  return splitParagraphs(text).some((paragraph) => paragraph.includes("\n"));
}

/** Each non-empty line as its own paragraph ("Treat each line as a paragraph", review M3). */
export function linesAsParagraphs(text: string): string {
  return joinParagraphs(
    normalizeLineEndings(text)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== ""),
  );
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

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (char) => (char === "&" ? "&amp;" : char === "<" ? "&lt;" : char === ">" ? "&gt;" : "&quot;"));
}

/**
 * What "Copy for ABA Matrix" puts on the clipboard (owner's decision, 2026-11-22): plain
 * text, its paragraphs separated by one blank line, and the same text as minimal HTML,
 * one <p> per paragraph with no fonts, colors or styles. A rich-text box takes the HTML
 * and keeps clean paragraphs in its own font; a plain box takes the text.
 */
export function abaMatrixClipboard(text: string): { text: string; html: string } {
  const paragraphs = splitParagraphs(text);
  return {
    text: joinParagraphs(paragraphs),
    html: paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`).join(""),
  };
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
