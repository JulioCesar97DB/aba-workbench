/*
 * Finds dates in the formats US clinical reports and the clinician's notes use, in
 * English and Spanish: 03/14/2020, 3/14/20, 3-14-20, 03.14.2020, 2020-03-14,
 * March 14, 2020, Mar. 14th 2020, 14 March 2020, 14th of March, 2020,
 * 14 de marzo de 2020, marzo 14, 2020; a month with its year (March 2020, marzo de 2020,
 * 03/2020); and a month with its day (March 14, 14 de marzo), which only matters when
 * it is the date of birth. It runs on folded text (lowercase, no accents).
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

const MONTHS: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5, june: 6, jun: 6,
  july: 7, jul: 7, august: 8, aug: 8, september: 9, sept: 9, sep: 9, october: 10, oct: 10,
  november: 11, nov: 11, december: 12, dec: 12,
  enero: 1, ene: 1, febrero: 2, marzo: 3, abril: 4, abr: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, ago: 8,
  septiembre: 9, setiembre: 9, set: 9, octubre: 10, noviembre: 11, diciembre: 12, dic: 12,
};
const MONTH = `(${Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|")})\\.?`;
const DAY = "(\\d{1,2})(?:st|nd|rd|th|ro|o)?";
const YEAR = "(\\d{4})";
const B = "(?<![\\p{L}\\p{N}])";
const E = "(?![\\p{L}\\p{N}]|[/.\\-]\\d)";

interface Shape {
  regex: RegExp;
  read: (m: RegExpMatchArray, thisYear: number) => DateMatch["readings"];
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

const SHAPES: Shape[] = [
  // 2020-03-14
  { regex: new RegExp(`${B}(\\d{4})-(\\d{1,2})-(\\d{1,2})${E}`, "gu"), precision: "full", read: (m) => [{ year: +m[1], month: +m[2], day: +m[3] }] },
  // 03/14/2020, 3-14-20, 03.14.2020 (US order first, the other order when it also makes a date)
  {
    regex: new RegExp(`${B}(\\d{1,2})([/.\\-])(\\d{1,2})\\2(\\d{4}|\\d{2})${E}`, "gu"),
    precision: "full",
    read: (m, y) => {
      const year = fullYear(m[4], y);
      return [{ year, month: +m[1], day: +m[3] }, { year, month: +m[3], day: +m[1] }];
    },
  },
  // March 14, 2020 / marzo 14 de 2020
  { regex: new RegExp(`${B}${MONTH}\\s+${DAY},?\\s+(?:de\\s+|del\\s+)?${YEAR}${E}`, "gu"), precision: "full", read: (m) => [{ year: +m[3], month: MONTHS[m[1]], day: +m[2] }] },
  // 14 March 2020 / 14th of March, 2020 / 14 de marzo de 2020
  {
    regex: new RegExp(`${B}${DAY}\\s+(?:of\\s+|de\\s+)?${MONTH},?\\s+(?:de\\s+|del\\s+)?${YEAR}${E}`, "gu"),
    precision: "full",
    read: (m) => [{ year: +m[3], month: MONTHS[m[2]], day: +m[1] }],
  },
  // March 2020 / March, 2020 / marzo de 2020
  { regex: new RegExp(`${B}${MONTH},?\\s+(?:of\\s+|de\\s+|del\\s+)?${YEAR}${E}`, "gu"), precision: "month-year", read: (m) => [{ year: +m[2], month: MONTHS[m[1]] }] },
  // 03/2020
  { regex: new RegExp(`${B}(\\d{1,2})/(\\d{4})${E}`, "gu"), precision: "month-year", read: (m) => [{ year: +m[2], month: +m[1] }] },
  // March 14 / 14 de marzo / 14th of March (no year)
  { regex: new RegExp(`${B}${MONTH}\\s+${DAY}(?![\\p{L}\\p{N}]|,?\\s+(?:de\\s+)?\\d)`, "gu"), precision: "month-day", read: (m) => [{ year: 2000, month: MONTHS[m[1]], day: +m[2] }] },
  { regex: new RegExp(`${B}${DAY}\\s+(?:of\\s+|de\\s+)${MONTH}(?![\\p{L}\\p{N}]|,?\\s+(?:de\\s+|del\\s+)?\\d)`, "gu"), precision: "month-day", read: (m) => [{ year: 2000, month: MONTHS[m[2]], day: +m[1] }] },
];

/** Every date in `folded`, left to right; a longer date wins over one inside it. */
export function findDates(folded: Folded, today: Date): DateMatch[] {
  const thisYear = today.getUTCFullYear();
  const found: DateMatch[] = [];
  for (const shape of SHAPES) {
    for (const m of folded.text.matchAll(shape.regex)) {
      const readings = shape.read(m, thisYear).filter(valid);
      const unique = readings.filter((r, i) => readings.findIndex((o) => o.year === r.year && o.month === r.month && o.day === r.day) === i);
      if (unique.length === 0) continue;
      const start = m.index;
      const end = m.index + m[0].length;
      if (found.some((d) => d.start < end && start < d.end)) continue;
      found.push({ start, end, readings: unique, precision: shape.precision });
    }
  }
  return found.sort((a, b) => a.start - b.start);
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
