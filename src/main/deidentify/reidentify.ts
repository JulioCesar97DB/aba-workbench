/*
 * reidentify(text, map): the AI's text with the placeholders put back, on the
 * clinician's computer. It accepts what models do to placeholders:
 *   [Client], [client]          another case
 *   [CLIENT'S], [CLIENT]'s      a possessive inside or after the brackets
 *   [CAREGIVER_1], [CAREGIVER1] another separator, or none
 *   [[CLIENT]], {CLIENT}, <CLIENT>, \[CLIENT\]  doubled, other or escaped brackets
 *   (CLIENT)                    parentheses, in capitals only (so "(client)" in prose is left alone)
 *   [CLIENT, CLIENT]            one bracket missing
 *   CAREGIVER 1                 no brackets, in capitals, when the label has a number or several words
 * Whatever looks like a placeholder and cannot be restored is reported, never dropped:
 * an unknown one ([CAREGIVER 3] when there are two, [INSERT DATE]) and a lone
 * capitalized label with no brackets (CLIENT), which could be a heading. "DOB" alone is
 * left as it is: it is how forms label a date of birth.
 */
import type { RestoreMap } from "./deidentify.ts";
import { PLACEHOLDER_WORDS } from "./placeholders.ts";

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

const OPEN = "(?:\\\\?\\[){1,2}|\\{{1,2}|<|\u{3010}|\u{00AB}";
const CLOSE = "(?:\\\\?\\]){1,2}|\\}{1,2}|>|\u{3011}|\u{00BB}";
const POSSESSIVE = "(['\u{2019}][sS])";
const BRACKETED = new RegExp(`(?:${OPEN})[ \\t]*(\\p{L}[\\p{L}\\p{N} _\\-#.]*?)[ \\t]*${POSSESSIVE}?[ \\t]*(?:${CLOSE})`, "gu");

interface Replacement {
  start: number;
  end: number;
  value: string;
  placeholder: string;
  exact: boolean;
}

export function reidentify(input: string, map: RestoreMap): ReidentifyResult {
  const byKey = new Map(map.entries.map((e) => [labelKey(e.placeholder.slice(1, -1)), e]));
  const replacements: Replacement[] = [];
  const unrestored: Unrestored[] = [];
  /** Bracketed but unknown: reported at the end unless a later pass restores a label inside ("[CLIENT and CAREGIVER 1]"). */
  const unknown: Unrestored[] = [];
  const taken = (start: number, end: number) => replacements.some((r) => r.start < end && start < r.end) || unrestored.some((u) => u.start < end && start < u.end);

  // 1. Bracketed, in any case, with any separator.
  for (const m of input.matchAll(BRACKETED)) {
    const entry = byKey.get(labelKey(m[1]));
    const start = m.index;
    const end = start + m[0].length;
    if (entry) {
      replacements.push({ start, end, value: entry.value + (m[2] ? "'s" : ""), placeholder: entry.placeholder, exact: m[0] === entry.placeholder });
      continue;
    }
    const firstWord = labelKey(m[1]).split(" ")[0];
    const allCaps = /\p{Lu}{2}/u.test(m[1]) && m[1] === m[1].toUpperCase();
    const markdownLink = input[end] === "(" && m[0].startsWith("[");
    if (!markdownLink && (allCaps || PLACEHOLDER_WORDS.includes(firstWord))) unknown.push({ text: m[0], start, end, reason: "unknown-placeholder" });
  }

  if (byKey.size) {
    const entries = [...byKey.entries()].sort((a, b) => b[0].length - a[0].length);
    const flexible = (key: string) => key.split(" ").map(escape).join("[ \\t_\\-#]*");
    const known = entries.map(([key]) => flexible(key)).join("|");
    const lookup = (label: string) => byKey.get(labelKey(label));
    const add = (start: number, end: number, label: string) => {
      const entry = lookup(label);
      if (entry && !taken(start, end)) replacements.push({ start, end, value: entry.value, placeholder: entry.placeholder, exact: false });
    };
    // 2. One bracket missing: "[CLIENT" or "CLIENT]".
    for (const m of input.matchAll(new RegExp(`\\\\?\\[[ \\t]*(${known})(?![\\p{L}\\p{N}])`, "giu"))) add(m.index, m.index + m[0].length, m[1]);
    for (const m of input.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])(${known})[ \\t]*\\\\?\\]`, "giu"))) add(m.index, m.index + m[0].length, m[1]);
    // 3. Parentheses, capitals only.
    for (const m of input.matchAll(new RegExp(`\\((${known})\\)`, "gu"))) add(m.index, m.index + m[0].length, m[1]);
    // 4. No brackets, capitals only: restored when unmistakable (a number or several words), reported otherwise.
    for (const m of input.matchAll(new RegExp(`(?<![\\p{L}\\p{N}\\[])(${known})(?![\\p{L}\\p{N}\\]])`, "gu"))) {
      const start = m.index;
      const end = start + m[0].length;
      if (taken(start, end)) continue;
      const key = labelKey(m[1]);
      if (/\s|\d/u.test(key)) add(start, end, m[1]);
      // "DOB" alone is how forms label a date of birth, not a lost placeholder.
      else if (key !== "DOB") unrestored.push({ text: m[0], start, end, reason: "no-brackets" });
    }
  }

  for (const u of unknown) if (!replacements.some((r) => r.start < u.end && u.start < r.end)) unrestored.push(u);
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
