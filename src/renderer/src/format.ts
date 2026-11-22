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
