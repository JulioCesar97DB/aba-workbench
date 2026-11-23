/*
 * reidentify(text, map): the AI's text with the placeholders put back, on the
 * clinician's computer. It accepts what models do to placeholders:
 *   [Client], [client]          another case
 *   [CLIENT'S], [CLIENT]'s      a possessive inside or after the brackets (people only)
 *   [CAREGIVER_1], [CAREGIVER1] another separator, or none
 *   [[CLIENT]], {CLIENT}, <CLIENT>, \[CLIENT\]  doubled, other or escaped brackets
 * Only a placeholder in brackets is restored. Ordinary text can hold a label in parentheses or
 * without brackets ("Date of birth (DOB)", "Name of client (CLIENT)", a form's "CAREGIVER 1"
 * heading), so "(CLIENT)", "CAREGIVER 1" and a placeholder with one bracket missing ("[CLIENT went
 * home") are reported, never turned into a value. Bracketed text in a source that reads as a
 * placeholder ("[DOB]" in a blank form) is sent as [OTHER n] by the de-identifier, so every
 * placeholder in brackets the model can echo is one that was issued.
 * It never restores part of a bracket: "[CLIENT NAME]", "[CLIENT 1]" or "[DOB MONTH AND
 * YEAR]" when only [CLIENT] and [DOB] were sent stay as they are and are reported.
 * Whatever looks like a placeholder and cannot be restored is reported, never dropped:
 * an unknown one ([CAREGIVER 3] when there are two, [INSERT DATE], [Client's name]), a
 * capitalized label with no brackets or in parentheses (CLIENT, (CAREGIVER 1)), and one with a
 * bracket missing. "DOB" and "(DOB)" alone are left as they are: it is how forms label a date of birth.
 */
import type { RestoreMap } from "./deidentify.ts";
import { BRACKETED, labelKey, PLACEHOLDER_WORDS } from "./placeholders.ts";
import { Spans } from "./spans.ts";

export interface Restored {
  placeholder: string;
  count: number;
  /** How many of those were written differently from the placeholder that was sent. */
  repaired: number;
}

export interface Unrestored {
  text: string;
  start: number;
  end: number;
  /** unknown-placeholder: in brackets, but not one that was sent; no-brackets: a label sent, written in parentheses or bare; missing-bracket: one bracket of it left out. */
  reason: "unknown-placeholder" | "no-brackets" | "missing-bracket";
}

export interface ReidentifyResult {
  text: string;
  restored: Restored[];
  unrestored: Unrestored[];
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const PERSON_KINDS = new Set(["client", "caregiver", "family", "professional", "unlisted-name"]);
const POSSESSIVE = /[ \t]*['\u{2019}][sS]$/u;
/** More label text, then a closing bracket: what follows "[CLIENT" in "[CLIENT NAME]". */
const MORE_LABEL_THEN_CLOSE = "(?![\\p{L}\\p{N} '\\u{2019}_\\-#.]*\\\\?[\\]}>\\u{3011}\\u{00BB}])";

interface Replacement {
  start: number;
  end: number;
  value: string;
  placeholder: string;
  exact: boolean;
}

export function reidentify(input: string, map: RestoreMap): ReidentifyResult {
  const byKey = new Map(map.entries.map((e) => [labelKey(e.placeholder.slice(1, -1)), e]));
  /** Everything already decided: restored, or reported. Later passes never touch it. */
  const taken = new Spans<{ start: number; end: number }>(input.length);
  const replacements: Replacement[] = [];
  const unrestored: Unrestored[] = [];
  const restore = (start: number, end: number, value: string, placeholder: string, exact: boolean) => {
    // "[CLIENT INITIALS]." would end in two periods.
    const trimmed = value.endsWith(".") && input[end] === "." ? value.slice(0, -1) : value;
    replacements.push({ start, end, value: trimmed, placeholder, exact });
    taken.add({ start, end });
  };
  const report = (start: number, end: number, reason: Unrestored["reason"]) => {
    unrestored.push({ text: input.slice(start, end), start, end, reason });
    taken.add({ start, end });
  };
  const free = (start: number, end: number) => taken.overlapping(start, end).length === 0;

  // 1. Every bracketed stretch: a known placeholder is restored; one that looks like a placeholder is reported.
  for (const m of input.matchAll(BRACKETED)) {
    // "[[PHONE 1]" is a bracket of the text before a placeholder, not a doubled bracket: only "[[...]]" and "{{...}}" are doubled.
    const unpaired = (/^\[\[/u.test(m[0]) && !m[0].endsWith("]]")) || (/^\{\{/u.test(m[0]) && !m[0].endsWith("}}"));
    const start = m.index + (unpaired ? 1 : 0);
    const end = m.index + m[0].length;
    const inner = m[1].trim();
    const possessive = POSSESSIVE.exec(inner);
    const label = possessive ? inner.slice(0, possessive.index) : inner;
    const entry = byKey.get(labelKey(label));
    if (entry && (!possessive || PERSON_KINDS.has(entry.kind))) {
      restore(start, end, entry.value + (possessive ? possessive[0].trim().toLowerCase() : ""), entry.placeholder, input.slice(start, end) === entry.placeholder);
      continue;
    }
    const markdownLink = input[end] === "(" && m[0].startsWith("[");
    const firstWord = labelKey(inner).split(" ")[0];
    const allCaps = /\p{Lu}{2}/u.test(inner) && inner === inner.toUpperCase();
    if (!markdownLink && (allCaps || PLACEHOLDER_WORDS.includes(firstWord))) report(start, end, "unknown-placeholder");
  }

  if (byKey.size) {
    const entries = [...byKey.keys()].sort((a, b) => b.length - a.length);
    const flexible = (key: string) => key.split(" ").map(escape).join("[ \\t_\\-#]*");
    const known = entries.map(flexible).join("|");
    // A known label followed by a number or more label words ("CLIENT LAST NAME 2" when only [CLIENT LAST NAME] was sent) is another placeholder: never restored.
    const NOT_MORE = "(?![ \\t_\\-#]*\\d)(?![ \\t_\\-]+(?:name|last|full|first|initials|nickname|month|day|year)\\b)";
    // 2. One bracket missing ("[CLIENT went home", "went home CLIENT]"): reported, never restored. Only a placeholder in its brackets is restored.
    const reportFree = (start: number, end: number, reason: Unrestored["reason"]) => {
      if (free(start, end)) report(start, end, reason);
    };
    for (const m of input.matchAll(new RegExp(`\\\\?\\[[ \\t]*(${known})(?![\\p{L}\\p{N}])${NOT_MORE}${MORE_LABEL_THEN_CLOSE}`, "giu"))) reportFree(m.index, m.index + m[0].length, "missing-bracket");
    for (const m of input.matchAll(new RegExp(`(?<!\\[[\\p{L}\\p{N} '\\u{2019}_\\-#.]*)(?<![\\p{L}\\p{N}])(${known})[ \\t]*\\\\?\\]`, "giu"))) {
      reportFree(m.index, m.index + m[0].length, "missing-bracket");
    }
    // A bare label followed by a number or more label words: reported.
    for (const m of input.matchAll(new RegExp(`(?<![\\p{L}\\p{N}\\[])(?:${known})(?:[ \\t_\\-#]*\\d+|[ \\t_\\-]+(?:NAME|LAST|FULL|FIRST|INITIALS|NICKNAME|MONTH|DAY|YEAR)\\b)(?![\\p{L}\\p{N}\\]])`, "gu"))) {
      const start = m.index;
      const end = start + m[0].length;
      const key = labelKey(m[0]);
      // "CLIENT LAST" of "CLIENT LAST NAME" is not another placeholder: only one that no known label begins with.
      if (free(start, end) && !byKey.has(key) && !entries.some((k) => k.startsWith(`${key} `))) report(start, end, "unknown-placeholder");
    }
    // 3. No brackets, or parentheses, capitals only: reported, never restored ("CAREGIVER 1", "(CLIENT)"). Ordinary text can hold
    // these ("Date of birth (DOB)", a form's "CAREGIVER 1" heading). "DOB" alone is how forms label a date of birth: left as it is.
    for (const m of input.matchAll(new RegExp(`(?<![\\p{L}\\p{N}\\[])(${known})(?![\\p{L}\\p{N}\\]])${NOT_MORE}`, "gu"))) {
      const start = m.index;
      const end = start + m[0].length;
      if (!free(start, end) || labelKey(m[1]) === "DOB") continue;
      report(start, end, "no-brackets");
    }
  }

  replacements.sort((a, b) => a.start - b.start);
  let text = "";
  let at = 0;
  const counts = new Map<string, Restored>();
  for (const r of replacements) {
    text += input.slice(at, r.start) + r.value;
    at = r.end;
    const restored = counts.get(r.placeholder) ?? { placeholder: r.placeholder, count: 0, repaired: 0 };
    restored.count++;
    if (!r.exact) restored.repaired++;
    counts.set(r.placeholder, restored);
  }
  text += input.slice(at);
  return { text, restored: [...counts.values()], unrestored: unrestored.sort((a, b) => a.start - b.start) };
}
