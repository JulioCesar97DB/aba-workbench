import type { TFunction } from "i18next";
import type { ClientAge, Language } from "../../shared/api.ts";

/*
 * Ages and dates in the screen language. The words for years and months, and the shape
 * of a date, come from the system's Intl data: "4 years 2 months", "4 años 2 meses".
 */

function unit(language: Language, name: "year" | "month", value: number): string {
  return new Intl.NumberFormat(language, { style: "unit", unit: name, unitDisplay: "long" }).format(value);
}

/** Null when no age was given. A child under one is given in months only. */
export function formatAge(t: TFunction, language: Language, age: ClientAge | null): string | null {
  if (!age) return null;
  if (age.months === undefined) return unit(language, "year", age.years);
  if (age.years === 0) return unit(language, "month", age.months);
  return t("age.yearsAndMonths", { years: unit(language, "year", age.years), months: unit(language, "month", age.months) });
}

export function formatDate(language: Language, iso: string): string {
  return new Intl.DateTimeFormat(language, { dateStyle: "medium" }).format(new Date(iso));
}

export function formatDateTime(language: Language, iso: string): string {
  return new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}

export type DatePart = "day" | "month" | "year";

/**
 * The order of day, month and year in the system's own date field (`type="date"`). Chromium
 * lays the field out in the app's locale, which is what navigator.language gives, not in
 * the screen language: a Spanish screen on a Windows set to US English shows mm/dd/yyyy.
 * The hint under the field names that order in the screen language (owner's decision T20).
 * Intl knows the locale's usual order only, so the two can differ when the computer's own
 * date format was customized (Windows) or its region is not the language's usual one
 * (macOS, such as English with region Mexico); the usual cases agree.
 */
export function dateFieldOrder(locale: string): DatePart[] {
  const parts = new Intl.DateTimeFormat(locale, { year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(Date.UTC(2026, 10, 23, 12)));
  return parts.map((part) => part.type).filter((type): type is DatePart => type === "day" || type === "month" || type === "year");
}
