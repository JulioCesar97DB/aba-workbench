/*
 * Folding: a lowercase, accent-free, compatibility-normalized copy of a text that still
 * knows where each of its characters came from, so a match found in the copy maps back
 * to the exact original span. "Lucía", "LUCIA", "lucia", "Ｌｕｃｉａ" (fullwidth) and "Soﬁa"
 * (with the "ﬁ" ligature) fold to plain lowercase letters; typographic apostrophes and
 * dashes fold to "'" and "-"; invisible format characters (a soft hyphen, a zero-width
 * joiner, a word joiner) and stray combining marks fold to nothing; an HTML character
 * reference pasted with a text ("Luc&iacute;a", "&#237;") folds to its letter.
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

/** One character folded: compatibility form, lowercase, accents removed. */
export function foldChar(ch: string): string {
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
    else out += c.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/\u{00DF}/gu, "ss");
  }
  return out;
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
    const entity = original[i] === "&" ? entityAt(original, i) : null;
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
