import {
  BARRIER_TAGS,
  EVIDENCE_TOOLS,
  FUNCTION_NAMES,
  INTENSITIES,
  ITEM_STATUSES,
  MAP_TEXT_LIMITS,
  MEASURES,
  OPEN_ITEM_KINDS,
  SETTING_EVIDENCE,
  SETTING_KINDS,
  STRENGTH_KINDS,
  type Claim,
  type ClaimInput,
  type MapCollection,
  type MapPartId,
} from "../../../shared/case-map.ts";

/*
 * What each part of the case map shows and lets her type, field by field, and how an item
 * as saved turns into what the screen sends back: values and [CHECK]s only (where each
 * value came from is the main process's to record). One description per part, so every
 * part is drawn by the same form (CaseMapFields.tsx).
 */

const T = MAP_TEXT_LIMITS;

/** Lists whose option names are clinical terms, English on both screens. */
export type TermList = "functions" | "barriers" | "measures" | "tools" | "intensities";
/** Lists whose option names are translated. */
export type WordList = "settingKinds" | "settingEvidence" | "strengthKinds" | "paid" | "openItemKinds" | "statuses";

export type ColumnSpec = { key: string; kind: "text"; max: number } | { key: string; kind: "choice"; options: readonly string[]; words: WordList | TermList };

export type FieldSpec =
  /** One value with where it came from. */
  | { key: string; kind: "text"; max: number; multiline?: boolean }
  /** One value from a list of choices, with where it came from. */
  | { key: string; kind: "choice"; options: readonly string[]; words: WordList | TermList }
  /** Several values, one per line, each with where it came from. */
  | { key: string; kind: "list"; max: number }
  /** Rows of values (scores, observations, other services). */
  | { key: string; kind: "records"; columns: ColumnSpec[] }
  /** Several tags from a fixed list, as one value (barriers). */
  | { key: string; kind: "tags"; options: readonly string[]; words: TermList }
  /** Ids of other items of the map (the settings of a behavior, the behaviors of a risk or a group). */
  | { key: string; kind: "ids"; from: "behaviors" | "settings" }
  /** A behavior's hypothesized function, with its evidence. */
  | { key: string; kind: "function" }
  /** A section of the 22-section template, by number. */
  | { key: string; kind: "section" }
  /** Text with no provenance of its own (a group's reason, an open item's text). */
  | { key: string; kind: "plain"; max: number; multiline?: boolean }
  | { key: string; kind: "plainChoice"; options: readonly string[]; words: WordList | TermList; optional: boolean }
  /** Fields inside one object (a behavior's baseline). */
  | { key: string; kind: "nested"; fields: FieldSpec[] };

const text = (key: string, max: number = T.text, multiline = false): FieldSpec => ({ key, kind: "text", max, multiline });
const long = (key: string, max: number = T.text): FieldSpec => text(key, max, true);
const list = (key: string, max: number = T.text): FieldSpec => ({ key, kind: "list", max });

export const ITEM_FIELDS: Record<MapPartId, FieldSpec[]> = {
  client: [
    long("diagnosis"),
    text("severityLevel", T.name),
    text("evaluator", T.name),
    text("evaluationDate", T.short),
    text("age", T.name),
    list("languages", T.name),
    list("medications"),
    text("school", T.name),
    text("grade", T.short),
    long("schedule"),
    long("iep"),
    {
      key: "otherServices",
      kind: "records",
      columns: [
        { key: "name", kind: "text", max: T.name },
        { key: "provider", kind: "text", max: T.name },
        { key: "paid", kind: "choice", options: ["paid", "not-paid"], words: "paid" },
      ],
    },
  ],
  caregivers: [text("role", T.name), text("language", T.name), long("availability"), long("participation"), long("limits"), long("mitigation")],
  settings: [
    text("name", T.name),
    { key: "kind", kind: "choice", options: SETTING_KINDS, words: "settingKinds" },
    { key: "evidence", kind: "choice", options: SETTING_EVIDENCE, words: "settingEvidence" },
    text("by", T.name),
    long("dates"),
  ],
  deficits: [
    text("area", T.name),
    {
      key: "scores",
      kind: "records",
      columns: [
        { key: "instrument", kind: "text", max: T.name },
        { key: "scale", kind: "text", max: T.name },
        { key: "score", kind: "text", max: T.short },
        { key: "percentile", kind: "text", max: T.short },
        { key: "level", kind: "text", max: T.name },
      ],
    },
    list("evidence"),
    long("impact"),
  ],
  strengths: [long("text"), { key: "kind", kind: "choice", options: STRENGTH_KINDS, words: "strengthKinds" }, text("setting", T.name)],
  behaviors: [
    text("name", T.name),
    list("topographies"),
    { key: "measure", kind: "choice", options: MEASURES, words: "measures" },
    long("definition", T.definition),
    long("onset"),
    long("offset"),
    list("examples"),
    list("nonExamples"),
    {
      key: "baseline",
      kind: "nested",
      fields: [
        {
          key: "observations",
          kind: "records",
          columns: [
            { key: "date", kind: "text", max: T.short },
            { key: "setting", kind: "text", max: T.name },
            { key: "length", kind: "text", max: T.short },
            { key: "minutes", kind: "text", max: T.short },
            { key: "value", kind: "text", max: T.short },
          ],
        },
        list("other"),
      ],
    },
    { key: "intensity", kind: "choice", options: INTENSITIES, words: "intensities" },
    { key: "settingIds", kind: "ids", from: "settings" },
    list("antecedents"),
    list("consequences"),
    { key: "function", kind: "function" },
    { key: "barriers", kind: "tags", options: BARRIER_TAGS, words: "barriers" },
    list("risks"),
  ],
  risks: [{ key: "behaviorIds", kind: "ids", from: "behaviors" }, long("what"), list("evidence"), text("level", T.name)],
  facts: [long("text"), { key: "homeSection", kind: "section" }],
  openItems: [
    { key: "kind", kind: "plainChoice", options: OPEN_ITEM_KINDS, words: "openItemKinds", optional: false },
    { key: "text", kind: "plain", max: T.text, multiline: true },
    { key: "homeSection", kind: "section" },
    { key: "status", kind: "plainChoice", options: ITEM_STATUSES, words: "statuses", optional: false },
  ],
  // The report on her sections is the AI's (Read what I have); she only marks each item.
  report: [{ key: "status", kind: "plainChoice", options: ITEM_STATUSES, words: "statuses", optional: false }],
};

export const GROUP_FIELDS: FieldSpec[] = [
  { key: "nature", kind: "plain", max: T.name },
  { key: "behaviorIds", kind: "ids", from: "behaviors" },
  { key: "function", kind: "plainChoice", options: FUNCTION_NAMES, words: "functions", optional: true },
  { key: "measure", kind: "plainChoice", options: MEASURES, words: "measures", optional: true },
  { key: "reason", kind: "plain", max: T.text, multiline: true },
];

export function fieldsOf(part: MapPartId, collection: MapCollection): FieldSpec[] {
  return collection === "groups" ? GROUP_FIELDS : ITEM_FIELDS[part];
}

/** The options of each list, as the screen names them. */
export const EVIDENCE_TOOL_OPTIONS = EVIDENCE_TOOLS;
export const FUNCTION_OPTIONS = FUNCTION_NAMES;

/** Which field names an item in the list (its first text). */
export const TITLE_FIELD: Record<MapPartId, string> & { groups: string } = {
  client: "diagnosis",
  caregivers: "role",
  settings: "name",
  deficits: "area",
  strengths: "text",
  behaviors: "name",
  risks: "what",
  facts: "text",
  openItems: "text",
  report: "text",
  groups: "nature",
};

/* From an item as saved to what the screen sends: values and [CHECK]s, only for the fields the form shows. */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function claimIn(claim: unknown): ClaimInput | null {
  if (!isRecord(claim) || typeof claim.value !== "string") return null;
  return { value: claim.value, check: typeof claim.check === "string" ? claim.check : null };
}

function tagsIn(claim: unknown): ClaimInput<string[]> | null {
  if (!isRecord(claim) || !Array.isArray(claim.value)) return null;
  return { value: claim.value.filter((tag): tag is string => typeof tag === "string"), check: typeof claim.check === "string" ? claim.check : null };
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function fieldIn(spec: FieldSpec, value: unknown): unknown {
  switch (spec.kind) {
    case "text":
    case "choice":
      return claimIn(value);
    case "list":
      return (Array.isArray(value) ? value.map(claimIn).filter((claim) => claim !== null) : []);
    case "records":
      return (Array.isArray(value) ? value : []).map((row) => Object.fromEntries(spec.columns.map((column) => [column.key, claimIn(isRecord(row) ? row[column.key] : null)])));
    case "tags":
      return tagsIn(value);
    case "ids":
      return strings(value);
    case "function": {
      const fn = isRecord(value) ? value : {};
      return {
        primary: strings(fn.primary),
        secondary: strings(fn.secondary),
        evidence: (Array.isArray(fn.evidence) ? fn.evidence : []).filter(isRecord).map((entry) => ({
          tool: typeof entry.tool === "string" ? entry.tool : "observation",
          respondent: typeof entry.respondent === "string" ? entry.respondent : null,
          result: claimIn(entry.result),
          supports: strings(entry.supports),
        })),
        reasoning: typeof fn.reasoning === "string" ? fn.reasoning : null,
        check: typeof fn.check === "string" ? fn.check : null,
      };
    }
    case "section":
      return typeof value === "number" ? value : null;
    case "plain":
      return typeof value === "string" ? value : "";
    case "plainChoice":
      return typeof value === "string" ? value : spec.optional ? null : spec.options[0];
    case "nested": {
      const inner = isRecord(value) ? value : {};
      return Object.fromEntries(spec.fields.map((field) => [field.key, fieldIn(field, inner[field.key])]));
    }
  }
}

/** What the form starts from: the item's fields as saved, as she would send them back unchanged. */
export function itemInput(fields: FieldSpec[], item: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(fields.map((spec) => [spec.key, fieldIn(spec, item[spec.key])]));
}

/** A claim as saved, when the value she has in the form is still the one saved: where it came from is then known. */
export function savedClaim(saved: unknown, value: unknown): Claim<unknown> | null {
  if (!isRecord(saved) || !Array.isArray(saved.refs) || typeof saved.origin !== "string") return null;
  return JSON.stringify(saved.value) === JSON.stringify(value) ? (saved as unknown as Claim<unknown>) : null;
}

/** In a list of claims as saved, the one with this value (first not yet used), for a line of the form. */
export function savedInList(saved: unknown, values: readonly unknown[], index: number): Claim<unknown> | null {
  if (!Array.isArray(saved)) return null;
  const used = new Set<number>();
  let found: Claim<unknown> | null = null;
  for (let line = 0; line <= index; line++) {
    const at = saved.findIndex((claim, position) => !used.has(position) && savedClaim(claim, values[line]) !== null);
    if (at !== -1) used.add(at);
    if (line === index) found = at === -1 ? null : (saved[at] as Claim<unknown>);
  }
  return found;
}

/** An item's title in the list: the first words of its naming field, or null when empty. */
export function itemTitle(part: MapPartId | "groups", item: Record<string, unknown>): string | null {
  const field = item[TITLE_FIELD[part]];
  const value = typeof field === "string" ? field : isRecord(field) && typeof field.value === "string" ? field.value : "";
  const line = value.replace(/\s+/g, " ").trim();
  return line === "" ? null : line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

/** The texts of the [CHECK]s an item holds, anywhere in it, in field order. */
export function checksOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(checksOf);
  if (!isRecord(value)) return [];
  const own = typeof value.check === "string" && value.check.trim() !== "" ? [value.check] : [];
  return [...own, ...Object.entries(value).flatMap(([key, entry]) => (key === "check" ? [] : checksOf(entry)))];
}

/** How many [CHECK]s an item holds, anywhere in it. */
export function countChecks(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((sum: number, entry) => sum + countChecks(entry), 0);
  if (!isRecord(value)) return 0;
  let count = typeof value.check === "string" && value.check.trim() !== "" ? 1 : 0;
  for (const [key, entry] of Object.entries(value)) if (key !== "check") count += countChecks(entry);
  return count;
}
