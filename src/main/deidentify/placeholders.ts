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
 * [CLIENT], [CLIENT FULL NAME], [CLIENT LAST NAME] for the sheet's own whole forms; any other
 * written form has its own number, in the order met: [CLIENT FIRST NAME 1] ("José" of "María
 * José", "Lucy"), [FAMILY 1 FULL NAME 1] ("Valeria Ficticio"), [CLIENT LAST NAME 1] ("Gómez",
 * "la Fuente", "Gómez-Ficticio"): each restores exactly the words it stood for.
 */
export function personPlaceholder(group: PersonGroup, index: number, form: NameForm, part = ""): string {
  const base = group === "client" ? GROUP_LABELS.client : `${GROUP_LABELS[group]} ${index + 1}`;
  if (!part) return `[${base}${FORM_SUFFIXES[form]}]`;
  return `[${base}${form === "first" ? " FIRST NAME" : FORM_SUFFIXES[form]} ${part}]`;
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

export type BirthDateForm = "full" | "month-year" | "month-day" | "month" | "day";
const BIRTH_LABELS: Record<BirthDateForm, string> = { full: "[DOB]", "month-year": "[DOB MONTH AND YEAR]", "month-day": "[DOB MONTH AND DAY]", month: "[DOB MONTH]", day: "[DOB DAY]" };

/** [DOB] for the first written form, [DOB 2], [DOB 3] for the others: each restores exactly as it was written. */
export function birthDatePlaceholder(form: BirthDateForm, n = 1): string {
  return n === 1 ? BIRTH_LABELS[form] : BIRTH_LABELS[form].replace("]", ` ${n}]`);
}

/** A sheet nickname as written: [CLIENT NICKNAME], [CAREGIVER 1 NICKNAME]; numbered when the sheet lists several ([CLIENT NICKNAME 2]). */
export function nicknamePlaceholder(group: PersonGroup, index: number, nickname: number, of: number): string {
  const base = group === "client" ? GROUP_LABELS.client : `${GROUP_LABELS[group]} ${index + 1}`;
  return `[${base} NICKNAME${of > 1 ? ` ${nickname + 1}` : ""}]`;
}

/** Every word a placeholder can start with: reidentify reports an unknown placeholder that starts with one. */
export const PLACEHOLDER_WORDS: readonly string[] = [...Object.values(GROUP_LABELS), ...Object.values(KIND_LABELS), "DOB"];
