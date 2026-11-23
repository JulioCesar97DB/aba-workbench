/*
 * reidentify(text, map): the AI's text with the placeholders put back, on the
 * clinician's computer. It accepts what models do to placeholders:
 *   [Client], [client]          another case
 *   [CLIENT'S], [CLIENT]'s      a possessive inside or after the brackets (people only)
 *   [CAREGIVER_1], [CAREGIVER1] another separator, or none
 *   [[CLIENT]], {CLIENT}, <CLIENT>, \[CLIENT\]  doubled, other or escaped brackets
 *   (CLIENT)                    parentheses, in capitals only (so "(client)" in prose is left alone)
 *   [CLIENT, CLIENT]            one bracket missing, when no more label text follows before a bracket
 *   CAREGIVER 1                 no brackets, in capitals, when the label has a number or several words
 * It never restores part of a bracket: "[CLIENT NAME]", "[CLIENT 1]" or "[DOB MONTH AND
 * YEAR]" when only [CLIENT] and [DOB] were sent stay as they are and are reported.
 * Whatever looks like a placeholder and cannot be restored is reported, never dropped:
 * an unknown one ([CAREGIVER 3] when there are two, [INSERT DATE], [Client's name]) and
 * a lone capitalized label with no brackets (CLIENT), which could be a heading. "DOB"
 * alone is left as it is: it is how forms label a date of birth.
 */
import type { RestoreMap } from "./deidentify.ts";
import { PLACEHOLDER_WORDS } from "./placeholders.ts";
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
  reason: "unknown-placeholder" | "no-brackets";
}

export interface ReidentifyResult {
  text: string;
  restored: Restored[];
  unrestored: Unrestored[];
}

/** "Caregiver_1", "caregiver-1" and "CAREGIVER1" all read "CAREGIVER 1". */
function labelKey(label: string): string {
  return label
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toUpperCase()
    .replace(/(\p{L})(\p{N})/gu, "$1 $2")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const PERSON_KINDS = new Set(["client", "caregiver", "family", "professional", "unlisted-name"]);
const OPEN = "(?:\\\\?\\[){1,2}|\\{{1,2}|<|\u{3010}|\u{00AB}";
const CLOSE = "(?:\\\\?\\]){1,2}|\\}{1,2}|>|\u{3011}|\u{00BB}";
/** Any bracketed stretch of up to 60 characters on one line, with no other bracket inside. */
const BRACKETED = new RegExp(`(?:${OPEN})([^\\[\\]{}<>\\n\\u{3010}\\u{3011}\\u{00AB}\\u{00BB}]{1,60}?)(?:${CLOSE})`, "gu");
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
    const start = m.index;
    const end = start + m[0].length;
    const inner = m[1].trim();
    const possessive = POSSESSIVE.exec(inner);
    const label = possessive ? inner.slice(0, possessive.index) : inner;
    const entry = byKey.get(labelKey(label));
    if (entry && (!possessive || PERSON_KINDS.has(entry.kind))) {
      restore(start, end, entry.value + (possessive ? possessive[0].trim().toLowerCase() : ""), entry.placeholder, m[0] === entry.placeholder);
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
    const NOT_MORE = "(?![ \\t_\\-#]*\\d)(?![ \\t_\\-]+(?:name|last|full|first|initials|month|day|year)\\b)";
    const add = (start: number, end: number, label: string) => {
      const entry = byKey.get(labelKey(label));
      if (entry && free(start, end)) restore(start, end, entry.value, entry.placeholder, false);
    };
    // 2. One bracket missing: "[CLIENT" or "CLIENT]", never when more label text runs to a bracket ("[CLIENT NAME]").
    for (const m of input.matchAll(new RegExp(`\\\\?\\[[ \\t]*(${known})(?![\\p{L}\\p{N}])${NOT_MORE}${MORE_LABEL_THEN_CLOSE}`, "giu"))) add(m.index, m.index + m[0].length, m[1]);
    for (const m of input.matchAll(new RegExp(`(?<!\\[[\\p{L}\\p{N} '\\u{2019}_\\-#.]*)(?<![\\p{L}\\p{N}])(${known})[ \\t]*\\\\?\\]`, "giu"))) {
      add(m.index, m.index + m[0].length, m[1]);
    }
    // 3. Parentheses, capitals only.
    for (const m of input.matchAll(new RegExp(`\\((${known})\\)`, "gu"))) add(m.index, m.index + m[0].length, m[1]);
    // A bare label followed by a number or more label words: reported.
    for (const m of input.matchAll(new RegExp(`(?<![\\p{L}\\p{N}\\[])(?:${known})(?:[ \\t_\\-#]*\\d+|[ \\t_\\-]+(?:NAME|LAST|FULL|FIRST|INITIALS|MONTH|DAY|YEAR)\\b)(?![\\p{L}\\p{N}\\]])`, "gu"))) {
      const start = m.index;
      const end = start + m[0].length;
      const key = labelKey(m[0]);
      // "CLIENT LAST" of "CLIENT LAST NAME" is not another placeholder: only one that no known label begins with.
      if (free(start, end) && !byKey.has(key) && !entries.some((k) => k.startsWith(`${key} `))) report(start, end, "unknown-placeholder");
    }
    // 4. No brackets, capitals only: restored when unmistakable (a number or several words), reported otherwise.
    for (const m of input.matchAll(new RegExp(`(?<![\\p{L}\\p{N}\\[])(${known})(?![\\p{L}\\p{N}\\]])${NOT_MORE}`, "gu"))) {
      const start = m.index;
      const end = start + m[0].length;
      if (!free(start, end)) continue;
      const key = labelKey(m[1]);
      if (/\s|\d/u.test(key)) add(start, end, m[1]);
      // "DOB" alone is how forms label a date of birth, not a lost placeholder.
      else if (key !== "DOB") report(start, end, "no-brackets");
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
