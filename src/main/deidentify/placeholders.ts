/*
 * The placeholders sent in place of each hidden value, in one place so their format
 * can change without touching the matchers. Uppercase words in square brackets,
 * numbered where a kind repeats: [CLIENT], [CAREGIVER 1 LAST NAME], [SCHOOL 2], [DATE 3].
 */
import type { NameForm } from "./names.ts";
import type { FoundKind, PersonGroup } from "./sheet.ts";

const GROUP_LABELS: Record<PersonGroup, string> = { client: "CLIENT", caregiver: "CAREGIVER", family: "FAMILY", professional: "PERSON" };
const FORM_SUFFIXES: Record<NameForm, string> = { first: "", full: " FULL NAME", last: " LAST NAME", initials: " INITIALS" };

/**
 * [CLIENT], [CAREGIVER 1 FULL NAME]; a surname alone is [CLIENT LAST NAME] for the whole
 * surname and [CLIENT LAST NAME 1], [CLIENT LAST NAME 2] for each of its parts; a full name
 * written with fewer words than the sheet's ("Valeria Ficticio" for "Valeria Ficticio
 * Gómez") is [FAMILY 1 FULL NAME 1], [FAMILY 1 FULL NAME 2]...: each restores exactly the
 * words it stood for, in the sheet's spelling.
 */
export function personPlaceholder(group: PersonGroup, index: number, form: NameForm, part = ""): string {
  const base = group === "client" ? GROUP_LABELS.client : `${GROUP_LABELS[group]} ${index + 1}`;
  return `[${base}${FORM_SUFFIXES[form]}${(form === "last" || form === "full") && part ? ` ${part}` : ""}]`;
}

export type NumberedKind = Exclude<FoundKind, PersonGroup | "dob">;

const KIND_LABELS: Record<NumberedKind, string> = {
  "unlisted-name": "NAME",
  school: "SCHOOL",
  address: "ADDRESS",
  city: "CITY",
  phone: "PHONE",
  email: "EMAIL",
  id: "ID",
  date: "DATE",
  other: "OTHER",
};

export function numberedPlaceholder(kind: NumberedKind, n: number): string {
  return `[${KIND_LABELS[kind]} ${n}]`;
}

export type BirthDateForm = "full" | "month-year" | "month-day";
const BIRTH_LABELS: Record<BirthDateForm, string> = { full: "[DOB]", "month-year": "[DOB MONTH AND YEAR]", "month-day": "[DOB MONTH AND DAY]" };

export function birthDatePlaceholder(form: BirthDateForm): string {
  return BIRTH_LABELS[form];
}

/** Every word a placeholder can start with: reidentify reports an unknown placeholder that starts with one. */
export const PLACEHOLDER_WORDS: readonly string[] = [...Object.values(GROUP_LABELS), ...Object.values(KIND_LABELS), "DOB"];
