/*
 * Text helpers shared by the evaluation's automatic checks: sentences, words, and the
 * numbers a text states. Pure functions with no imports beyond the app's own text helpers,
 * so every check is unit-tested (tests/eval-checks.test.ts).
 */
import { splitParagraphs } from "../../src/shared/section-text.ts";

export { splitParagraphs };

/** Lower case, curly quotes and dashes made plain, accents kept, runs of spaces made one. */
export function normalize(text: string): string {
  return text
    .normalize("NFC")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** The words of a text, normalized, letters and digits only (an apostrophe inside a word is kept). */
export function words(text: string): string[] {
  return normalize(text).match(/[\p{L}\p{N}]+(?:'[\p{L}]+)*/gu) ?? [];
}

/** Abbreviations whose period does not end a sentence. */
const ABBREVIATIONS = /\b(?:dr|mr|mrs|ms|m\.s|ph\.d|psy\.d|m\.d|e\.g|i\.e|vs|etc|a\.m|p\.m|no|st|approx|min|sec|hr|jr|sr)\.$/i;

/**
 * The sentences of a text, in order, each with its paragraph. Splits after ., ! or ? that
 * is followed by a space and an upper-case letter, a digit, a quote or a bracket, except
 * after the abbreviations above ("Dr.", "p.m.", "M.S.").
 */
export function sentences(text: string): Array<{ text: string; paragraph: number }> {
  const out: Array<{ text: string; paragraph: number }> = [];
  splitParagraphs(text).forEach((paragraph, index) => {
    const flat = paragraph.replace(/\s+/g, " ");
    let start = 0;
    const boundary = /[.!?]["')\]]?\s+(?=["'([]?[\p{Lu}\p{N}])/gu;
    for (let match = boundary.exec(flat); match !== null; match = boundary.exec(flat)) {
      const candidate = flat.slice(start, match.index + match[0].trimEnd().length);
      if (ABBREVIATIONS.test(candidate.replace(/["')\]]$/, ""))) continue;
      out.push({ text: candidate.trim(), paragraph: index });
      start = match.index + match[0].length;
    }
    const rest = flat.slice(start).trim();
    if (rest) out.push({ text: rest, paragraph: index });
  });
  return out;
}

/**
 * One number as a text states it, made comparable with the numbers of the sources:
 * - "date": a month and day, with the year when given ("10/07/2026", "October 7, 2026",
 *   "10/7"), as "MM-DD" plus "YYYY" when known;
 * - "time": a clock time ("3:00 p.m.", "3 p.m.", "15:00"), as minutes from midnight when
 *   the half of the day is known, else as "h:mm";
 * - "value": any other number ("230", "4.5", "1,000", "1st", "40%"), as its decimal value.
 */
export type StatedNumber =
  | { kind: "date"; raw: string; monthDay: string; year: string | null }
  | { kind: "time"; raw: string; clock: string }
  | { kind: "value"; raw: string; value: string };

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_PATTERN = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";

function monthIndex(name: string): number {
  const lower = name.toLowerCase();
  return MONTHS.findIndex((month) => month.startsWith(lower.slice(0, 3)));
}

const pad = (n: number) => String(n).padStart(2, "0");

/** A plain value as the comparison keeps it: no thousands commas, no leading zeros, no trailing zeros after a point. */
export function canonicalValue(raw: string): string {
  const plain = raw.replace(/,/g, "");
  const n = Number(plain);
  if (!Number.isFinite(n)) return plain;
  return String(n);
}

/**
 * Every number a text states. Digits that are part of a name are not numbers: an
 * instrument or a code written with letters ("Vineland-3", "BASC-3", "DSM-5", "ADOS-2",
 * "Conners 4", "Module 3", "F84.0") is a name. A billing code ("97153") stays a value.
 */
export function statedNumbers(text: string): StatedNumber[] {
  const found: StatedNumber[] = [];
  let rest = text.normalize("NFC").replace(/[–—]/g, "-");
  const take = (pattern: RegExp, make: (match: RegExpExecArray) => StatedNumber | null) => {
    rest = rest.replace(pattern, (...args: unknown[]) => {
      const match = args.slice(0, -2) as unknown as RegExpExecArray;
      const made = make(match);
      if (made) found.push(made);
      return " ".repeat(String(args[0]).length);
    });
  };
  // Names with digits: Vineland-3, BASC-3, DSM-5, ADOS-2, Conners 4, WISC-V, F84.0, F90.2, Module 3.
  take(/\b[A-Za-z]{2,}-\d+\b|\bF\d{2}\.\d\b|\bConners\s+\d\b|\bModule\s+\d\b/g, () => null);
  // ISO dates, as the app names a source's date: 2026-10-07.
  take(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m) => {
    const month = Number(m[2]);
    const day = Number(m[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return { kind: "date", raw: m[0], monthDay: `${pad(month)}-${pad(day)}`, year: m[1] };
  });
  // Dates: 10/07/2026, 10/7/26, 10/07.
  take(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g, (m) => {
    let month = Number(m[1]);
    let day = Number(m[2]);
    // A source in Spanish writes day/month ("20/09/2026"): read it that way when it cannot be month/day.
    if (month > 12 && day <= 12) [month, day] = [day, month];
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const year = m[3] ? (m[3].length === 2 ? `20${m[3]}` : m[3]) : null;
    return { kind: "date", raw: m[0], monthDay: `${pad(month)}-${pad(day)}`, year };
  });
  // Month and year with a slash: 03/2026.
  take(/\b(\d{1,2})\/(\d{4})\b/g, (m) => ({ kind: "value", raw: m[0], value: m[2] }));
  // Dates in words: October 7, 2026; October 7; 7 October 2026.
  take(new RegExp(`\\b(${MONTH_PATTERN})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, "gi"), (m) => {
    const month = monthIndex(m[1]) + 1;
    const day = Number(m[2]);
    if (month < 1 || day < 1 || day > 31) return null;
    return { kind: "date", raw: m[0], monthDay: `${pad(month)}-${pad(day)}`, year: m[3] ?? null };
  });
  take(new RegExp(`\\b(\\d{1,2})\\s+(${MONTH_PATTERN})\\.?(?:\\s+(\\d{4}))?\\b`, "gi"), (m) => {
    const month = monthIndex(m[2]) + 1;
    const day = Number(m[1]);
    if (month < 1 || day < 1 || day > 31) return null;
    return { kind: "date", raw: m[0], monthDay: `${pad(month)}-${pad(day)}`, year: m[3] ?? null };
  });
  // Clock times: 3:00 p.m., 3 p.m., 3:30, 15:00, 3:00 to 5:30 p.m. (the half of the day is not carried across a range).
  take(/\b(\d{1,2}):(\d{2})\s*(a\.?\s?m\.?|p\.?\s?m\.?)?|\b(\d{1,2})\s*(a\.?\s?m\.?|p\.?\s?m\.?)(?![\p{L}])/giu, (m) => {
    const hour = Number(m[1] ?? m[4]);
    const minute = m[2] ? Number(m[2]) : 0;
    if (hour > 23 || minute > 59) return null;
    return { kind: "time", raw: m[0].trim(), clock: `${hour % 12 === 0 && hour !== 0 ? 12 : hour > 12 ? hour - 12 : hour}:${pad(minute)}` };
  });
  // Age written as years:months (9:4) is caught above as a time; ages in words stay values below.
  // Anything else with digits: 1,000; 4.5; 1st; 40%; 76-86 (two values).
  take(/(?<![\p{L}\d.])\d{1,3}(?:,\d{3})+(?:\.\d+)?|(?<![\p{L}\d])\d+(?:\.\d+)?(?:st|nd|rd|th)?(?![\p{L}\d])/gu, (m) => {
    const raw = m[0];
    return { kind: "value", raw, value: canonicalValue(raw.replace(/(st|nd|rd|th)$/, "")) };
  });
  return found;
}

/** Every key a number can be found under in a source: a date by month-day and by its year, a time by its clock, a value by itself. */
export function numberKeys(number: StatedNumber): string[] {
  if (number.kind === "date") return [`date:${number.monthDay}`, ...(number.year ? [`value:${Number(number.year)}`, `date:${number.monthDay}:${number.year}`] : [])];
  if (number.kind === "time") return [`time:${number.clock}`];
  return [`value:${number.value}`];
}

/** The keys under which a number in an output must be found in the sources (the most specific one for a dated date). */
export function lookupKey(number: StatedNumber): string {
  if (number.kind === "date") return number.year ? `date:${number.monthDay}:${number.year}` : `date:${number.monthDay}`;
  if (number.kind === "time") return `time:${number.clock}`;
  return `value:${number.value}`;
}

/**
 * All the numbers of a set of texts (the sources and her inputs), by key. A date also
 * counts as its year. The parts of a date or a time do not count as numbers of their
 * own: "7" is not supported by "10/07/2026".
 */
export function numberIndex(texts: readonly string[]): Set<string> {
  const keys = new Set<string>();
  for (const text of texts) for (const number of statedNumbers(text)) for (const key of numberKeys(number)) keys.add(key);
  return keys;
}
