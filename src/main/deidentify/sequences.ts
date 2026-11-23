/*
 * Sheet values found as a sequence of meaningful characters, whatever stands between them.
 * Every character that is not a letter or a digit is a separator: spaces, table bars, dashes,
 * dots, slashes, backslashes, colons, plus signs, line breaks, invisible marks. "0 | 3 | 1 | 4 |
 * 2 | 0 | 2 | 0" from a PDF form with one box per digit, "305\\555\\0142", "FL 123,456,789",
 * "M i a m i" all read as the sheet's own value. Each match maps back to its exact original span.
 *
 * What may not stand inside one value:
 * - more than 8 separator characters in a row, or more than 2 line breaks, except a PDF page
 *   marker ("--- Page 2 of 3 ---"), which is skipped as if it were not there;
 * - for a date of birth, a sentence end, a comma or a semicolon between two pieces of two or
 *   more characters ("3 14 2020. 03 14 20", "2020; 03 14"), unless every separator is the same
 *   ("03,14,2020") or the comma comes before the year ("03 14, 2020").
 *
 * Sheet numbers are also read with OCR's usual misreadings of digits: O, o, D, Q for 0; I, l,
 * i, ! for 1; Z for 2; S for 5; B for 8 ("O3/I4/2O2O", "3O5-555-O142"), when at least half of
 * the value is real digits and it does not stand inside a word. Phone and ID digits written as words ("three oh five, five five five…") are
 * read too.
 */
import type { Folded } from "./fold.ts";

export interface SequenceValue {
  /** Folded letters and digits, nothing else: "03142020", "3055550142", "fl123456789", "miami". */
  chars: string;
  /** Fewest separators that must stand between its characters (0: also written whole). */
  minGaps: number;
  /** Every separator between its characters must be the same ("3 3 1 3 5", not "33 1 35"). */
  uniform: boolean;
  /** What it is, for the caller. */
  tag: string;
  /** Short enough to occur by chance in a score table: the caller checks its context. */
  short?: boolean;
  /** Its letters must be capitals in the text (a school's initials: "S.J.B."). */
  capitals?: boolean;
  /** A sentence end between two pieces of two or more characters ends it ("born 3 14 2020. 03 14 20" is two dates). */
  sentences?: boolean;
}

export interface SequenceMatch {
  tag: string;
  /** Folded positions. */
  start: number;
  end: number;
  short: boolean;
  /** The separators between its characters, as written. */
  gaps: string[];
  /** Written whole (no separator at all). */
  whole: boolean;
  /** One date separator throughout ("03/14/20", "3 - 14 - 20"). */
  dateLike: boolean;
  /** How many characters each piece between separators has ("03 14 2020": 2, 2, 4). */
  pieces: number[];
}

const MEANINGFUL = /[\p{L}\p{N}]/u;
const PAGE_MARKER = /\n[ \t]*-{3}[ \t]*page[ \t]+\d+[ \t]+of[ \t]+\d+[ \t]*-{3}[ \t]*\n/gu;
const DATE_SEPARATOR = /^[ \t]*[/.\-\u{2013}\u{2014}\\][ \t]*$/u;
const OCR_DIGITS: Record<string, string> = { o: "0", d: "0", q: "0", i: "1", l: "1", "!": "1", z: "2", s: "5", b: "8", "\u{0437}": "3" };

interface Skeleton {
  chars: string;
  /** Folded position of each kept character. */
  pos: number[];
  /** What stands before each kept character since the previous one, in the original. */
  gap: string[];
  /** The gap held a PDF page marker. */
  marker: boolean[];
  /** The kept character is a real digit (not an OCR stand-in). */
  real: boolean[];
}

/** Folded positions inside PDF page markers: skipped, as if the page break were a line break. */
function markerMask(text: string): Uint8Array {
  const mask = new Uint8Array(text.length);
  for (const m of text.matchAll(PAGE_MARKER)) mask.fill(1, m.index + 1, m.index + m[0].length - 1);
  return mask;
}

/** The letters and digits (or, with `ocr`, the digits and their OCR stand-ins), each with what stood before it. */
function skeleton(folded: Folded, original: string, mask: Uint8Array, ocr: boolean): Skeleton {
  const text = folded.text;
  const sk: Skeleton = { chars: "", pos: [], gap: [], marker: [], real: [] };
  let lastEnd = -1;
  let sawMarker = false;
  for (let i = 0; i < text.length; i++) {
    if (mask[i]) {
      sawMarker = true;
      continue;
    }
    const ch = text[i];
    const isDigitChar = ch >= "0" && ch <= "9";
    const kept = ocr ? (isDigitChar ? ch : OCR_DIGITS[ch]) : MEANINGFUL.test(ch) ? ch : undefined;
    if (kept === undefined) continue;
    const from = folded.from[i];
    const between = lastEnd === -1 || from <= lastEnd ? "" : original.slice(lastEnd, Math.min(from, lastEnd + 40));
    sk.chars += kept;
    sk.pos.push(i);
    sk.gap.push(between);
    sk.marker.push(sawMarker);
    sk.real.push(isDigitChar || !ocr);
    sawMarker = false;
    lastEnd = folded.to[i];
  }
  return sk;
}

const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";

/** Whether the separators between a value's characters are ones a value can have (see the header). */
function gapsAllowed(inner: string[], markers: boolean[]): boolean {
  for (let k = 0; k < inner.length; k++) {
    const g = inner[k];
    if (markers[k]) {
      // Around a page marker: line breaks and spaces, and the separator the value had there.
      if (g.replace(/-{3}[ \t]*page[ \t]+\d+[ \t]+of[ \t]+\d+[ \t]*-{3}/giu, "").replace(/\s/gu, "").length > 2) return false;
      continue;
    }
    if (g.length > 8 || (g.match(/\n/gu)?.length ?? 0) > 2) return false;
  }
  return true;
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

/** The same separator between every pair of characters that are apart ("03,14,2020", "98,765,432,10"). */
function uniformApart(inner: string[]): boolean {
  const apart = inner.filter((g) => g !== "");
  return apart.every((g) => g === apart[0]);
}

function search(sk: Skeleton, value: SequenceValue, original: string, folded: Folded, out: SequenceMatch[], ocr: boolean): void {
  const v = value.chars;
  for (let idx = sk.chars.indexOf(v); idx !== -1; idx = sk.chars.indexOf(v, idx + 1)) {
    const last = idx + v.length - 1;
    if (ocr) {
      // Read with OCR stand-ins: nothing but separators between its characters, and not inside a word ("solo" is no "5010").
      if (sk.gap.slice(idx + 1, last + 1).some((g) => WORD_CHAR.test(g))) continue;
      const from = folded.from[sk.pos[idx]];
      const to = folded.to[sk.pos[last]];
      if (WORD_CHAR.test(original[from - 1] ?? "") || WORD_CHAR.test(original[to] ?? "")) continue;
    }
    const before = sk.chars[idx - 1];
    const after = sk.chars[last + 1];
    const apartBefore = idx === 0 || sk.gap[idx] !== "" || sk.marker[idx] || isDigit(before) !== isDigit(v[0]);
    const apartAfter = last + 1 >= sk.chars.length || sk.gap[last + 1] !== "" || sk.marker[last + 1] || isDigit(after) !== isDigit(v[v.length - 1]);
    if (!apartBefore || !apartAfter) continue;
    const inner = sk.gap.slice(idx + 1, last + 1);
    const markers = sk.marker.slice(idx + 1, last + 1);
    if (!gapsAllowed(inner, markers)) continue;
    const gaps = inner.filter((g, k) => g !== "" || markers[k]);
    if (gaps.length < value.minGaps) continue;
    if (value.uniform && inner.some((g) => g !== inner[0])) continue;
    // OCR stand-ins: at least half of the value must be real digits.
    const real = sk.real.slice(idx, last + 1).filter(Boolean).length;
    if (real < Math.max(3, Math.ceil(v.length / 2))) continue;
    if (value.capitals && !sk.pos.slice(idx, last + 1).every((p) => /\p{Lu}/u.test(original[folded.from[p]] ?? ""))) continue;
    const dateLike = inner.length > 0 && inner.every((g) => g === inner[0]) && DATE_SEPARATOR.test(inner[0]);
    const pieces = [1];
    const sentenceEnds: number[] = [];
    const commas: number[] = [];
    for (const g of inner) {
      if (g === "") pieces[pieces.length - 1]++;
      else {
        if (/[.!?][ \t]*(?:\n|[ \t])/u.test(g)) sentenceEnds.push(pieces.length);
        if (/[,;]/u.test(g)) commas.push(pieces.length);
        pieces.push(1);
      }
    }
    if (value.sentences && !uniformApart(inner)) {
      // Between two dates, not inside one: "2020. 03 14", "2020; 03 14". A comma before the year stays inside ("03 14, 2020").
      const between = (k: number) => pieces[k - 1] >= 2 && pieces[k] >= 2;
      if (sentenceEnds.some(between) || commas.some((k) => between(k) && k !== pieces.length - 1)) continue;
    }
    out.push({ tag: value.tag, start: sk.pos[idx], end: sk.pos[last] + 1, short: value.short ?? false, gaps: inner, whole: inner.every((g) => g === ""), dateLike, pieces });
  }
}

export function findSequences(folded: Folded, original: string, values: SequenceValue[]): SequenceMatch[] {
  const mask = markerMask(folded.text);
  const out: SequenceMatch[] = [];
  const plain = skeleton(folded, original, mask, false);
  for (const value of values) if (value.chars.length >= 3) search(plain, value, original, folded, out, false);
  // The same numbers, read with OCR's misreadings of digits.
  const numbers = values.filter((v) => /^\d{3,}$/u.test(v.chars));
  if (numbers.length) {
    const ocr = skeleton(folded, original, mask, true);
    for (const value of numbers) search(ocr, value, original, folded, out, true);
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
          out.push({ tag: value.tag, start: run[owner[idx]].start, end: run[owner[idx + value.chars.length - 1]].end, short: false, gaps: [], whole: false, dateLike: false, pieces: [] });
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
