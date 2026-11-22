import type { TFunction } from "i18next";
import type { Language } from "../../shared/api.ts";
import { SOURCE_TYPE_NAMES, type SourceSummary, type SourceType } from "../../shared/sources.ts";
import { Term } from "./components/Term.tsx";

/*
 * How a source is named on screen. Its type is a clinical term, English in both
 * languages (marked lang="en"), except "Other", which is translated. A source with no
 * title is named by its type (a pasted text) or its file (a PDF).
 */

export function sourceTypeName(t: TFunction, type: SourceType): string {
  return type === "other" ? t("sources.typeOther") : SOURCE_TYPE_NAMES[type];
}

/** The language of a type's name, for its lang attribute (undefined: the screen's). */
export function sourceTypeLang(type: SourceType): "en" | undefined {
  return type === "other" ? undefined : "en";
}

export function SourceTypeLabel({ t, type }: { t: TFunction; type: SourceType }) {
  const name = sourceTypeName(t, type);
  return type === "other" ? <>{name}</> : <Term>{name}</Term>;
}

/** The name the list and the dialogs use. */
export function sourceName(t: TFunction, source: SourceSummary): string {
  if (source.title) return source.title;
  return source.kind === "pdf" ? source.fileName : sourceTypeName(t, source.type);
}

/** The language of that name: a type's name is English; a title or a file name is whatever was typed. */
export function sourceNameLang(source: SourceSummary): string | undefined {
  return source.title || source.kind === "pdf" ? undefined : sourceTypeLang(source.type);
}

/** Megabytes, decimal, as the providers count them: "1.2 MB", "1,2 MB". Small files in kilobytes. */
export function formatFileSize(language: Language, bytes: number): string {
  const [value, unit] = bytes < 1_000_000 ? [Math.max(bytes / 1000, 0.1), "kilobyte"] : [bytes / 1_000_000, "megabyte"];
  return new Intl.NumberFormat(language, { style: "unit", unit, unitDisplay: "short", maximumFractionDigits: 1 }).format(value);
}

export function formatCount(language: Language, value: number): string {
  return new Intl.NumberFormat(language).format(value);
}

/** A source's date ("2026-10-02") in the screen language, read as a calendar day (no time zone shift). */
export function formatSourceDate(language: Language, date: string): string {
  return new Intl.DateTimeFormat(language, { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
}
