/*
 * Her default thresholds for behavior definitions, from her questionnaire answers of
 * 2026-11-27, in our own words. By the owner's decision of 2026-11-28 they are the default
 * for every user: rules/behaviors.md lists them word for word (tests/rules.test.ts keeps the
 * two in step). The case map's check lets an AI-drafted definition, onset or offset take
 * each one only as the threshold it is: its number with its unit, in the place it belongs
 * (review of T2, finding 1). On the case map's screen she may write her own (D16): saved,
 * they are the case map's standing instructions, sent with every behaviors request, and each
 * of her lines takes the place of the default it changes, one threshold at a time (finding 3).
 * Her sections and the sources for this child come before both (finding 2): a quote vouches
 * for its own numbers.
 */

/** The fields of a behavior a threshold may appear in. */
export type ThresholdField = "definition" | "onset" | "offset";

/** A threshold's unit, normalized: seconds, feet, minutes, meters. */
export type ThresholdUnit = "s" | "ft" | "min" | "m";

export interface DefaultThreshold {
  /** What it is about, as her line names it before the colon; a line of hers with the same label replaces it. */
  label: string;
  /** The rest of the line. */
  text: string;
  /** Each number with its unit, the fields it belongs in, and whether only for a tantrum. */
  allows: ReadonlyArray<{ value: string; unit: ThresholdUnit; fields: readonly ThresholdField[]; tantrumOnly?: boolean }>;
}

const START: readonly ThresholdField[] = ["definition", "onset"];
const END: readonly ThresholdField[] = ["definition", "offset"];

export const DEFAULTS: readonly DefaultThreshold[] = [
  {
    label: "Following an instruction",
    text: "the child starts what was asked within 5 seconds; no start within 5 seconds counts as not following it.",
    allows: [{ value: "5", unit: "s", fields: START }],
  },
  {
    label: "Leaving the supervising adult (elopement)",
    text: "more than 6 feet away from the supervising adult without permission.",
    // Also the offset: an elopement ends when the child is back within the same distance (review round 2, finding 2).
    allows: [{ value: "6", unit: "ft", fields: ["definition", "onset", "offset"] }],
  },
  { label: "Off task", text: "3 seconds or more without attending to the task.", allows: [{ value: "3", unit: "s", fields: START }] },
  {
    label: "Repetitive movements (stereotypy)",
    text: "counted only when they interrupt a task, a transition or play with others for 3 seconds or longer; when they interrupt nothing, they are not counted.",
    allows: [{ value: "3", unit: "s", fields: START }],
  },
  {
    label: "End of an episode",
    text: "the behavior has stopped for 10 seconds in a row; for a tantrum, 30 seconds.",
    allows: [
      { value: "10", unit: "s", fields: END },
      { value: "30", unit: "s", fields: END, tantrumOnly: true },
    ],
  },
];

/** Her defaults as the rules list them, one line each. */
export const DEFAULT_THRESHOLDS: readonly string[] = DEFAULTS.map((threshold) => `${threshold.label}: ${threshold.text}`);

/** What the screen offers her to start from: her defaults. A line she changes takes the place of that default. */
export const THRESHOLDS_DRAFT = [
  "The thresholds I use in behavior definitions, unless one of my sections or a source gives another for this child, adapted to the child's age and level of functioning:",
  ...DEFAULT_THRESHOLDS.map((line) => `- ${line}`),
].join("\n");

const PAIR = /(\d+(?:\.\d+)?)\s*(?:-\s*)?(?:(?:consecutive|full|straight)\s+)?(seconds?|secs?|s\b|feet|foot|ft\b|minutes?|mins?\b|meters?|metres?|m\b)/giu;

function unitOf(word: string): ThresholdUnit {
  const w = word.toLowerCase();
  if (w.startsWith("f")) return "ft";
  if (w.startsWith("mi")) return "min";
  if (w.startsWith("m")) return "m";
  return "s";
}

/** Every number with a threshold unit in a text ("5 seconds", "6 ft", "a 10-second"), with where it is. */
export function thresholdPairs(text: string): Array<{ value: string; unit: ThresholdUnit; index: number; length: number }> {
  return [...text.matchAll(PAIR)].map((match) => ({ value: String(Number(match[1])), unit: unitOf(match[2]), index: match.index ?? 0, length: match[0].length }));
}

const labelOf = (line: string) => {
  const match = /^\s*(?:[-*•]\s*)?([^:]+):/u.exec(line);
  return match ? match[1].trim().toLowerCase() : null;
};

/**
 * The thresholds an AI-drafted value may state in a field: her defaults, each in its place,
 * except those a line of her standing instructions replaces (same label); her lines' own
 * numbers with their units, in the replaced default's fields, or in any of the three when the
 * line replaces none.
 */
export function allowedThresholds(instructions: string, field: ThresholdField, tantrum: boolean): Array<{ value: string; unit: ThresholdUnit }> {
  const lines = instructions.split(/\r?\n/u).filter((line) => line.trim() !== "");
  const replaced = new Set<string>();
  const out: Array<{ value: string; unit: ThresholdUnit }> = [];
  for (const line of lines) {
    const label = labelOf(line);
    const threshold = label ? DEFAULTS.find((candidate) => candidate.label.toLowerCase() === label) : undefined;
    if (threshold) replaced.add(threshold.label);
    const fields = threshold ? new Set(threshold.allows.flatMap((allow) => allow.fields)) : new Set<ThresholdField>(["definition", "onset", "offset"]);
    // A clause (split on ";" or a sentence's end) that names a tantrum is for a tantrum only, as her
    // default's 30 s, in whatever order she writes it (review round 2, finding 1; check 3).
    if (!fields.has(field)) continue;
    for (const clause of line.split(/;|\.(?=\s|$)/u)) {
      if (!tantrum && /tantrum/iu.test(clause)) continue;
      out.push(...thresholdPairs(clause).map(({ value, unit }) => ({ value, unit })));
    }
  }
  for (const threshold of DEFAULTS) {
    if (replaced.has(threshold.label)) continue;
    for (const allow of threshold.allows) if (allow.fields.includes(field) && (!allow.tantrumOnly || tantrum)) out.push({ value: allow.value, unit: allow.unit });
  }
  return out;
}

/** A text without the thresholds it may state there: what is left is checked against its quotes. */
export function withoutAllowedThresholds(text: string, allowed: ReadonlyArray<{ value: string; unit: ThresholdUnit }>): string {
  let out = "";
  let at = 0;
  for (const pair of thresholdPairs(text)) {
    if (!allowed.some((allow) => allow.value === pair.value && allow.unit === pair.unit)) continue;
    out += text.slice(at, pair.index) + " ";
    at = pair.index + pair.length;
  }
  return out + text.slice(at);
}
