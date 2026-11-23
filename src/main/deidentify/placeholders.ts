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

/** "Caregiver_1", "caregiver-1" and "CAREGIVER1" all read "CAREGIVER 1". */
export function labelKey(label: string): string {
  return label
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toUpperCase()
    .replace(/(\p{L})(\p{N})/gu, "$1 $2")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const OPEN = "(?:\\\\?\\[){1,2}|\\{{1,2}|<|\u{3010}|\u{00AB}";
const CLOSE = "(?:\\\\?\\]){1,2}|\\}{1,2}|>|\u{3011}|\u{00BB}";
/** Any bracketed stretch of up to 60 characters on one line, with no other bracket inside: what reidentify reads as a placeholder. */
export const BRACKETED = new RegExp(`(?:${OPEN})([^\\[\\]{}<>\\n\\u{3010}\\u{3011}\\u{00AB}\\u{00BB}]{1,60}?)(?:${CLOSE})`, "gu");

/**
 * Whether bracketed text in a source would be read back as a placeholder ("[DOB]", "[Client]",
 * "{Date}", "[CAREGIVER 1]"): its first word is a placeholder word. The de-identifier sends such
 * text under a placeholder of its own ([OTHER n]), so the only placeholders in what the model
 * sees, and so in what it writes, are the ones issued.
 */
export function looksLikePlaceholder(inner: string): boolean {
  const key = labelKey(inner.replace(/[ \t]*['\u{2019}][sS]$/u, ""));
  return key !== "" && PLACEHOLDER_WORDS.includes(key.split(" ")[0]);
}

/**
 * What the model is told about placeholders, in the request's instructions. It matches what
 * reidentify restores: a placeholder in square brackets (another case, separator or bracket
 * style is still read), never one in parentheses or without brackets.
 */
export const PLACEHOLDER_INSTRUCTIONS = [
  "The sources are de-identified: each identifying detail is replaced by a placeholder, a label in capitals inside square brackets, such as [CLIENT], [CLIENT FULL NAME], [CAREGIVER 1], [DOB] or [SCHOOL 1].",
  "Wherever you mention one of these details, write its placeholder exactly as it appears in the sources, square brackets included: do not change its words, number or case, and do not invent new ones.",
  "Never write a placeholder in parentheses or without its square brackets: only a placeholder in square brackets is replaced by the real detail; anything else is shown as written.",
  "[OTHER n] stands for bracketed text in the sources; keep it as it is.",
].join(" ");
