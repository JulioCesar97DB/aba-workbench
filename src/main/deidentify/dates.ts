/*
 * Finds dates in any usual written form, on folded text (lowercase, no accents), by
 * reading a stream of tokens (numbers, words, separators) rather than matching a list
 * of formats:
 *   numbers: 03/14/2020, 3-14-20, 03 . 14 . 2020, 03/14/ 2020, 3/14/'20, 2020/03/14, 14-III-2020;
 *   a month name or abbreviation (English or Spanish), with a day as a number, an
 *   ordinal or a word, before or after it, "the", "of" or "de" between, and a year of
 *   four digits or "'20": March 14, 2020; March the 14th, 2020; Mar-14-2020; 14Mar2020;
 *   14th of March, 2020; 5 Jan 24; Jan 5 '24; el catorce de marzo de 2020;
 *   a month with its year (March 2020, marzo de 2020, 03/2020);
 *   a month with its day (March 14, 14th March, 14 de marzo), and a bare 3/14 or 14/3
 *   (`pair`), which only matter when they are the date of birth;
 *   six or eight digits (031420, 03142020) (`compact`), which only matter when they are
 *   the date of birth.
 * Linear: each token is looked at a bounded number of times, and overlaps are resolved
 * with a sorted structure.
 */
import type { Folded } from "./fold.ts";
import { Spans } from "./spans.ts";

export interface YMD {
  year: number;
  month: number;
  day?: number;
}

export interface DateMatch {
  start: number;
  end: number;
  /** What the date can mean: two readings when 04/05/2020 could be April 5 or May 4 (US first). */
  readings: YMD[];
  /** "full" has a day, a month and a year. */
  precision: "full" | "month-year" | "month-day";
  /** Six or eight digits with no separator: only a date when it is the date of birth. */
  compact?: boolean;
  /** Two numbers ("3/14"): only a date when it is the date of birth. */
  pair?: boolean;
}

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  ene: 1, abr: 4, ago: 8, dic: 12, set: 9,
};
const ROMAN: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10, xi: 11, xii: 12 };
const ORDINAL_SUFFIXES = new Set(["st", "nd", "rd", "th", "o", "a", "ro", "er", "do", "to", "vo", "no"]);

/** Day numbers written as words, English and Spanish, cardinal and ordinal, folded. */
const DAY_WORDS = new Map<string, number>();
{
  const units = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
  const unitOrdinals = ["", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth"];
  const teens = ["ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
  const teenOrdinals = ["tenth", "eleventh", "twelfth", "thirteenth", "fourteenth", "fifteenth", "sixteenth", "seventeenth", "eighteenth", "nineteenth"];
  for (let n = 1; n <= 9; n++) {
    DAY_WORDS.set(units[n], n);
    DAY_WORDS.set(unitOrdinals[n], n);
  }
  teens.forEach((w, i) => DAY_WORDS.set(w, 10 + i));
  teenOrdinals.forEach((w, i) => DAY_WORDS.set(w, 10 + i));
  DAY_WORDS.set("twenty", 20).set("twentieth", 20).set("thirty", 30).set("thirtieth", 30);
  for (let n = 1; n <= 9; n++) {
    DAY_WORDS.set(`twenty ${units[n]}`, 20 + n).set(`twenty ${unitOrdinals[n]}`, 20 + n);
  }
  DAY_WORDS.set("thirty one", 31).set("thirty first", 31);
  const es = ["", "uno", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve", "diez", "once", "doce", "trece", "catorce", "quince", "dieciseis", "diecisiete", "dieciocho", "diecinueve", "veinte"];
  es.forEach((w, n) => n > 0 && DAY_WORDS.set(w, n));
  DAY_WORDS.set("primero", 1).set("primer", 1).set("un", 1).set("treinta", 30).set("treinta y uno", 31).set("treintaiuno", 31);
  ["veintiuno", "veintidos", "veintitres", "veinticuatro", "veinticinco", "veintiseis", "veintisiete", "veintiocho", "veintinueve"].forEach((w, i) => DAY_WORDS.set(w, 21 + i));
  ["uno", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve"].forEach((w, i) => DAY_WORDS.set(`veinte y ${w}`, 21 + i));
}

type Kind = "num" | "word" | "apos" | "sep" | "other";
interface Token {
  kind: Kind;
  text: string;
  start: number;
  end: number;
  /** Whitespace stands right before this token. */
  gap: boolean;
}

/** Full month names and day words: a word broken into two of these pieces is rejoined. */
const JOINABLE = new Set([...Object.keys(MONTHS).filter((m) => m.length > 4), ...[...DAY_WORDS.keys()].filter((w) => !w.includes(" "))]);

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let gap = false;
  for (const m of text.matchAll(/(\d+)|(\p{L}+)|(')|([/\-.,])|(\s+)|([^])/gu)) {
    if (m[5]) {
      gap = true;
      continue;
    }
    const kind: Kind = m[1] ? "num" : m[2] ? "word" : m[3] ? "apos" : m[4] ? "sep" : "other";
    tokens.push({ kind, text: m[0], start: m.index, end: m.index + m[0].length, gap });
    gap = false;
  }
  // A month or day word hyphenated or split by a space or a line ("Mar-ch", "Mar-⏎ch", "Septem ber", "four teenth"): one word again.
  const out: Token[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const a = tokens[i];
    if (a.kind === "word") {
      const hyphen = tokens[i + 1]?.kind === "sep" && tokens[i + 1].text === "-" && !tokens[i + 1].gap;
      const b = tokens[hyphen ? i + 2 : i + 1];
      if (b && b.kind === "word" && (hyphen || b.gap) && JOINABLE.has(a.text + b.text) && !JOINABLE.has(b.text) && !(b.text in MONTHS)) {
        out.push({ kind: "word", text: a.text + b.text, start: a.start, end: b.end, gap: a.gap });
        i += hyphen ? 2 : 1;
        continue;
      }
    }
    out.push(a);
  }
  return out;
}

function valid({ year, month, day }: YMD): boolean {
  if (month < 1 || month > 12 || year < 1900 || year > 2200) return false;
  if (day === undefined) return true;
  return day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function fullYear(text: string, thisYear: number): number {
  if (text.length === 4) return Number(text);
  const yy = Number(text);
  return 2000 + yy <= thisYear + 1 ? 2000 + yy : 1900 + yy;
}

export function findDates(folded: Folded, today: Date): DateMatch[] {
  const thisYear = today.getUTCFullYear();
  const t = tokenize(folded.text);
  const n = t.length;
  const found: DateMatch[] = [];
  const is = (i: number, kind: Kind, text?: string) => i >= 0 && i < n && t[i].kind === kind && (text === undefined || t[i].text === text);
  const sepChar = (i: number) => (is(i, "sep") ? t[i].text : "");
  const push = (startToken: number, endToken: number, readings: YMD[], precision: DateMatch["precision"], extra: Partial<DateMatch> = {}) => {
    const ok = readings.filter(valid);
    const unique = ok.filter((r, k) => ok.findIndex((o) => o.year === r.year && o.month === r.month && o.day === r.day) === k);
    if (unique.length) found.push({ start: t[startToken].start, end: t[endToken].end, readings: unique, precision, ...extra });
  };
  /** A month at token i: its number and the index of its last token (an abbreviation may take a period). */
  const monthAt = (i: number): { month: number; last: number } | null => {
    if (!is(i, "word") || !(t[i].text in MONTHS)) return null;
    const abbreviation = t[i].text.length <= 4 && !["june", "july", "mayo"].includes(t[i].text);
    const last = abbreviation && is(i + 1, "sep", ".") && !t[i + 1].gap ? i + 1 : i;
    return { month: MONTHS[t[i].text], last };
  };
  /** A day starting at token i: "14", "14th", "14 th", "fourteenth", "twenty-first", "catorce", "treinta y uno". */
  const dayAt = (i: number): { day: number; last: number } | null => {
    if (is(i, "num") && t[i].text.length <= 2) {
      const day = Number(t[i].text);
      if (day < 1 || day > 31) return null;
      const suffix = is(i + 1, "word") && ORDINAL_SUFFIXES.has(t[i + 1].text) && !t[i + 1].gap;
      return { day, last: suffix ? i + 1 : i };
    }
    if (!is(i, "word")) return null;
    for (let length = 3; length >= 1; length--) {
      const words: string[] = [];
      let j = i;
      for (; j < n && words.length < length; j++) {
        if (t[j].kind === "word") words.push(t[j].text);
        else if (!(t[j].kind === "sep" && t[j].text === "-")) break;
      }
      if (words.length !== length) continue;
      const day = DAY_WORDS.get(words.join(" "));
      if (day !== undefined) return { day, last: j - 1 };
    }
    return null;
  };
  /** A day ending at token i (for "14th of March"): walks back over a suffix or day words. */
  const dayEndingAt = (i: number): { day: number; first: number } | null => {
    for (let first = Math.max(0, i - 4); first <= i; first++) {
      const d = dayAt(first);
      if (d && d.last === i) return { day: d.day, first };
    }
    return null;
  };
  /** A year at token i: four digits, or "'20". `short` also takes two digits. */
  const yearAt = (i: number, short: boolean): { year: number; last: number } | null => {
    if (is(i, "apos") && is(i + 1, "num") && t[i + 1].text.length === 2 && !t[i + 1].gap) return { year: fullYear(t[i + 1].text, thisYear), last: i + 1 };
    if (is(i, "num") && t[i].text.length === 4) return { year: Number(t[i].text), last: i };
    if (short && is(i, "num") && t[i].text.length === 2) return { year: fullYear(t[i].text, thisYear), last: i };
    return null;
  };
  /** Skips separators and the little words that can stand between parts of a date. */
  const skip = (i: number, words: string[]): number => {
    while (i < n && ((t[i].kind === "sep" && t[i].text !== ".") || (t[i].kind === "word" && words.includes(t[i].text)))) i++;
    return i;
  };
  /** Not part of a longer run of numbers ("1-305-555-0142", "1.2.3.4"). */
  const freeBefore = (i: number) => !(is(i - 1, "sep") && !t[i].gap && is(i - 2, "num") && !t[i - 1].gap);
  const freeAfter = (i: number) => !(is(i + 1, "sep") && !t[i + 1].gap && (is(i + 2, "num") || is(i + 2, "apos")) && !t[i + 2].gap);

  for (let i = 0; i < n; i++) {
    const tok = t[i];
    // Numbers: a, sep, b, sep, c (the same separator, spaces allowed around it), or a, sep, b.
    if (tok.kind === "num" && freeBefore(i)) {
      if (tok.text.length === 6 || tok.text.length === 8) {
        const d = tok.text;
        const readings: YMD[] =
          d.length === 6
            ? [{ month: +d.slice(0, 2), day: +d.slice(2, 4), year: fullYear(d.slice(4), thisYear) }, { day: +d.slice(0, 2), month: +d.slice(2, 4), year: fullYear(d.slice(4), thisYear) }]
            : [
                { month: +d.slice(0, 2), day: +d.slice(2, 4), year: +d.slice(4) },
                { day: +d.slice(0, 2), month: +d.slice(2, 4), year: +d.slice(4) },
                { year: +d.slice(0, 4), month: +d.slice(4, 6), day: +d.slice(6) },
              ];
        push(i, i, readings, "full", { compact: true });
      }
      const s1 = sepChar(i + 1);
      if (tok.text.length <= 4 && (s1 === "/" || s1 === "-" || s1 === ".")) {
        const middleRoman = is(i + 2, "word") && t[i + 2].text in ROMAN;
        if (is(i + 2, "num") || middleRoman) {
          const b = t[i + 2].text;
          if (sepChar(i + 3) === s1) {
            const year = yearAt(i + 4, true);
            if (year && freeAfter(year.last)) {
              if (tok.text.length === 4 && !middleRoman && is(i + 4, "num") && t[i + 4].text.length <= 2) {
                push(i, i + 4, [{ year: +tok.text, month: +b, day: +t[i + 4].text }], "full");
              } else if (tok.text.length <= 2) {
                const readings = middleRoman ? [{ year: year.year, month: ROMAN[b], day: +tok.text }] : [{ year: year.year, month: +tok.text, day: +b }, { year: year.year, month: +b, day: +tok.text }];
                push(i, year.last, readings, "full");
              }
            }
          } else if (!middleRoman && tok.text.length <= 2 && b.length <= 2 && (s1 === "/" || s1 === "-") && freeAfter(i + 2)) {
            push(i, i + 2, [{ year: 2000, month: +tok.text, day: +b }, { year: 2000, month: +b, day: +tok.text }], "month-day", { pair: true });
          }
          // 03/2020
          if (s1 === "/" && is(i + 2, "num") && b.length === 4 && tok.text.length <= 2 && freeAfter(i + 2)) push(i, i + 2, [{ year: +b, month: +tok.text }], "month-year");
        }
      }
      continue;
    }
    // A month name: look for a day after it ("March the 14th, 2020") or before it ("14th of March"), and a year.
    const month = monthAt(i);
    if (!month) continue;
    let start = i;
    let end = month.last;
    let day: number | undefined;
    let shortYear = false;
    // After: [sep] [the|el] DAY. Before: [the|el] DAY [of|de] [sep].
    const j = skip(month.last + 1, ["the", "el"]);
    const after = j - month.last <= 3 ? dayAt(j) : null;
    let k = i - 1;
    while (k >= 0 && t[k].kind === "sep" && t[k].text !== ".") k--;
    if (k >= 0 && t[k].kind === "word" && (t[k].text === "of" || t[k].text === "de")) k--;
    const before = k >= 0 ? dayEndingAt(k) : null;
    const yearAfter = (last: number, short: boolean) => {
      const y = skip(last + 1, ["of", "de", "del", "ano", "in", "en"]);
      return y - last <= 4 ? yearAt(y, short) : null;
    };
    // "5 Jan 24", "14-mar-20": with a day before the month, two digits after it are the year, unless a year follows them.
    const afterIsYear = before && after && after.last === j && t[j].text.length === 2 && /^\d+$/u.test(t[j].text) && !yearAfter(after.last, false);
    if (after && !afterIsYear && (!before || yearAfter(after.last, true))) {
      day = after.day;
      end = after.last;
      // A day after the month takes a two-digit year only after a dash or a slash ("Mar-14-20").
      shortYear = sepChar(after.last + 1) === "-" || sepChar(after.last + 1) === "/";
    } else if (before && i - before.first <= 6) {
      day = before.day;
      start = before.first;
      if (start > 0 && is(start - 1, "word") && (t[start - 1].text === "the" || t[start - 1].text === "el")) start--;
      // "5 Jan 24", "14-mar-20", "14MAR20": a two-digit year after a day and a month.
      shortYear = true;
    }
    // The year: [,] [of|de|del] [ano] YEAR
    const year = yearAfter(end, shortYear);
    if (year && freeAfter(year.last)) {
      push(start, year.last, [{ year: year.year, month: month.month, day }], day === undefined ? "month-year" : "full");
    } else if (day !== undefined) {
      push(start, end, [{ year: 2000, month: month.month, day }], "month-day");
    }
  }

  // The longest reading of any stretch wins; equal ones prefer full dates.
  const rank = { full: 0, "month-year": 1, "month-day": 2 };
  found.sort((a, b) => b.end - b.start - (a.end - a.start) || rank[a.precision] - rank[b.precision] || a.start - b.start);
  const kept = new Spans<DateMatch>();
  for (const date of found) if (kept.overlapping(date.start, date.end).length === 0) kept.add(date);
  return kept.items;
}

/** YYYY-MM-DD of a reading, for keys. */
export function ymdKey({ year, month, day }: YMD): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return day === undefined ? `${year}-${pad(month)}` : `${year}-${pad(month)}-${pad(day)}`;
}

export function parseIsoDate(text: string | undefined): YMD | null {
  const m = text?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const ymd = { year: +m[1], month: +m[2], day: +m[3] };
  return valid(ymd) ? ymd : null;
}
