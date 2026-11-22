/*
 * Folding: a lowercase, accent-free copy of a text that still knows where each of its
 * characters came from, so a match found in the copy maps back to the original.
 * "Lucía", "LUCIA" and "lucia" fold to the same "lucia"; typographic apostrophes and
 * dashes fold to "'" and "-"; invisible format characters (a soft hyphen, a zero-width
 * joiner, a word joiner) and stray combining marks fold to nothing.
 */

export interface Folded {
  /** The folded text. */
  text: string;
  /** For each folded character, the index of the original character it came from. */
  from: number[];
  /** For each folded character, the index just after that original character. */
  to: number[];
}

const APOSTROPHES = /[\u{2018}\u{2019}\u{02BC}\u{0060}\u{00B4}]/u;
const DASHES = /[\u{2010}-\u{2015}\u{2212}\u{FE58}\u{FE63}\u{FF0D}]/u;
const SPACES = /[\u{00A0}\u{2000}-\u{200A}\u{202F}\u{205F}\u{3000}]/u;
/** Format characters (soft hyphen, zero-width space and joiners, word joiner, bidi marks...): invisible, so they never split a name. */
const INVISIBLE = /\p{Cf}/u;

/** One character folded: lowercase, accents removed. */
export function foldChar(ch: string): string {
  if (APOSTROPHES.test(ch)) return "'";
  if (DASHES.test(ch)) return "-";
  if (SPACES.test(ch)) return " ";
  if (INVISIBLE.test(ch)) return "";
  return ch.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
}

/** Folds a string with no position map: for comparing values. */
export function foldString(text: string): string {
  let out = "";
  for (const ch of text.normalize("NFC")) out += foldChar(ch);
  return out;
}

/** Folds `original` (which should already be NFC) keeping the position map. */
export function fold(original: string): Folded {
  let text = "";
  const from: number[] = [];
  const to: number[] = [];
  let i = 0;
  for (const ch of original) {
    const folded = foldChar(ch);
    for (let k = 0; k < folded.length; k++) {
      from.push(i);
      to.push(i + ch.length);
    }
    text += folded;
    i += ch.length;
  }
  return { text, from, to };
}

/** The original range of the folded range [start, end). */
export function originalRange(folded: Folded, start: number, end: number): [number, number] {
  return [folded.from[start], folded.to[end - 1]];
}
