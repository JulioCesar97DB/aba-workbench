/*
 * Positioned text pieces of a PDF page -> readable text in reading order, with each
 * table row on one line and its cells joined by " | ":
 *   Communication | 23 | 62 | 57–67 | 1 | Low
 * A cell that wraps onto two lines ("Adaptive Behavior / Composite") stays in its row,
 * whether the other cells sit on its first line or between its lines. Lines of a
 * paragraph are joined. Independent of the PDF library: it reads only text, position and size.
 *
 * Letter-spaced text ("L u c i a", as PDF.js gives text drawn with character spacing or
 * one glyph at a time) is joined back into words: pieces closer than 1.2 times their own
 * letter advance belong to one word, farther ones are separate words. A page that had
 * letter-spaced or overlapping text is flagged for review (`needsReview`).
 *
 * Limits: one column of text per page is assumed (a two-column page reads across
 * both columns line by line); rotated text is read as if it were not rotated.
 */

export interface TextPiece {
  str: string;
  /** Left edge and baseline, in PDF points (y grows upward). */
  x: number;
  y: number;
  width: number;
  /** Font height. */
  height: number;
}

interface Cell {
  x0: number;
  x1: number;
  y: number;
  text: string;
  /** The last piece was letter-spaced: its letter advance, for the next gap. */
  advance?: number;
}

/** "L u c i a": every other character a space. */
const LETTER_SPACED = /^\S(?: \S){1,}$/u;

interface Line {
  y: number;
  height: number;
  cells: Cell[];
}

/** Two pieces on the same baseline closer than this (times the font height) are one cell. */
const CELL_GAP = 0.6;
/** Lines closer than this (times the font height) interleave: they are one table row. */
const INTERLEAVED = 0.75;
/** A table line and a partial line this close (times the font height) can be one row. */
const CONTINUATION = 1.35;

interface Review {
  spaced: boolean;
  overlapping: boolean;
}

interface Piece extends TextPiece {
  spaced: boolean;
  /** For letter-spaced text: the distance from one letter to the next. */
  advance?: number;
  /** The piece began with a space. */
  leadingSpace: boolean;
}

/** Letter advance of a letter-spaced piece: its width less one glyph (about half the font height), over the gaps between its letters. */
function letterAdvance(width: number, letters: number, height: number): number {
  return letters > 1 ? Math.max(1, (width - 0.5 * height) / (letters - 1)) : Math.max(1, width);
}

function linesOf(pieces: TextPiece[], review: Review): Line[] {
  const visible: Piece[] = pieces
    .map((p) => {
      const raw = p.str.normalize("NFKC");
      const str = raw.trim();
      const spaced = LETTER_SPACED.test(str);
      if (spaced) review.spaced = true;
      const letters = spaced ? str.replace(/ /gu, "") : str;
      const advance = spaced || letters.length === 1 ? letterAdvance(p.width, letters.length, p.height || 10) : undefined;
      return { ...p, str: letters, spaced, advance, leadingSpace: /^\s/u.test(raw) };
    })
    .filter((p) => p.str !== "")
    .sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: Array<{ y: number; height: number; pieces: Piece[] }> = [];
  for (const piece of visible) {
    const line = lines.find((l) => Math.abs(l.y - piece.y) <= Math.max(1, 0.2 * Math.min(l.height, piece.height || l.height)));
    if (line) {
      line.pieces.push(piece);
      line.height = Math.max(line.height, piece.height);
    } else {
      lines.push({ y: piece.y, height: piece.height || 10, pieces: [piece] });
    }
  }
  return lines
    .sort((a, b) => b.y - a.y)
    .map((line) => {
      const sorted = line.pieces.sort((a, b) => a.x - b.x);
      const cells: Cell[] = [];
      for (const piece of sorted) {
        const last = cells.at(-1);
        const gap = last ? piece.x - last.x1 : Infinity;
        if (last && gap < -2) review.overlapping = true;
        // Letter-spaced pieces next to each other: one word when the gap is under 1.2 letter advances, a space up to 3.
        const advance = last?.advance && piece.advance ? Math.max(last.advance, piece.advance) : undefined;
        if (last && advance !== undefined && gap <= 3 * advance) {
          last.text += gap < 1.2 * advance ? piece.str : ` ${piece.str}`;
          last.x1 = Math.max(last.x1, piece.x + piece.width);
          last.advance = piece.advance;
        } else if (last && gap <= CELL_GAP * line.height) {
          const space = (gap > 0.15 * line.height || piece.leadingSpace) && !last.text.endsWith(" ") ? " " : "";
          last.text += space + piece.str;
          last.x1 = Math.max(last.x1, piece.x + piece.width);
          last.advance = piece.spaced ? piece.advance : undefined;
        } else {
          cells.push({ x0: piece.x, x1: piece.x + piece.width, y: line.y, text: piece.str, advance: piece.spaced ? piece.advance : undefined });
        }
      }
      for (const cell of cells) cell.text = cell.text.replace(/\s+/gu, " ").trim();
      return { y: line.y, height: line.height, cells };
    });
}

function overlaps(a: { x0: number; x1: number }, b: { x0: number; x1: number }): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1;
}

/** A row's columns: its cells grouped by horizontal overlap, as left and right edges. */
function columnsOf(row: Line[]): Array<{ x0: number; x1: number }> {
  const columns: Array<{ x0: number; x1: number }> = [];
  for (const cell of row.flatMap((l) => l.cells).sort((a, b) => a.x0 - b.x0)) {
    const column = columns.find((c) => overlaps(c, cell));
    if (column) {
      column.x0 = Math.min(column.x0, cell.x0);
      column.x1 = Math.max(column.x1, cell.x1);
    } else {
      columns.push({ x0: cell.x0, x1: cell.x1 });
    }
  }
  return columns;
}

/** Every cell of `line` sits under exactly one of `columns`, and `line` has fewer cells: a wrapped part of the row. */
function fitsColumns(line: Line, columns: Array<{ x0: number; x1: number }>): boolean {
  if (columns.length < 2 || line.cells.length >= columns.length) return false;
  return line.cells.every((cell) => columns.filter((c) => overlaps(cell, c)).length === 1);
}

/**
 * Groups lines into rows. A table row takes the lines that interleave with it (cells
 * centred between the lines of a wrapped cell) and the wrapped parts of its cells just
 * above and below it, which each sit under one of its columns.
 */
function rowsOf(lines: Line[]): Line[][] {
  const rows: Line[][] = [];
  const close = (upper: Line, lower: Line, factor: number) => upper.y - lower.y < factor * Math.max(upper.height, lower.height);
  /** Moves the wrapped first lines of the last row's cells, left in the rows before it, into it. */
  const absorbAbove = () => {
    const row = rows.at(-1)!;
    while (rows.length >= 2) {
      const before = rows.at(-2)!;
      const candidate = before.at(-1)!;
      if (!before.every((l) => l.cells.length === 1) || !close(candidate, row[0], CONTINUATION) || !fitsColumns(candidate, columnsOf(row))) break;
      row.unshift(before.pop()!);
      if (before.length === 0) rows.splice(rows.length - 2, 1);
    }
  };
  for (const line of lines) {
    const row = rows.at(-1);
    if (row) {
      const previous = row.at(-1)!;
      const columns = columnsOf(row);
      const interleaved = close(previous, line, INTERLEAVED) && (columns.length > 1 || line.cells.length > 1);
      const continuation = close(previous, line, CONTINUATION) && fitsColumns(line, columns);
      if (interleaved || continuation) {
        row.push(line);
        absorbAbove();
        continue;
      }
    }
    rows.push([line]);
    absorbAbove();
  }
  return rows;
}

/** One row's text: its cells grouped into columns by horizontal overlap, top to bottom inside each. */
function rowText(row: Line[]): string {
  const cells = row.flatMap((l) => l.cells).sort((a, b) => a.x0 - b.x0);
  const columns: Cell[][] = [];
  for (const cell of cells) {
    const column = columns.find((col) => col.some((c) => overlaps(c, cell)));
    if (column) column.push(cell);
    else columns.push([cell]);
  }
  return columns
    .sort((a, b) => Math.min(...a.map((c) => c.x0)) - Math.min(...b.map((c) => c.x0)))
    .map((col) => joinWrapped(col.sort((a, b) => b.y - a.y).map((c) => c.text)))
    .join(" | ");
}

/** Lines of one paragraph or one cell, joined; a line ending in a hyphen joins without a space. */
function joinWrapped(parts: string[]): string {
  return parts.reduce((text, part) => (text === "" ? part : text.endsWith("-") ? text + part : `${text} ${part}`), "");
}

/** The text of one page, and whether it needs a look before sending (letter-spaced or overlapping text). */
export function layoutPage(pieces: TextPiece[]): { text: string; needsReview: boolean } {
  const review: Review = { spaced: false, overlapping: false };
  const text = pageTextOf(linesOf(pieces, review));
  const tokens = text.split(/\s+/u).filter((t) => /\p{L}/u.test(t));
  const singles = tokens.filter((t) => /^\p{L}$/u.test(t)).length;
  // A row of five or more one-character cells: a form with one box per character (its values are read whole by the de-identifier).
  const boxed = text.split("\n").some((line) => line.split(" | ").filter((cell) => cell.trim().length === 1).length >= 5);
  return { text, needsReview: review.spaced || review.overlapping || boxed || (tokens.length >= 10 && singles / tokens.length > 0.3) };
}

/** The text of one page. */
export function pageText(pieces: TextPiece[]): string {
  return layoutPage(pieces).text;
}

function pageTextOf(lines: Line[]): string {
  const rows = rowsOf(lines);
  const out: string[] = [];
  let paragraph: string[] = [];
  let last: { y: number; height: number; x0: number } | null = null;
  const flush = () => {
    if (paragraph.length) out.push(joinWrapped(paragraph));
    paragraph = [];
  };
  for (const row of rows) {
    const top = row[0];
    const bottom = row.at(-1)!;
    const x0 = Math.min(...row.flatMap((l) => l.cells.map((c) => c.x0)));
    const single = row.length === 1 && top.cells.length === 1;
    const gap = last ? last.y - top.y : 0;
    // A blank line between blocks: a gap well beyond the usual line spacing.
    if (last && gap > 1.9 * Math.max(last.height, top.height)) {
      flush();
      out.push("");
    }
    if (single && last && paragraph.length && gap <= CONTINUATION * top.height && Math.abs(x0 - last.x0) < 2) {
      paragraph.push(top.cells[0].text);
    } else {
      flush();
      if (single) paragraph.push(top.cells[0].text);
      else out.push(rowText(row));
    }
    last = { y: bottom.y, height: bottom.height, x0 };
  }
  flush();
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Letters and digits on the page: a page with almost none has no text layer (a scan, an image). */
export function readableCharacters(text: string): number {
  return (text.match(/[\p{L}\p{N}]/gu) ?? []).length;
}

/** Share of characters that are unreadable (private-use glyphs, replacement characters): a font without a usable text map. */
export function garbledShare(text: string): number {
  const visible = text.replace(/\s/gu, "");
  if (!visible) return 0;
  return (visible.match(/[\u{E000}-\u{F8FF}\u{FFFD}]/gu) ?? []).length / visible.length;
}
