/*
 * Sheet values found as a sequence of meaningful characters, whatever stands between them:
 * spaces, table bars, dashes, dots, slashes, line breaks (zero-width and bidi marks are
 * already gone from the folded text). "0 | 3 | 1 | 4 | 2 | 0 | 2 | 0" from a PDF form with one
 * box per digit, "305 | 555 | 0142", "F L 1 2 3 4 5 6 7 8 9", "M i a m i" all read as the
 * sheet's own value. Each match maps back to its exact original span.
 *
 * Phone digits written as words ("three oh five, five five five, oh one four two", "tres
 * cero cinco...") are read the same way.
 */
import type { Folded } from "./fold.ts";

export interface SequenceValue {
  /** Folded letters and digits, nothing else: "03142020", "3055550142", "fl123456789", "miami". */
  chars: string;
  /** Fewest separators that must stand between its characters (0: also written whole). */
  minGaps: number;
  /** Every separator between its characters must be the same ("3 3 1 3 5", not "33 1 35"): for short values. */
  uniform: boolean;
  /** What it is, for the caller. */
  tag: string;
}

export interface SequenceMatch {
  tag: string;
  /** Folded positions. */
  start: number;
  end: number;
}

/** What may stand between two characters of a value: separators only (never a comma or a semicolon, which end a value), at most 6 of them, at most 2 line breaks. */
const LIGHT = /^[\s|\-./:()#_*\u{2022}\u{00B7}[\]'"\p{Cf}]{0,6}$/u;
const MEANINGFUL = /[\p{L}\p{N}]/u;

interface Skeleton {
  chars: string;
  /** Folded position of each kept character. */
  pos: number[];
  /** What stands before each kept character since the previous one. */
  gap: string[];
}

/** The folded text's letters and digits, each with what stood before it in the original text (invisible characters included). */
function skeleton(folded: Folded, original: string): Skeleton {
  const text = folded.text;
  let chars = "";
  const pos: number[] = [];
  const gap: string[] = [];
  let lastEnd = -1;
  for (let i = 0; i < text.length; i++) {
    if (!MEANINGFUL.test(text[i])) continue;
    const from = folded.from[i];
    // What stands between the previous kept character and this one, in the original: a long stretch is never a light gap.
    const between = lastEnd === -1 || from <= lastEnd ? "" : original.slice(lastEnd, Math.min(from, lastEnd + 9));
    chars += text[i];
    pos.push(i);
    gap.push(between);
    lastEnd = folded.to[i];
  }
  return { chars, pos, gap };
}

const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";

export function findSequences(folded: Folded, original: string, values: SequenceValue[]): SequenceMatch[] {
  const sk = skeleton(folded, original);
  const out: SequenceMatch[] = [];
  for (const value of values) {
    const v = value.chars;
    if (v.length < 3) continue;
    for (let idx = sk.chars.indexOf(v); idx !== -1; idx = sk.chars.indexOf(v, idx + 1)) {
      const last = idx + v.length - 1;
      // The characters before and after: apart from it, or of the other kind (a letter next to a digit).
      const before = sk.chars[idx - 1];
      const after = sk.chars[last + 1];
      const apartBefore = idx === 0 || sk.gap[idx] !== "" || isDigit(before) !== isDigit(v[0]);
      const apartAfter = last + 1 >= sk.chars.length || sk.gap[last + 1] !== "" || isDigit(after) !== isDigit(v[v.length - 1]);
      if (!apartBefore || !apartAfter) continue;
      const inner = sk.gap.slice(idx + 1, last + 1);
      if (!inner.every((g) => LIGHT.test(g) && (g.match(/\n/gu)?.length ?? 0) <= 2)) continue;
      const gaps = inner.filter((g) => g !== "");
      if (gaps.length < value.minGaps) continue;
      if (value.uniform && inner.some((g) => g !== inner[0])) continue;
      out.push({ tag: value.tag, start: sk.pos[idx], end: sk.pos[last] + 1 });
    }
  }
  out.push(...findWordDigits(folded, values));
  return out;
}

const DIGIT_WORDS: Record<string, string> = {
  zero: "0", oh: "0", cero: "0", one: "1", uno: "1", two: "2", dos: "2", three: "3", tres: "3", four: "4", cuatro: "4", five: "5", cinco: "5",
  six: "6", seis: "6", seven: "7", siete: "7", eight: "8", ocho: "8", nine: "9", nueve: "9",
};

/** Runs of digits and digit words ("three oh five, 555-oh one four two"): the sheet's numbers read in them. */
function findWordDigits(folded: Folded, values: SequenceValue[]): SequenceMatch[] {
  const numbers = values.filter((v) => /^\d{7,}$/u.test(v.chars));
  if (numbers.length === 0) return [];
  const out: SequenceMatch[] = [];
  let run: Array<{ digits: string; start: number; end: number; word: boolean }> = [];
  const flush = () => {
    if (run.some((r) => r.word)) {
      let digits = "";
      const owner: number[] = [];
      run.forEach((r, k) => {
        digits += r.digits;
        for (let i = 0; i < r.digits.length; i++) owner.push(k);
      });
      for (const value of numbers) {
        for (let idx = digits.indexOf(value.chars); idx !== -1; idx = digits.indexOf(value.chars, idx + 1)) {
          out.push({ tag: value.tag, start: run[owner[idx]].start, end: run[owner[idx + value.chars.length - 1]].end });
        }
      }
    }
    run = [];
  };
  let lastEnd = -1;
  for (const m of folded.text.matchAll(/\d+|\p{L}+/gu)) {
    const digits = /^\d+$/u.test(m[0]) ? m[0] : DIGIT_WORDS[m[0]];
    const between = lastEnd === -1 ? "" : folded.text.slice(lastEnd, m.index);
    if (digits === undefined || (run.length && !/^[\s,.\-/()]{1,4}$/u.test(between))) flush();
    if (digits !== undefined) run.push({ digits, start: m.index, end: m.index + m[0].length, word: !/^\d+$/u.test(m[0]) });
    lastEnd = m.index + m[0].length;
  }
  flush();
  return out;
}
