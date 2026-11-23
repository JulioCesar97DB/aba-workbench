/*
 * Folding: a lowercase, accent-free, compatibility-normalized copy of a text that still
 * knows where each of its characters came from, so a match found in the copy maps back
 * to the exact original span. "Lucía", "LUCIA", "lucia", "Ｌｕｃｉａ" (fullwidth) and "Soﬁa"
 * (with the "ﬁ" ligature) fold to plain lowercase letters; typographic apostrophes and
 * dashes fold to "'" and "-"; invisible format characters (a soft hyphen, a zero-width
 * joiner, a word joiner) and stray combining marks fold to nothing; an HTML character
 * reference pasted with a text ("Luc&iacute;a", "&#237;") and a percent-encoded URL
 * character ("Mat%C3%A9o") fold to their letter; a Cyrillic or Greek letter that looks
 * Latin ("Valeriа" with a Cyrillic а) folds to the Latin one; a decimal digit of another script
 * ("٣") folds to its ASCII digit.
 */

export interface Folded {
  /** The folded text. */
  text: string;
  /** For each folded character, the index of the original character it came from. */
  from: number[];
  /** For each folded character, the index just after that original character. */
  to: number[];
}

const APOSTROPHES = /[\u{2018}\u{2019}\u{02BC}\u{0060}\u{00B4}\u{FF07}]/u;
const DASHES = /[\u{2010}-\u{2015}\u{2212}\u{FE58}\u{FE63}\u{FF0D}]/u;
const SPACES = /[\u{00A0}\u{2000}-\u{200A}\u{202F}\u{205F}\u{3000}]/u;
/** Format characters (soft hyphen, zero-width space and joiners, word joiner, bidi marks...): invisible, so they never split a name. */
const INVISIBLE = /\p{Cf}/u;

/** The named character references a clinician's pasted text can carry. */
const ENTITIES: Record<string, string> = {
  amp: "&", nbsp: " ", quot: '"', apos: "'", lt: "<", gt: ">",
  aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú", ntilde: "ñ", uuml: "ü",
  Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó", Uacute: "Ú", Ntilde: "Ñ", Uuml: "Ü",
  agrave: "à", egrave: "è", ccedil: "ç", ordf: "ª", ordm: "º", rsquo: "'", lsquo: "'", ndash: "-", mdash: "-", shy: "",
};
const ENTITY = /^&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z]{2,8}));/u;
/** One or more percent-encoded bytes: "%C3%A9". */
const PERCENT = /^(?:%[0-9A-Fa-f]{2})+/u;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

/** Cyrillic and Greek letters drawn like Latin ones, folded to the Latin letter (lowercase). */
const HOMOGLYPHS: Record<string, string> = {
  "\u{0430}": "a", "\u{0435}": "e", "\u{043E}": "o", "\u{0440}": "p", "\u{0441}": "c", "\u{0443}": "y", "\u{0445}": "x",
  "\u{0456}": "i", "\u{0458}": "j", "\u{0455}": "s", "\u{04CF}": "l", "\u{0501}": "d", "\u{051B}": "q", "\u{051D}": "w",
  // Lowercase forms of Cyrillic capitals drawn like Latin ones: М, Н, Т, К, В.
  "\u{043C}": "m", "\u{043D}": "h", "\u{0442}": "t", "\u{043A}": "k", "\u{0432}": "b",
  // Greek, by the Latin letter the capital looks like: Ο, Α, Ε, Ι, Κ, Ν, Ρ, Τ, Υ, Χ, Β, Ζ, Η, Μ.
  "\u{03BF}": "o", "\u{03B1}": "a", "\u{03B5}": "e", "\u{03B9}": "i", "\u{03BA}": "k", "\u{03BD}": "n", "\u{03C1}": "p", "\u{03C4}": "t", "\u{03C5}": "y", "\u{03C7}": "x",
  "\u{03B2}": "b", "\u{03B6}": "z", "\u{03B7}": "h", "\u{03BC}": "m",
};

/** Folded forms of the characters met so far: most texts use a few hundred distinct ones. */
const FOLDED = new Map<string, string>();

/** One character folded: compatibility form, lowercase, accents removed. */
export function foldChar(ch: string): string {
  const code = ch.charCodeAt(0);
  // Plain ASCII: only capitals change (and the backtick, an apostrophe).
  if (ch.length === 1 && code < 128) return code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : code === 96 ? "'" : ch;
  const known = FOLDED.get(ch);
  if (known !== undefined) return known;
  const folded = foldUncached(ch);
  if (FOLDED.size < 50_000) FOLDED.set(ch, folded);
  return folded;
}

/** The zero of each Unicode block of decimal digits NFKC leaves alone (Arabic-Indic, Devanagari, Bengali, Thai...). */
const DIGIT_ZEROS = [0x0660, 0x06f0, 0x07c0, 0x0966, 0x09e6, 0x0a66, 0x0ae6, 0x0b66, 0x0be6, 0x0c66, 0x0ce6, 0x0d66, 0x0de6, 0x0e50, 0x0ed0, 0x0f20, 0x1040, 0x17e0, 0x1810];

function foldUncached(ch: string): string {
  // A decimal digit of another script reads as its ASCII digit: "٠٣/١٤/٢٠٢٠".
  const code = ch.codePointAt(0)!;
  for (const zero of DIGIT_ZEROS) if (code >= zero && code <= zero + 9) return String(code - zero);
  if (APOSTROPHES.test(ch)) return "'";
  if (DASHES.test(ch)) return "-";
  if (SPACES.test(ch)) return " ";
  if (INVISIBLE.test(ch)) return "";
  const compatible = ch.normalize("NFKC");
  let out = "";
  for (const c of compatible) {
    if (APOSTROPHES.test(c)) out += "'";
    else if (DASHES.test(c)) out += "-";
    else if (SPACES.test(c)) out += " ";
    else {
      const lower = c.toLowerCase();
      out += HOMOGLYPHS[lower] ?? lower.normalize("NFD").replace(/\p{M}/gu, "").replace(/\u{00DF}/gu, "ss");
    }
  }
  return out;
}

/** The text a run of percent-encoded bytes at `text[i]` stands for (valid UTF-8 only), and its length. */
function percentAt(text: string, i: number): { value: string; length: number } | null {
  const m = PERCENT.exec(text.slice(i, i + 48));
  if (!m) return null;
  const bytes = new Uint8Array(m[0].length / 3);
  for (let k = 0; k < bytes.length; k++) bytes[k] = parseInt(m[0].slice(k * 3 + 1, k * 3 + 3), 16);
  try {
    return { value: UTF8.decode(bytes), length: m[0].length };
  } catch {
    return null;
  }
}

/** The character an HTML reference at `text[i]` stands for, and its length. */
function entityAt(text: string, i: number): { value: string; length: number } | null {
  const m = ENTITY.exec(text.slice(i, i + 12));
  if (!m) return null;
  if (m[3] !== undefined) return m[3] in ENTITIES ? { value: ENTITIES[m[3]], length: m[0].length } : null;
  const code = m[1] !== undefined ? Number(m[1]) : parseInt(m[2], 16);
  if (!Number.isFinite(code) || code < 32 || code > 0x10ffff) return null;
  return { value: String.fromCodePoint(code), length: m[0].length };
}

/** Folds a string with no position map: for comparing values. */
export function foldString(text: string): string {
  return fold(text.normalize("NFC")).text;
}

/** Folds `original` (which should already be NFC) keeping the position map. */
export function fold(original: string): Folded {
  let text = "";
  const from: number[] = [];
  const to: number[] = [];
  let i = 0;
  while (i < original.length) {
    let length: number;
    let folded: string;
    const entity = original[i] === "&" ? entityAt(original, i) : original[i] === "%" ? percentAt(original, i) : null;
    if (entity) {
      length = entity.length;
      folded = [...entity.value].map(foldChar).join("");
    } else {
      const ch = String.fromCodePoint(original.codePointAt(i)!);
      length = ch.length;
      folded = foldChar(ch);
    }
    for (let k = 0; k < folded.length; k++) {
      from.push(i);
      to.push(i + length);
    }
    text += folded;
    i += length;
  }
  return { text, from, to };
}

/** The original range of the folded range [start, end). */
export function originalRange(folded: Folded, start: number, end: number): [number, number] {
  return [folded.from[start], folded.to[end - 1]];
}
