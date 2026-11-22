/*
 * Finds dates in the formats US clinical reports, EMRs and the clinician's notes use,
 * in English and Spanish, on folded text (lowercase, no accents):
 *   03/14/2020, 3/14/20, 3-14-20, 03.14.2020, 2020-03-14, 2020/03/14, 2020.03.14,
 *   March 14, 2020, Mar. 14th 2020, March 14 , 2020, Mar-14-2020, marzo 14, 2020,
 *   14 March 2020, 14th of March, 2020, 14-Mar-2020, 14-mar-20, 14Mar2020, 14MAR20,
 *   14 de marzo de 2020;
 * a month with its year (March 2020, Mar-2020, marzo de 2020, 03/2020); a month with its
 * day (March 14, 14th March, 14 de marzo, and 3/14 after a word such as "birthday"),
 * which only matters when it is the date of birth.
 * Only abbreviations take a period ("Mar. 14"): "marzo." ends a sentence.
 */
import type { Folded } from "./fold.ts";

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
}

const FULL_MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};
const ABBREVIATIONS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  ene: 1, abr: 4, ago: 8, dic: 12, set: 9,
};
const MONTHS: Record<string, number> = { ...FULL_MONTHS, ...ABBREVIATIONS };

const monthAlternatives = [
  ...Object.keys(FULL_MONTHS),
  ...Object.keys(ABBREVIATIONS).map((a) => `${a}\\.?`),
].sort((a, b) => b.length - a.length);
/** A month name, or an abbreviation with an optional period; never followed by another letter. */
const MONTH = `(${monthAlternatives.join("|")})(?![\\p{L}])`;
const DAY = "(\\d{1,2})(?:st|nd|rd|th|ro|o)?";
const YEAR4 = "(\\d{4})";
const B = "(?<![\\p{L}\\p{N}])";
/** After a date: no digit, and no more date ("2020and" from PDF text with lost spaces still ends a date). */
const E = "(?![\\p{N}]|[/.\\-]\\d)";
/** Between a day and a month, or a month and a day: spaces, a dash, a slash, a dot, or nothing ("14Mar2020"). */
const JOIN = "[\\s\\-/.]*";
const YEAR_JOIN = "[\\s\\-/.]*,?\\s*(?:de\\s+|del\\s+)?";

interface Shape {
  regex: RegExp;
  read: (m: RegExpMatchArray, thisYear: number) => YMD[];
  precision: DateMatch["precision"];
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

const month = (name: string) => MONTHS[name.replace(/\.$/, "")];
const re = (source: string) => new RegExp(source, "gu");

const SHAPES: Shape[] = [
  // 2020-03-14, 2020/03/14, 2020.03.14
  { regex: re(`${B}(\\d{4})([\\-/.])(\\d{1,2})\\2(\\d{1,2})${E}`), precision: "full", read: (m) => [{ year: +m[1], month: +m[3], day: +m[4] }] },
  // 03/14/2020, 3-14-20, 03.14.2020 (US order first, the other order when it also makes a date)
  {
    regex: re(`${B}(\\d{1,2})([/.\\-])(\\d{1,2})\\2(\\d{4}|\\d{2})${E}`),
    precision: "full",
    read: (m, y) => {
      const year = fullYear(m[4], y);
      return [{ year, month: +m[1], day: +m[3] }, { year, month: +m[3], day: +m[1] }];
    },
  },
  // March 14, 2020 / Mar-14-2020 / March 14 , 2020 / marzo 14 de 2020
  { regex: re(`${B}${MONTH}${JOIN}${DAY}${YEAR_JOIN}${YEAR4}${E}`), precision: "full", read: (m) => [{ year: +m[3], month: month(m[1]), day: +m[2] }] },
  // Mar-14-20, Mar/14/20: a two-digit year only after a dash or a slash
  { regex: re(`${B}${MONTH}[\\-/]${DAY}[\\-/](\\d{2})${E}`), precision: "full", read: (m, y) => [{ year: fullYear(m[3], y), month: month(m[1]), day: +m[2] }] },
  // 14 March 2020 / 14th of March, 2020 / 14-Mar-2020 / 14Mar2020 / 14 de marzo de 2020
  {
    regex: re(`${B}${DAY}${JOIN}(?:of\\s+|de\\s+)?${MONTH}${JOIN}${YEAR_JOIN}${YEAR4}${E}`),
    precision: "full",
    read: (m) => [{ year: +m[3], month: month(m[2]), day: +m[1] }],
  },
  // 14-mar-20, 14/Mar/20, 14MAR20: a two-digit year only after a dash, a slash or nothing
  { regex: re(`${B}${DAY}([\\-/]?)${MONTH}\\2(\\d{2})${E}`), precision: "full", read: (m, y) => [{ year: fullYear(m[4], y), month: month(m[3]), day: +m[1] }] },
  // March 2020 / March, 2020 / Mar-2020 / marzo de 2020
  { regex: re(`${B}${MONTH}[\\s,\\-/.]*(?:of\\s+|de\\s+|del\\s+)?${YEAR4}${E}`), precision: "month-year", read: (m) => [{ year: +m[2], month: month(m[1]) }] },
  // 03/2020
  { regex: re(`${B}(\\d{1,2})/(\\d{4})${E}`), precision: "month-year", read: (m) => [{ year: +m[2], month: +m[1] }] },
  // March 14 / Mar-14 / 14th March / 14 de marzo / 14th of March (no year)
  { regex: re(`${B}${MONTH}[\\s\\-/]*${DAY}(?![\\p{L}\\p{N}])`), precision: "month-day", read: (m) => [{ year: 2000, month: month(m[1]), day: +m[2] }] },
  { regex: re(`${B}${DAY}[\\s\\-/]*(?:of\\s+|de\\s+)?${MONTH}`), precision: "month-day", read: (m) => [{ year: 2000, month: month(m[2]), day: +m[1] }] },
  // 3/14 right after a word that announces a birthday
  {
    regex: re(
      `(?<=(?:birthday|birth\\s+date|date\\s+of\\s+birth|bday|b-day|dob|d\\.o\\.b\\.?|born(?:\\s+on)?|cumpleanos|cumple|nacimiento|fecha\\s+de\\s+nacimiento|nacio(?:\\s+el)?)\\s*[:\\-]?\\s*(?:(?:is|was|on|es|era|fue|el|de)\\s+){0,3})(\\d{1,2})[/\\-.](\\d{1,2})(?![\\p{N}]|[/\\-.]\\d)`,
    ),
    precision: "month-day",
    read: (m) => [{ year: 2000, month: +m[1], day: +m[2] }, { year: 2000, month: +m[2], day: +m[1] }],
  },
];

/** Every date in `folded`, left to right; the longest reading of any stretch of text wins. */
export function findDates(folded: Folded, today: Date): DateMatch[] {
  const thisYear = today.getUTCFullYear();
  const all: DateMatch[] = [];
  for (const shape of SHAPES) {
    for (const m of folded.text.matchAll(shape.regex)) {
      const readings = shape.read(m, thisYear).filter(valid);
      const unique = readings.filter((r, i) => readings.findIndex((o) => o.year === r.year && o.month === r.month && o.day === r.day) === i);
      if (unique.length === 0) continue;
      all.push({ start: m.index, end: m.index + m[0].length, readings: unique, precision: shape.precision });
    }
  }
  const rank = { full: 0, "month-year": 1, "month-day": 2 };
  all.sort((a, b) => b.end - b.start - (a.end - a.start) || rank[a.precision] - rank[b.precision] || a.start - b.start);
  const kept: DateMatch[] = [];
  for (const date of all) if (!kept.some((d) => d.start < date.end && date.start < d.end)) kept.push(date);
  return kept.sort((a, b) => a.start - b.start);
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
