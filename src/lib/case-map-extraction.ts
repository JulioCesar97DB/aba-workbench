import { z } from "zod";
import { BARRIER_TAGS, EVIDENCE_TOOLS, FUNCTION_NAMES, MAP_PART_LIMITS, MAP_TEXT_LIMITS, MAX_MAP_GROUPS, MAX_MAP_LIST, MAX_MAP_REFS, MEASURES, OPEN_ITEM_KINDS, REPORT_ITEM_KINDS, SETTING_EVIDENCE, SETTING_KINDS, STRENGTH_KINDS } from "../shared/case-map.ts";

/*
 * The AI's drafts of the case map (step 1, pull request 2; owner's decisions D4, D12 to
 * D14, D32): the two requests, the JSON schema each answer must follow, its check with
 * Zod, and the code checks that follow (every quote found word for word in what it cites,
 * every number in one of its quotes, every link between items known).
 *
 * One schema per request, valid on both providers' structured outputs: every property
 * required, no other property allowed, enums for every fixed list, no length or number
 * limits (Claude does not take them; Zod checks them here), no recursion, and no union at
 * all (review round 1, B3): Claude takes at most 16 parameters with anyOf or a type array
 * across a request's strict schemas. So nothing is nullable on the wire: an absent value is
 * a claim with an empty value ("" and no refs), an absent text is "", an absent home
 * section is 0, and a list that may name nothing has "none". Zod turns each back into null,
 * so the stored shape is the same. The same shape is asked for as plain JSON when a route
 * refuses the schema.
 */

export { MAP_REQUEST_KINDS, type MapRequestKind } from "../shared/case-map.ts";
import type { MapRequestKind } from "../shared/case-map.ts";

/** The parts each request returns. Risks name behaviors, so they come with the behaviors. */
export const PARTS_OF_REQUEST = {
  "map-facts": ["client", "caregivers", "settings", "deficits", "strengths", "facts", "openItems", "report"],
  "map-behaviors": ["behaviors", "risks", "openItems"],
} as const;

/** The names the schemas are sent under. */
export const MAP_SCHEMA_NAMES: Record<MapRequestKind, string> = { "map-facts": "case_map_facts", "map-behaviors": "case_map_behaviors" };

/** How the answer is asked for: enforced by the provider's JSON schema, or plain JSON in the text. */
export type MapAnswerFormat = "json-schema" | "plain-json";

/* The JSON schema */

type Schema = Record<string, unknown>;
const str: Schema = { type: "string" };
const int: Schema = { type: "integer" };
const list = (items: Schema): Schema => ({ type: "array", items });
const choice = (values: readonly string[]): Schema => ({ type: "string", enum: [...values] });
function object(properties: Record<string, Schema>): Schema {
  return { type: "object", additionalProperties: false, required: Object.keys(properties), properties };
}

const SERVICE_PAID = ["paid", "not-paid"] as const;
const ORIGIN_VALUES = ["extracted", "her", "ai-drafted", "hypothesis", "proposed"] as const;
const REF_KINDS = ["source", "section", "note"] as const;
/** What a list that may name nothing says instead of null. */
const NONE = "none";

const refSchema = object({ kind: choice(REF_KINDS), id: str, quote: str });
/** A claim; absent when its value is "" (and its refs empty). Its check is "" when there is none. */
const claimSchema = object({ value: str, refs: list(refSchema), origin: choice(ORIGIN_VALUES), check: str });
/** A claim whose value is one of a fixed list ("" when absent): the list is in the schema, so a strict route cannot answer anything else. */
const choiceClaim = (values: readonly string[]): Schema => object({ value: choice(["", ...values]), refs: list(refSchema), origin: choice(ORIGIN_VALUES), check: str });
const claims = list(claimSchema);
/**
 * A score row (owner's decision, 2026-11-23, case map speed): one claim on the wire, with
 * the instrument, scale, score, percentile and level as the score report prints them,
 * under the quotes of that row. Stored as today's five claims, each with the row's refs.
 */
const scoreRowSchema = object({ instrument: str, scale: str, score: str, percentile: str, level: str, refs: list(refSchema), origin: choice(ORIGIN_VALUES), check: str });
const openItemSchema = object({ kind: choice(OPEN_ITEM_KINDS), text: str, homeSection: int });

const factsSchema = object({
  client: object({
    age: claimSchema,
    diagnosis: claimSchema,
    severityLevel: claimSchema,
    evaluator: claimSchema,
    evaluationDate: claimSchema,
    medications: claims,
    school: claimSchema,
    grade: claimSchema,
    schedule: claimSchema,
    iep: claimSchema,
    otherServices: list(object({ name: claimSchema, provider: claimSchema, paid: choiceClaim(SERVICE_PAID) })),
    languages: claims,
  }),
  caregivers: list(object({ key: str, role: claimSchema, language: claimSchema, availability: claimSchema, participation: claimSchema, limits: claimSchema, mitigation: claimSchema })),
  settings: list(object({ key: str, name: claimSchema, kind: choiceClaim(SETTING_KINDS), evidence: choiceClaim(SETTING_EVIDENCE), by: claimSchema, dates: claimSchema })),
  deficits: list(
    object({
      key: str,
      area: claimSchema,
      scores: list(scoreRowSchema),
      evidence: claims,
      impact: claimSchema,
    }),
  ),
  strengths: list(object({ key: str, text: claimSchema, kind: choiceClaim(STRENGTH_KINDS), setting: claimSchema })),
  facts: list(object({ key: str, text: claimSchema, homeSection: int })),
  openItems: list(openItemSchema),
  report: list(object({ kind: choice(REPORT_ITEM_KINDS), text: str, sections: list(str), refs: list(refSchema) })),
});

const behaviorsSchema = object({
  behaviors: list(
    object({
      key: str,
      name: claimSchema,
      topographies: claims,
      measure: choiceClaim(MEASURES),
      definition: claimSchema,
      onset: claimSchema,
      offset: claimSchema,
      examples: claims,
      nonExamples: claims,
      // The observation's length as the notes write it ("3:30 to 5:30 p.m."): the app computes the minutes (review round 1, S7).
      baseline: object({ observations: list(object({ date: claimSchema, setting: claimSchema, length: claimSchema, value: claimSchema })), other: claims }),
      settingIds: list(str),
      antecedents: claims,
      consequences: claims,
      function: object({
        primary: list(choice(FUNCTION_NAMES)),
        secondary: list(choice(FUNCTION_NAMES)),
        evidence: list(object({ tool: choice(EVIDENCE_TOOLS), respondent: str, result: claimSchema, supports: list(choice(FUNCTION_NAMES)) })),
        reasoning: str,
        check: str,
      }),
      barriers: list(choice(BARRIER_TAGS)),
      risks: claims,
    }),
  ),
  groups: list(object({ key: str, behaviorKeys: list(str), nature: str, function: choice([...FUNCTION_NAMES, NONE]), measure: choice([...MEASURES, NONE]), reason: str })),
  risks: list(object({ key: str, behaviorKeys: list(str), what: claimSchema, evidence: claims, level: claimSchema })),
  openItems: list(openItemSchema),
});

export function mapAnswerSchema(kind: MapRequestKind): Schema {
  return kind === "map-facts" ? factsSchema : behaviorsSchema;
}

/*
 * The same shape, checked with Zod, with the map's limits (D6). Absent forms become null;
 * null itself is accepted too (plain JSON).
 *
 * The length of a value, a quote or a note is not checked by Zod (owner's decision,
 * 2026-11-23, case map speed): one value over its limit would make the whole answer
 * unreadable and cost a repair of the whole answer. Each claim keeps its field's limit
 * (`limitOf`), and the code checks make a value over it that value's own problem, which a
 * repair of that value alone fixes. What is still too long after the repair is cut to fit
 * when it is stored, with a [CHECK] (src/main/case-map-draft.ts). Keys, ids and how many
 * items a list holds stay Zod's.
 */

const T = MAP_TEXT_LIMITS;
/** The longest a value of each field may be, by the claim the answer was read into. */
const LIMITS = new WeakMap<object, number>();
/** The longest a claim's value may be, as its field allows (T.text when unknown). */
export function limitOf(claim: object): number {
  return LIMITS.get(claim) ?? T.text;
}
/** The limits of a score row's fields, and of the texts that are not claims. */
export const SCORE_LIMITS = { instrument: T.name, scale: T.name, score: T.short, percentile: T.short, level: T.name } as const;
export const TEXT_LIMITS = { respondent: T.name, reasoning: T.text, check: T.text, nature: T.name, reason: T.text, report: T.text, openItem: T.text, quote: T.quote } as const;
const RefZ = z.strictObject({ kind: z.enum(REF_KINDS), id: z.string().max(64), quote: z.string() });
const WireClaimZ = z.strictObject({ value: z.string(), refs: z.array(RefZ).max(MAX_MAP_REFS), origin: z.enum(ORIGIN_VALUES), check: z.string().nullable() });
type WireClaim = z.infer<typeof WireClaimZ>;
const absent = (claim: WireClaim | null): claim is null => claim === null || claim.value.trim() === "";
const finish = (claim: WireClaim, max: number = T.text) => {
  const out = { ...claim, check: claim.check !== null && claim.check.trim() !== "" ? claim.check : null };
  LIMITS.set(out, max);
  return out;
};
const maybe = (max: number = T.text) => WireClaimZ.nullable().transform((claim) => (absent(claim) ? null : finish(claim, max)));
const ClaimsZ = (max: number = T.text) =>
  z
    .array(WireClaimZ)
    .max(MAX_MAP_LIST)
    .transform((values) => values.filter((claim) => !absent(claim)).map((claim) => finish(claim, max)));
const TextOrNullZ = z
  .string()
  .nullable()
  .transform((text) => (text !== null && text.trim() !== "" ? text : null));
const HomeSectionZ = z
  .int()
  .min(0)
  .max(22)
  .nullable()
  .transform((section) => (section ? section : null));
const orNone = <const T extends readonly [string, ...string[]]>(values: T) =>
  z
    .enum([...values, NONE] as [string, ...string[]])
    .nullable()
    .transform((value) => (value === null || value === NONE ? null : (value as T[number])));
const KeyZ = z.string().min(1).max(40);
/** The fields of a score row, in the order the report prints them. */
export const SCORE_FIELDS = ["instrument", "scale", "score", "percentile", "level"] as const;
/**
 * A score row: its five fields, and a `value` that joins them, so the row is one claim to
 * the checks (every number of every field is checked against the row's quotes) and to the
 * repair's merge. A row with no field at all is absent.
 */
const ScoreRowZ = z
  .strictObject({
    instrument: TextOrNullZ,
    scale: TextOrNullZ,
    score: TextOrNullZ,
    percentile: TextOrNullZ,
    level: TextOrNullZ,
    refs: z.array(RefZ).max(MAX_MAP_REFS),
    origin: z.enum(ORIGIN_VALUES),
    check: z.string().nullable(),
  })
  .transform((row) => ({
    value: rowValue(row),
    refs: row.refs,
    origin: row.origin,
    check: row.check !== null && row.check.trim() !== "" ? row.check : null,
    instrument: row.instrument,
    scale: row.scale,
    score: row.score,
    percentile: row.percentile,
    level: row.level,
  }));
const rowValue = (row: Record<(typeof SCORE_FIELDS)[number], string | null>) =>
  SCORE_FIELDS.map((field) => row[field])
    .filter((text): text is string => text !== null)
    .join(" · ");
/** An open item is never repaired (it is the AI's note to her, not a sourced value): one over the limit is cut to fit. */
const OpenItemZ = z.strictObject({ kind: z.enum(OPEN_ITEM_KINDS), text: z.string().transform((text) => cutText(text, TEXT_LIMITS.openItem)), homeSection: HomeSectionZ });
/** A text cut to its limit, at a word when it can be, ending with "…". */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  const room = text.slice(0, max - 1);
  const space = room.lastIndexOf(" ");
  return `${(space > max / 2 ? room.slice(0, space) : room).trimEnd()}…`;
}

const ClientZ = z.strictObject({
  age: maybe(T.name),
  diagnosis: maybe(),
  severityLevel: maybe(T.name),
  evaluator: maybe(T.name),
  evaluationDate: maybe(T.short),
  medications: ClaimsZ(),
  school: maybe(T.name),
  grade: maybe(T.short),
  schedule: maybe(),
  iep: maybe(),
  otherServices: z
    .array(z.strictObject({ name: maybe(T.name), provider: maybe(T.name), paid: maybe(T.short) }))
    .max(MAX_MAP_LIST)
    .transform((services) => services.filter((service) => service.name !== null || service.provider !== null || service.paid !== null)),
  languages: ClaimsZ(T.name),
});

export const FactsAnswerSchema = z.strictObject({
  // The client with no value at all is no client (the absent form of the whole object).
  client: ClientZ.nullable().transform((client) => (client && Object.values(client).some((value) => (Array.isArray(value) ? value.length > 0 : value !== null)) ? client : null)),
  caregivers: z
    .array(z.strictObject({ key: KeyZ, role: maybe(T.name), language: maybe(T.name), availability: maybe(), participation: maybe(), limits: maybe(), mitigation: maybe() }))
    .max(MAP_PART_LIMITS.caregivers),
  settings: z.array(z.strictObject({ key: KeyZ, name: maybe(T.name), kind: maybe(T.short), evidence: maybe(T.short), by: maybe(T.name), dates: maybe() })).max(MAP_PART_LIMITS.settings),
  deficits: z
    .array(
      z.strictObject({
        key: KeyZ,
        area: maybe(T.name),
        scores: z
          .array(ScoreRowZ)
          .max(MAX_MAP_LIST)
          .transform((rows) => rows.filter((row) => row.value !== "")),
        evidence: ClaimsZ(),
        impact: maybe(),
      }),
    )
    .max(MAP_PART_LIMITS.deficits),
  strengths: z.array(z.strictObject({ key: KeyZ, text: maybe(), kind: maybe(T.short), setting: maybe(T.name) })).max(MAP_PART_LIMITS.strengths),
  facts: z.array(z.strictObject({ key: KeyZ, text: maybe(), homeSection: HomeSectionZ })).max(MAP_PART_LIMITS.facts),
  openItems: z.array(OpenItemZ).max(MAP_PART_LIMITS.openItems),
  report: z
    .array(z.strictObject({ kind: z.enum(REPORT_ITEM_KINDS), text: z.string(), sections: z.array(z.string().max(64)).max(22), refs: z.array(RefZ).max(MAX_MAP_REFS) }))
    .max(MAP_PART_LIMITS.report),
});

export const BehaviorsAnswerSchema = z.strictObject({
  behaviors: z
    .array(
      z.strictObject({
        key: KeyZ,
        name: maybe(T.name),
        topographies: ClaimsZ(),
        measure: maybe(T.short),
        definition: maybe(T.definition),
        onset: maybe(),
        offset: maybe(),
        examples: ClaimsZ(),
        nonExamples: ClaimsZ(),
        baseline: z.strictObject({
          observations: z.array(z.strictObject({ date: maybe(T.short), setting: maybe(T.name), length: maybe(T.short), value: maybe(T.short) })).max(MAX_MAP_LIST),
          other: ClaimsZ(),
        }),
        settingIds: z.array(z.string().max(40)).max(MAX_MAP_LIST),
        antecedents: ClaimsZ(),
        consequences: ClaimsZ(),
        function: z.strictObject({
          primary: z.array(z.enum(FUNCTION_NAMES)).max(5),
          secondary: z.array(z.enum(FUNCTION_NAMES)).max(5),
          evidence: z.array(z.strictObject({ tool: z.enum(EVIDENCE_TOOLS), respondent: TextOrNullZ, result: maybe(), supports: z.array(z.enum(FUNCTION_NAMES)).max(5) })).max(MAX_MAP_LIST),
          reasoning: TextOrNullZ,
          check: TextOrNullZ,
        }),
        barriers: z.array(z.enum(BARRIER_TAGS)).max(9),
        risks: ClaimsZ(),
      }),
    )
    .max(MAP_PART_LIMITS.behaviors),
  groups: z
    .array(z.strictObject({ key: KeyZ, behaviorKeys: z.array(KeyZ).max(MAX_MAP_LIST), nature: z.string(), function: orNone(FUNCTION_NAMES), measure: orNone(MEASURES), reason: z.string() }))
    .max(MAX_MAP_GROUPS),
  risks: z.array(z.strictObject({ key: KeyZ, behaviorKeys: z.array(KeyZ).max(MAX_MAP_LIST), what: maybe(), evidence: ClaimsZ(), level: maybe(T.name) })).max(MAP_PART_LIMITS.risks),
  openItems: z.array(OpenItemZ).max(MAP_PART_LIMITS.openItems),
});

export type FactsAnswer = z.output<typeof FactsAnswerSchema>;
export type BehaviorsAnswer = z.output<typeof BehaviorsAnswerSchema>;
export type MapAnswer = FactsAnswer | BehaviorsAnswer;
export type AnswerRef = z.infer<typeof RefZ>;
export type AnswerClaim = ReturnType<typeof finish>;
export type ScoreRow = z.output<typeof ScoreRowZ>;

/** The JSON object in an answer: the whole text, a fenced block, or the text from the first { to the last }. */
function jsonText(answer: string): string {
  const trimmed = answer.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/u.exec(trimmed);
  if (fenced) return fenced[1];
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  return start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
}

/**
 * Reads an answer: valid JSON in the request's shape and within the limits. The problems
 * are what the repair request says. `raw` is the JSON as the AI wrote it, for the repair
 * to quote the items that failed.
 */
export function parseMapAnswer(kind: MapRequestKind, text: string): { ok: true; answer: MapAnswer; raw: Record<string, unknown> } | { ok: false; problems: string[] } {
  let value: unknown;
  try {
    value = JSON.parse(jsonText(text));
  } catch {
    return { ok: false, problems: ["The answer is not valid JSON."] };
  }
  const parsed = (kind === "map-facts" ? FactsAnswerSchema : BehaviorsAnswerSchema).safeParse(value);
  if (!parsed.success) return { ok: false, problems: parsed.error.issues.slice(0, 20).map((issue) => `${issue.path.join(".") || "(answer)"}: ${issue.message}`) };
  // An empty value is left out, but its note is not lost: it becomes an open item (review round 2, M3).
  const answer = parsed.data;
  for (const note of notesOfEmptyValues(value as Record<string, unknown>)) {
    if (answer.openItems.length >= MAP_PART_LIMITS.openItems) break;
    if (!answer.openItems.some((item) => item.text === note)) answer.openItems.push({ kind: "check", text: note.slice(0, T.text), homeSection: null });
  }
  return { ok: true, answer, raw: value as Record<string, unknown> };
}

/** The field that names an item of each list, for a note to say which item it is about. */
const NAMED_BY: Record<string, string> = { caregivers: "role", settings: "name", deficits: "area", strengths: "text", facts: "text", behaviors: "name", risks: "what" };

/**
 * The checks written on empty values ("" with a check), each as an open item's text: the
 * note, after the name of the item it is about when the item has one ("Hand biting: no
 * threshold given"), never a code path (review scoped check, R3-M2).
 */
function notesOfEmptyValues(answer: Record<string, unknown>): string[] {
  const notes: string[] = [];
  const walk = (value: unknown, owner: string | null) => {
    if (Array.isArray(value)) return value.forEach((entry) => walk(entry, owner));
    if (!isPlain(value)) return;
    if (typeof value.value === "string" && Array.isArray(value.refs)) {
      if (value.value.trim() === "" && typeof value.check === "string" && value.check.trim() !== "") notes.push(owner ? `${owner}: ${value.check.trim()}` : value.check.trim());
      return;
    }
    for (const entry of Object.values(value)) walk(entry, owner);
  };
  for (const [part, entry] of Object.entries(answer)) {
    if (!Array.isArray(entry) || !NAMED_BY[part]) {
      walk(entry, null);
      continue;
    }
    for (const item of entry) {
      const label = isPlain(item) && isPlain(item[NAMED_BY[part]]) ? (item[NAMED_BY[part]] as { value?: unknown }).value : null;
      walk(item, typeof label === "string" && label.trim() !== "" ? label.trim().slice(0, 80) : null);
    }
  }
  return notes;
}

/* The code checks (D4) */

/** What the quotes are checked against. A PDF's text cannot be read yet (D32): its quotes are "not checked". */
export interface CheckContext {
  sources: ReadonlyArray<{ id: string; title: string; text: string | null }>;
  /** Her sections sent, by id. */
  sections: ReadonlyArray<{ id: string; text: string }>;
  notes: string;
  /** Setting ids a behavior may name (the settings part as saved). */
  settingIds: ReadonlySet<string>;
  /** Behaviors already in the map (on an update): a group or a risk may name them by id. */
  behaviorIds?: ReadonlySet<string>;
  /** Her confirmed thresholds, as sent (behaviors only): an AI-drafted value may take its numbers from them (D16). */
  instructions?: string;
}

/** How a ref's quote was checked. */
export type QuoteCheck = "found" | "not-found" | "not-checked";

/**
 * Text as compared for quotes, the same on both sides: one kind of quote mark, of dash and
 * of space, lower case, and without the Markdown a source is written in (emphasis marks,
 * table pipes, heading, list and quote markers, backslash escapes), so a quote copied
 * without them is still found (review round 1, S6). Nothing that carries words is removed.
 */
export function normalizeForQuote(text: string): string {
  return text
    .normalize("NFC")
    .replace(/\\([\\`*_{}[\]()#+\-.!|>~])/gu, "$1")
    .split(/\r?\n/u)
    .map((line) => line.replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d{1,3}[.)]\s+)+/u, ""))
    .join("\n")
    .replace(/\*+|`+|~~/gu, "")
    .replace(/(^|[\s(])_+|_+(?=[\s).,;:!?]|$)/gmu, "$1")
    .replace(/\|/gu, " ")
    .replace(/[\u{2018}\u{2019}\u{201A}\u{201B}\u{2032}]/gu, "'")
    .replace(/[\u{201C}\u{201D}\u{201E}\u{201F}\u{2033}]/gu, '"')
    .replace(/[\u{2010}-\u{2015}\u{2212}]/gu, "-")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

/** The fewest words a checked quote may have, so a quote like "3" or "the" is not "found" anywhere (review round 1, S1). */
export const MIN_QUOTE_WORDS = 3;

const DATE = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/gu;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WORD_DATE = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/giu;
/** A year as four digits: "26" is 2026 (review round 2, M6). */
const fullYear = (year: string) => (year.length <= 2 ? String(2000 + Number(year)) : plainNumber(year));
const plainNumber = (raw: string) => {
  const [whole, fraction] = raw.replace(",", ".").split(".");
  const trimmed = whole.replace(/^0+(?=\d)/u, "");
  return fraction === undefined ? trimmed : `${trimmed}.${fraction}`;
};

/**
 * The numbers written in a text, without leading zeros ("03" is "3"), and dates kept whole
 * ("d:12/4/2026"), so a date's "12" is not a count of 12 (review round 1, M7). Markers of
 * the AI's own ([MISSING: …], [CHECK: …]) are left out.
 */
export function numbersIn(text: string): string[] {
  const withoutMarkers = text.replace(/\[(?:MISSING|CHECK):[^\]]*\]/gu, " ");
  const out: string[] = [];
  const rest = withoutMarkers
    .replace(DATE, (_match, month: string, day: string, year: string | undefined) => {
      out.push(`d:${plainNumber(month)}/${plainNumber(day)}${year ? `/${fullYear(year)}` : ""}`);
      return " ";
    })
    .replace(WORD_DATE, (_match, month: string, day: string, year: string | undefined) => {
      out.push(`d:${MONTHS.indexOf(month.slice(0, 3).toLowerCase()) + 1}/${plainNumber(day)}${year ? `/${fullYear(year)}` : ""}`);
      return " ";
    });
  for (const match of rest.matchAll(/\d+(?:[.,]\d+)?/gu)) out.push(plainNumber(match[0]));
  return out;
}

/** Whether a number of a value is the same as one of a quote: equal, or the same date where one of the two leaves the year out. */
function sameNumber(wanted: string, quoted: string): boolean {
  if (wanted === quoted) return true;
  if (!wanted.startsWith("d:") || !quoted.startsWith("d:")) return false;
  const [a, b] = [wanted.slice(2).split("/"), quoted.slice(2).split("/")];
  return a[0] === b[0] && a[1] === b[1] && (a.length === 2 || b.length === 2);
}

const THRESHOLD = /\d+(?:\.\d+)?\s*(?:-\s*)?(?:seconds?|secs?|s\b|feet|foot|ft\b|minutes?|mins?\b|meters?|m\b)/iu;

export interface CheckResult {
  /** What the repair request says; empty when the answer passes. */
  problems: string[];
  /** Each ref's quote check, by the ref object itself. */
  quotes: Map<AnswerRef, QuoteCheck>;
  /** Claims with a number in none of their quotes. */
  numbers: Set<AnswerClaim>;
  /** Those numbers, by claim (a score row's [CHECK] goes on the field that holds one). */
  unquotedNumbers: Map<AnswerClaim, string[]>;
  /** Claims with a number found only in a PDF's quote, which cannot be checked yet: not a problem, but marked [CHECK] (review round 2, S1). */
  pdfNumbers: Set<AnswerClaim>;
  /** Claims with a problem of their own: a repair may replace them; the others are kept (review scoped check, R3-M1). */
  failedClaims: Set<AnswerClaim>;
  /** The items with a problem, by list ("client", "caregivers", "behaviors", "report", …) and index: what a repair asks about. */
  failing: Map<string, Set<number>>;
  /** A problem that belongs to no single item (a key used twice): the repair asks about the whole answer. */
  whole: boolean;
  /**
   * The items with a problem of their own that is not one of their values' (a link, a
   * function both primary and secondary, a report item): the repair quotes them whole. For
   * every other failing item it quotes only the values that failed (case map speed, 2026-11-23).
   */
  itemLevel: Map<string, Set<number>>;
  /** Why: how many problems of each kind (a quote not found, a number in no quote, …), recorded with the request. */
  causes: Record<string, number>;
  /** How many values the repair is asked to fix: the values that failed, and each item-level problem. */
  failedValues: number;
  /**
   * Texts that are not claims and failed on their own (a function's reasoning longer than
   * its limit, a respondent, a group's reason): by the object that holds them, their field
   * names. The repair quotes them like a failed value.
   */
  failedFields: Map<object, Set<string>>;
}

/** The kinds of problem, as recorded (MapExtractionRecord.repairCauses). */
export type ProblemCause =
  | "quote-empty"
  | "quote-too-short"
  | "quote-not-found"
  | "unknown-ref"
  | "no-ref"
  | "number-not-quoted"
  | "threshold"
  | "not-in-list"
  | "unknown-link"
  | "duplicate-key"
  | "group-rule"
  | "function-both"
  | "too-long"
  | "unreadable";

const LISTS = ["caregivers", "settings", "deficits", "strengths", "facts", "report", "behaviors", "groups", "risks"] as const;

/**
 * The checks after Zod: every ref names a place that was sent and quotes it word for word
 * in at least three words (a PDF's quotes are not checked yet); every claim with a source's
 * value has a ref; every number of a claim is written in one of its quotes (an AI-drafted
 * value may also take it from her confirmed thresholds); every link between items is
 * known; keys are unique; a group's members share its function and measure.
 */
export function checkMapAnswer(kind: MapRequestKind, answer: MapAnswer, context: CheckContext): CheckResult {
  const problems: string[] = [];
  const quotes = new Map<AnswerRef, QuoteCheck>();
  const numbers = new Set<AnswerClaim>();
  const unquotedNumbers = new Map<AnswerClaim, string[]>();
  const pdfNumbers = new Set<AnswerClaim>();
  const failedClaims = new Set<AnswerClaim>();
  const failing = new Map<string, Set<number>>();
  const itemLevel = new Map<string, Set<number>>();
  const causes: Record<string, number> = {};
  let itemProblems = 0;
  let whole = false;
  /** Inside the check of one value: its problems are the value's, not the item's. */
  let inClaim = false;
  const failedFields = new Map<object, Set<string>>();
  let fieldProblems = 0;
  const longMessage = (length: number, max: number) => `it is ${length} characters long, and this field takes at most ${max}: shorten it, keeping its meaning and its numbers.`;
  /** A text that is not a claim, over its limit: that text's own problem (owner's decision, 2026-11-23), repaired alone. */
  const textTooLong = (holder: object, field: string, text: string | null, max: number, where: string) => {
    if (text === null || text.length <= max) return;
    inClaim = true;
    problem(`${where}.${field}`, longMessage(text.length, max), "too-long");
    inClaim = false;
    const fields = failedFields.get(holder) ?? new Set<string>();
    fields.add(field);
    failedFields.set(holder, fields);
    fieldProblems++;
  };
  const sources = new Map(context.sources.map((source) => [source.id, source]));
  const sourceTexts = new Map(context.sources.filter((source) => source.text !== null).map((source) => [source.id, normalizeForQuote(source.text ?? "")]));
  const sectionTexts = new Map(context.sections.map((section) => [section.id, normalizeForQuote(section.text)]));
  const notes = normalizeForQuote(context.notes);
  const thresholdNumbers = new Set(numbersIn(context.instructions ?? ""));
  const knownBehaviors = context.behaviorIds ?? new Set<string>();

  /** A problem, located: "settings[2].kind" marks settings item 2 as failing; "client.age" the client. */
  const problem = (where: string, message: string, cause: ProblemCause) => {
    const text = `${where}: ${message}`;
    if (problems.includes(text)) return;
    problems.push(text);
    causes[cause] = (causes[cause] ?? 0) + 1;
    const listed = /^([a-zA-Z]+)\[(\d+)\]/u.exec(where);
    const mark = (into: Map<string, Set<number>>, list: string, index: number) => {
      const set = into.get(list) ?? new Set<number>();
      set.add(index);
      into.set(list, set);
    };
    if (listed && (LISTS as readonly string[]).includes(listed[1])) {
      mark(failing, listed[1], Number(listed[2]));
      if (!inClaim) {
        mark(itemLevel, listed[1], Number(listed[2]));
        itemProblems++;
      }
    } else if (where.startsWith("client")) failing.set("client", new Set([0]));
    else whole = true;
  };

  const checkRef = (ref: AnswerRef, where: string) => {
    // A quote over the limit is that quote's problem; whether it is found is still checked, so a found one cut to fit stays verbatim.
    if (ref.quote.length > TEXT_LIMITS.quote) {
      problem(where, `the quote "${ref.quote.slice(0, 80)}…" is ${ref.quote.length} characters long, and a quote takes at most ${TEXT_LIMITS.quote}: copy a shorter passage, word for word, that still shows the value.`, "too-long");
    }
    const quote = normalizeForQuote(ref.quote);
    const fail = (message: string, cause: ProblemCause) => {
      problem(where, message, cause);
      quotes.set(ref, "not-found");
    };
    if (quote === "") return fail("a ref has an empty quote.", "quote-empty");
    let text: string | undefined;
    let place: string;
    if (ref.kind === "source") {
      const source = sources.get(ref.id);
      if (!source) return fail(`"${ref.id}" is not the id of a source that was sent.`, "unknown-ref");
      if (source.text === null) return void quotes.set(ref, "not-checked");
      text = sourceTexts.get(ref.id);
      place = `the source "${source.title}"`;
    } else if (ref.kind === "section") {
      text = sectionTexts.get(ref.id);
      if (text === undefined) return fail(`"${ref.id}" is not one of her sections that were sent.`, "unknown-ref");
      place = `her section "${ref.id}"`;
    } else {
      text = notes;
      place = "her session notes";
    }
    const words = quote.split(" ").filter((word) => /[\p{L}\p{N}]/u.test(word));
    if (words.length < MIN_QUOTE_WORDS || !words.some((word) => /\p{L}/u.test(word))) {
      return fail(`the quote "${ref.quote.slice(0, 80)}" is too short: copy at least ${MIN_QUOTE_WORDS} words, with words around the value.`, "quote-too-short");
    }
    if (text?.includes(quote)) return void quotes.set(ref, "found");
    return fail(`the quote "${ref.quote.slice(0, 80)}" is not found word for word in ${place}.`, "quote-not-found");
  };

  const visitClaim = (claim: AnswerClaim | null, where: string, options: { threshold?: boolean } = {}) => {
    if (!claim) return;
    const before = problems.length;
    inClaim = true;
    checkOneClaim(claim, where, options);
    inClaim = false;
    if (problems.length > before) failedClaims.add(claim);
  };
  const checkOneClaim = (claim: AnswerClaim, where: string, options: { threshold?: boolean }) => {
    claim.refs.forEach((ref, index) => checkRef(ref, `${where}.refs[${index}]`));
    // Longer than its field allows: the value's own problem (owner's decision, 2026-11-23). A score row's fields each have their own limit.
    if (isScoreRow(claim)) {
      for (const field of SCORE_FIELDS) {
        const text = claim[field];
        if (text !== null && text.length > SCORE_LIMITS[field]) problem(`${where}.${field}`, longMessage(text.length, SCORE_LIMITS[field]), "too-long");
      }
    } else if (claim.value.length > limitOf(claim)) problem(`${where}.value`, longMessage(claim.value.length, limitOf(claim)), "too-long");
    if (claim.check !== null && claim.check.length > TEXT_LIMITS.check) problem(`${where}.check`, longMessage(claim.check.length, TEXT_LIMITS.check), "too-long");
    if ((claim.origin === "extracted" || claim.origin === "her") && claim.refs.length === 0) problem(where, "a value a source or her text states needs a ref with its quote.", "no-ref");
    // Only PDFs cited: their text cannot be read yet, so nothing can be checked (D32).
    if (claim.refs.length > 0 && claim.refs.every((ref) => quotes.get(ref) === "not-checked")) return;
    const quotedIn = (state: QuoteCheck) => claim.refs.filter((ref) => quotes.get(ref) === state).flatMap((ref) => numbersIn(ref.quote));
    const found = quotedIn("found");
    const inPdf = quotedIn("not-checked");
    const allowed = (number: string) => found.some((quoted) => sameNumber(number, quoted)) || (claim.origin === "ai-drafted" && [...thresholdNumbers].some((quoted) => sameNumber(number, quoted)));
    const unchecked = numbersIn(claim.value).filter((number) => !allowed(number));
    // A number only in a PDF's quote next to a text quote passes, marked [CHECK] on the value (review round 2, S1).
    const missing = unchecked.filter((number) => !inPdf.some((quoted) => sameNumber(number, quoted)));
    if (unchecked.length > 0 && missing.length === 0) pdfNumbers.add(claim);
    if (missing.length === 0) return;
    numbers.add(claim);
    unquotedNumbers.set(claim, missing);
    if (options.threshold && THRESHOLD.test(claim.value) && thresholdNumbers.size === 0) {
      problem(where, `"${claim.value.slice(0, 80)}" gives a threshold that no standing instruction gives: write [MISSING: your threshold for …] in its place.`, "threshold");
    } else {
      problem(where, `the number ${missing.map((number) => number.replace(/^d:/u, "")).join(", ")} in "${claim.value.slice(0, 80)}" is not written in any of its quotes.`, "number-not-quoted");
    }
  };
  const visitAll = (claims: readonly AnswerClaim[], where: string) => claims.forEach((claim, index) => visitClaim(claim, `${where}[${index}]`));
  const uniqueKeys = (items: ReadonlyArray<{ key: string }>, where: string) => {
    const seen = new Set<string>();
    for (const item of items) {
      if (seen.has(item.key)) problem(where, `the key "${item.key}" is used twice.`, "duplicate-key");
      seen.add(item.key);
    }
  };
  /** A value outside its fixed list: the value's own problem, which a repair can fix alone. */
  const oneOf = (claim: AnswerClaim | null, values: readonly string[], where: string) => {
    if (!claim || values.includes(claim.value)) return;
    inClaim = true;
    problem(where, `"${claim.value}" is not one of ${values.join(", ")}.`, "not-in-list");
    inClaim = false;
    failedClaims.add(claim);
  };

  if (kind === "map-facts") {
    const facts = answer as FactsAnswer;
    const client = facts.client;
    if (client) {
      for (const key of ["age", "diagnosis", "severityLevel", "evaluator", "evaluationDate", "school", "grade", "schedule", "iep"] as const) visitClaim(client[key], `client.${key}`);
      visitAll(client.medications, "client.medications");
      visitAll(client.languages, "client.languages");
      client.otherServices.forEach((service, index) => {
        visitClaim(service.name, `client.otherServices[${index}].name`);
        visitClaim(service.provider, `client.otherServices[${index}].provider`);
        visitClaim(service.paid, `client.otherServices[${index}].paid`);
        oneOf(service.paid, SERVICE_PAID, `client.otherServices[${index}].paid`);
      });
    }
    facts.caregivers.forEach((item, index) => {
      for (const key of ["role", "language", "availability", "participation", "limits", "mitigation"] as const) visitClaim(item[key], `caregivers[${index}].${key}`);
    });
    facts.settings.forEach((item, index) => {
      for (const key of ["name", "kind", "evidence", "by", "dates"] as const) visitClaim(item[key], `settings[${index}].${key}`);
      oneOf(item.kind, SETTING_KINDS, `settings[${index}].kind`);
      oneOf(item.evidence, SETTING_EVIDENCE, `settings[${index}].evidence`);
    });
    facts.deficits.forEach((item, index) => {
      visitClaim(item.area, `deficits[${index}].area`);
      visitClaim(item.impact, `deficits[${index}].impact`);
      visitAll(item.evidence, `deficits[${index}].evidence`);
      // A score row is one claim: every number of its five fields is checked against its quotes.
      visitAll(item.scores, `deficits[${index}].scores`);
    });
    facts.strengths.forEach((item, index) => {
      for (const key of ["text", "kind", "setting"] as const) visitClaim(item[key], `strengths[${index}].${key}`);
      oneOf(item.kind, STRENGTH_KINDS, `strengths[${index}].kind`);
    });
    facts.facts.forEach((item, index) => visitClaim(item.text, `facts[${index}].text`));
    facts.report.forEach((item, index) => {
      item.refs.forEach((ref, at) => checkRef(ref, `report[${index}].refs[${at}]`));
      // A report item is always quoted whole by a repair, so its text over the limit is the item's problem.
      if (item.text.length > TEXT_LIMITS.report) problem(`report[${index}].text`, longMessage(item.text.length, TEXT_LIMITS.report), "too-long");
      for (const id of item.sections) if (!sectionTexts.has(id)) problem(`report[${index}]`, `"${id}" is not one of her sections that were sent.`, "unknown-ref");
    });
    uniqueKeys(facts.caregivers, "caregivers");
    uniqueKeys(facts.settings, "settings");
    uniqueKeys(facts.deficits, "deficits");
    uniqueKeys(facts.strengths, "strengths");
    uniqueKeys(facts.facts, "facts");
  } else {
    const found = answer as BehaviorsAnswer;
    const behaviorKeys = new Set(found.behaviors.map((behavior) => behavior.key));
    const named = (key: string) => behaviorKeys.has(key) || knownBehaviors.has(key);
    found.behaviors.forEach((behavior, index) => {
      const where = `behaviors[${index}]`;
      visitClaim(behavior.name, `${where}.name`);
      visitClaim(behavior.measure, `${where}.measure`);
      oneOf(behavior.measure, MEASURES, `${where}.measure`);
      for (const key of ["definition", "onset", "offset"] as const) visitClaim(behavior[key], `${where}.${key}`, { threshold: true });
      for (const key of ["topographies", "examples", "nonExamples", "antecedents", "consequences", "risks"] as const) visitAll(behavior[key], `${where}.${key}`);
      behavior.baseline.observations.forEach((observation, at) => {
        const place = `${where}.baseline.observations[${at}]`;
        for (const key of ["date", "setting", "length", "value"] as const) visitClaim(observation[key], `${place}.${key}`);
      });
      visitAll(behavior.baseline.other, `${where}.baseline.other`);
      behavior.function.evidence.forEach((entry, at) => {
        visitClaim(entry.result, `${where}.function.evidence[${at}].result`);
        textTooLong(entry, "respondent", entry.respondent, TEXT_LIMITS.respondent, `${where}.function.evidence[${at}]`);
      });
      textTooLong(behavior.function, "reasoning", behavior.function.reasoning, TEXT_LIMITS.reasoning, `${where}.function`);
      textTooLong(behavior.function, "check", behavior.function.check, TEXT_LIMITS.check, `${where}.function`);
      for (const id of behavior.settingIds) if (!context.settingIds.has(id)) problem(`${where}.settingIds`, `"${id}" is not the id of a setting in <map-facts>.`, "unknown-link");
      const both = behavior.function.primary.filter((name) => behavior.function.secondary.includes(name));
      if (both.length > 0) problem(`${where}.function`, `${both.join(", ")} is both primary and secondary.`, "function-both");
    });
    const grouped = new Map<string, string>();
    const byKey = new Map(found.behaviors.map((behavior) => [behavior.key, behavior]));
    found.groups.forEach((group, index) => {
      const where = `groups[${index}]`;
      textTooLong(group, "nature", group.nature, TEXT_LIMITS.nature, where);
      textTooLong(group, "reason", group.reason, TEXT_LIMITS.reason, where);
      for (const key of group.behaviorKeys) {
        if (!named(key)) problem(where, `"${key}" is not the key of a behavior in this answer or the id of one in the map.`, "unknown-link");
        if (grouped.has(key)) problem(where, `the behavior "${key}" is in two groups (${grouped.get(key)} and ${group.key}).`, "group-rule");
        grouped.set(key, group.key);
        // Her rule: one function and one measure for the whole group (review round 1, S8).
        const member = byKey.get(key);
        if (!member) continue;
        if (group.function && !member.function.primary.includes(group.function)) problem(where, `the group's function ${group.function} is not a primary function of "${key}".`, "group-rule");
        if (group.measure && member.measure && member.measure.value !== group.measure) problem(where, `the group's measure ${group.measure} is not the measure of "${key}" (${member.measure.value}).`, "group-rule");
      }
    });
    found.risks.forEach((risk, index) => {
      visitClaim(risk.what, `risks[${index}].what`);
      visitClaim(risk.level, `risks[${index}].level`);
      visitAll(risk.evidence, `risks[${index}].evidence`);
      for (const key of risk.behaviorKeys) if (!named(key)) problem(`risks[${index}]`, `"${key}" is not the key of a behavior in this answer or the id of one in the map.`, "unknown-link");
    });
    uniqueKeys(found.behaviors, "behaviors");
    uniqueKeys(found.groups, "groups (keys)");
    uniqueKeys(found.risks, "risks (keys)");
  }
  return { problems, quotes, numbers, unquotedNumbers, pdfNumbers, failedClaims, failing, whole, itemLevel, causes, failedValues: failedClaims.size + fieldProblems + itemProblems, failedFields };
}

/*
 * The repair (review round 1, B1; case map speed, 2026-11-23): only what failed is asked
 * about, and the answer is merged back by key, field by field and entry by entry.
 */

/** How much of the first answer a repair quotes: the values that failed, whole items (a problem of the item's own), or the whole answer. */
export type RepairScope = "values" | "items" | "whole";

/** What a repair quotes of the first answer, and how much. */
export interface RepairInput {
  previousAnswer: Record<string, unknown>;
  scope: RepairScope;
}

/**
 * The part of an answer a repair quotes. For an item whose problems are all its values'
 * (a quote not found, a number in no quote, a value outside its list), only those values,
 * under the item's key: a repair then writes a few values, not the item again. For an item
 * with a problem of its own (a link, a function both primary and secondary, a report item),
 * the item whole, as the AI wrote it. Every other item is left out. The whole answer when
 * a problem belongs to no single item (a key used twice).
 */
export function repairInput(kind: MapRequestKind, raw: Record<string, unknown>, answer: MapAnswer, checks: CheckResult): RepairInput {
  if (checks.whole) return { previousAnswer: raw, scope: "whole" };
  let wholeItems = false;
  const pick = (list: string, parsed: ReadonlyArray<Record<string, unknown>>) => {
    const items = Array.isArray(raw[list]) ? (raw[list] as unknown[]) : [];
    const wanted = [...(checks.failing.get(list) ?? new Set<number>())].sort((a, b) => a - b);
    return wanted.flatMap((index) => {
      if (checks.itemLevel.get(list)?.has(index) || list === "report") {
        wholeItems = true;
        return items[index] === undefined ? [] : [items[index]];
      }
      const item = parsed[index];
      return item ? [onlyFailed(item, checks.failedClaims, checks.failedFields)] : [];
    });
  };
  const rows = (list: readonly unknown[]) => list as ReadonlyArray<Record<string, unknown>>;
  let previousAnswer: Record<string, unknown>;
  if (kind === "map-facts") {
    const facts = answer as FactsAnswer;
    previousAnswer = {
      ...(checks.failing.has("client") && facts.client ? { client: onlyFailed(facts.client as unknown as Record<string, unknown>, checks.failedClaims, checks.failedFields) } : {}),
      caregivers: pick("caregivers", rows(facts.caregivers)),
      settings: pick("settings", rows(facts.settings)),
      deficits: pick("deficits", rows(facts.deficits)),
      strengths: pick("strengths", rows(facts.strengths)),
      facts: pick("facts", rows(facts.facts)),
      report: pick("report", rows(facts.report)),
    };
  } else {
    const found = answer as BehaviorsAnswer;
    previousAnswer = { behaviors: pick("behaviors", rows(found.behaviors)), groups: pick("groups", rows(found.groups)), risks: pick("risks", rows(found.risks)) };
  }
  // Lists with nothing to fix are left out, so the quote holds only what failed.
  for (const [key, value] of Object.entries(previousAnswer)) if (Array.isArray(value) && value.length === 0) delete previousAnswer[key];
  return { previousAnswer, scope: wholeItems ? "items" : "values" };
}

/** A claim (or a score row) in the wire's form: "" for no check, a row's empty fields as "". */
function wireClaim(claim: AnswerClaim): Record<string, unknown> {
  const { value, refs, origin, check, ...rest } = claim as AnswerClaim & Record<string, unknown>;
  if ("instrument" in rest) {
    const row = Object.fromEntries(SCORE_FIELDS.map((field) => [field, (rest[field] as string | null) ?? ""]));
    return { ...row, refs, origin, check: check ?? "" };
  }
  return { value, refs, origin, check: check ?? "" };
}

/**
 * An item with only the values that failed, in the wire's form: its key, the failed claims,
 * and of a list of entries (observations, a function's evidence, other services) the failed
 * entries with what names them (a date, an instrument, a tool and its respondent). Nothing
 * else: what the repair leaves empty stays as the first answer had it.
 */
function onlyFailed(item: Record<string, unknown>, failed: ReadonlySet<unknown>, fields: ReadonlyMap<object, Set<string>> = new Map()): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const failedHere = fields.get(item);
  for (const [key, value] of Object.entries(item)) {
    if (key === "key") out.key = value;
    // A text that is not a claim and failed on its own (a reasoning too long): quoted as it is.
    else if (failedHere?.has(key)) out[key] = value;
    else if (isClaim(value)) {
      if (failed.has(value)) out[key] = wireClaim(value);
    } else if (Array.isArray(value)) {
      const kept = value.flatMap((entry): unknown[] => {
        if (isClaim(entry)) return failed.has(entry) ? [wireClaim(entry)] : [];
        if (isPlain(entry) && (entryFailed(entry, failed) || fields.has(entry))) return [{ ...identifyingFields(entry), ...onlyFailed(entry, failed, fields) }];
        return [];
      });
      if (kept.length > 0) out[key] = kept;
    } else if (isPlain(value)) {
      const inner = onlyFailed(value, failed, fields);
      if (Object.keys(inner).length > 0) out[key] = inner;
    }
  }
  return out;
}

/** What names an entry of a list (its date, instrument, name, or tool with its respondent), so the repair's entry is merged into the right one. */
function identifyingFields(entry: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of [...ENTRY_ID_FIELDS, "respondent"]) {
    const value = entry[key];
    if (value === undefined || value === null) continue;
    out[key] = isClaim(value) ? wireClaim(value) : value;
  }
  return out;
}

const isPlain = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
/** A claim: a string value with its refs. An observation also has a field named value, which is a claim, so the shape decides. */
const isClaim = (value: unknown): value is AnswerClaim => isPlain(value) && typeof value.value === "string" && Array.isArray(value.refs);
/** A score row: a claim with the row's five fields. */
export const isScoreRow = (value: unknown): value is ScoreRow => isClaim(value) && "instrument" in value;
const emptyValue = (value: unknown) => value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0);

/**
 * One item of the first answer with the repair's version over it, field by field (review
 * round 2, S2): a field the repair gives replaces the first answer's; a field the repair
 * leaves empty keeps the first answer's value, which the checks then flag again as before.
 * A claim (an object with a value) is one field; other objects (a baseline, a function) are
 * merged field by field too.
 */
export function mergeFields<T>(first: T, repaired: T, failed: ReadonlySet<unknown> = new Set()): T {
  if (!isPlain(first) || !isPlain(repaired) || isClaim(repaired)) return emptyValue(repaired) ? first : repaired;
  const out: Record<string, unknown> = { ...repaired };
  for (const [key, value] of Object.entries(first)) {
    const next = repaired[key];
    if (emptyValue(next)) out[key] = value;
    else if (isPlain(value) && isPlain(next) && !isClaim(next)) out[key] = mergeFields(value, next, failed);
    else if (isClaimList(value) && isClaimList(next)) out[key] = mergeClaimList(value, next, failed);
    else if (isObjectList(value) && isObjectList(next)) out[key] = mergeObjectList(value, next, failed);
  }
  return out as T;
}

/** A list of objects that are not claims (observations, scores, a function's evidence, other services). */
const isObjectList = (value: unknown): value is Array<Record<string, unknown>> => Array.isArray(value) && value.length > 0 && value.every((entry) => isPlain(entry) && !isClaim(entry));

/** The field that names an entry of an object list, in this order: an observation's date, a score's instrument, a service's name, an evidence's tool (with its respondent). */
const ENTRY_ID_FIELDS = ["date", "instrument", "name", "tool"] as const;

const textOf = (value: unknown): string => (typeof value === "string" ? value : isPlain(value) && typeof value.value === "string" ? value.value : "");

/** The identifying value of an entry, or null when it has none. */
function entryId(entry: Record<string, unknown>): string | null {
  for (const key of ENTRY_ID_FIELDS) {
    const text = normalizeForQuote(textOf(entry[key]));
    if (!text) continue;
    return key === "tool" ? `${key}:${text}|${normalizeForQuote(textOf(entry.respondent))}` : `${key}:${text}`;
  }
  return null;
}

/** An entry has failed when one of its own claims failed the checks. */
const entryFailed = (entry: Record<string, unknown>, failed: ReadonlySet<unknown>): boolean => failed.has(entry) || Object.values(entry).some((value) => failed.has(value) || (isPlain(value) && !isClaim(value) && entryFailed(value, failed)));

/**
 * A list of objects after a repair (review check of 039ce31, R4-M1), entry by entry, by its
 * date, instrument, name or tool: a repair entry with the same identifying value as a first
 * entry is merged into it field by field, in the first answer's order (a failed first entry
 * is matched before a passed one with the same value); the repair's other entries follow.
 * A first entry that passed stays when the repair leaves it out, so a repair that returns
 * only the fixed observation keeps the counts that passed. A failed first entry the repair
 * leaves out is dropped, as the repair was asked to fix it, as in a claim list.
 */
function mergeObjectList(first: Array<Record<string, unknown>>, repaired: Array<Record<string, unknown>>, failed: ReadonlySet<unknown>): Array<Record<string, unknown>> {
  const matchOf = new Map<number, Record<string, unknown>>();
  const extra: Array<Record<string, unknown>> = [];
  for (const entry of repaired) {
    const id = entryId(entry);
    const candidates = id === null ? [] : first.map((item, index) => ({ item, index })).filter(({ item, index }) => !matchOf.has(index) && entryId(item) === id);
    // An evidence whose respondent was the value that failed comes back with another
    // respondent: it is the failed entry of the same tool.
    const sameTool = id === null ? [] : first.map((item, index) => ({ item, index })).filter(({ item, index }) => !matchOf.has(index) && entryFailed(item, failed) && entryId(item)?.split("|")[0] === id.split("|")[0]);
    const match = candidates.find(({ item }) => entryFailed(item, failed)) ?? candidates[0] ?? sameTool[0];
    if (match) matchOf.set(match.index, entry);
    else extra.push(entry);
  }
  const out: Array<Record<string, unknown>> = [];
  first.forEach((item, index) => {
    const entry = matchOf.get(index);
    if (entry) out.push(mergeFields(item, entry, failed));
    else if (!entryFailed(item, failed)) out.push(item);
  });
  return [...out, ...extra];
}

const isClaimList = (value: unknown): value is AnswerClaim[] => Array.isArray(value) && value.length > 0 && value.every(isClaim);

/**
 * A claim list after a repair (review scoped check, R3-M1): the first answer's claims that
 * passed the checks stay, in their order, unless the repair gives the same value; then the
 * repair's claims. A claim that failed is replaced by what the repair gives, or dropped
 * when the repair leaves it out, as the repair was asked to fix it.
 */
function mergeClaimList(first: AnswerClaim[], repaired: AnswerClaim[], failed: ReadonlySet<unknown>): AnswerClaim[] {
  const given = new Set(repaired.map((claim) => normalizeForQuote(claim.value)));
  const kept = first.filter((claim) => !failed.has(claim) && !given.has(normalizeForQuote(claim.value)));
  return [...kept, ...repaired];
}

/**
 * Items by key. After a repair about some items: the first answer's list, each item merged
 * field by field with the repair's item of the same key (a key it never used is left out). After a
 * whole-answer repair: the repair's list first, merged the same way, then the first answer's
 * keys it lacks, once each, so a key the first answer used twice is not doubled (review round 2, M2).
 */
function mergeKeyed<T extends { key: string }>(first: readonly T[], repaired: readonly T[], whole: boolean, failed: ReadonlySet<unknown>): T[] {
  const firstByKey = new Map<string, T>();
  for (const item of first) if (!firstByKey.has(item.key)) firstByKey.set(item.key, item);
  if (whole) {
    const out = repaired.map((item) => (firstByKey.has(item.key) ? mergeFields(firstByKey.get(item.key)!, item, failed) : item));
    const present = new Set(repaired.map((item) => item.key));
    for (const [key, item] of firstByKey) if (!present.has(key)) out.push(item);
    return out;
  }
  // A repair about some items answers under their keys; an item under a key the first answer
  // never used would be a few values with no item around them, so it is left out.
  const fromRepair = new Map(repaired.map((item) => [item.key, item]));
  return first.map((item) => (fromRepair.has(item.key) ? mergeFields(item, fromRepair.get(item.key)!, failed) : item));
}

const sameText = (a: string, b: string) => normalizeForQuote(a) === normalizeForQuote(b);

/**
 * The first answer with the repair's items in place, by key (review round 1, B1). An item
 * the repair leaves out keeps the first answer's version, with its flags; nothing of the
 * first answer is lost. Unkeyed lists: the report's failed items are replaced by the
 * repair's report items when it gives any; open items are joined without repeats.
 */
export function mergeRepair(kind: MapRequestKind, first: MapAnswer, repaired: MapAnswer, failing: CheckResult["failing"], whole = false, failed: ReadonlySet<unknown> = new Set()): MapAnswer {
  const joinOpen = <T extends { text: string }>(a: readonly T[], b: readonly T[]) => [...a, ...b.filter((item) => !a.some((other) => sameText(other.text, item.text)))];
  if (kind === "map-facts") {
    const a = first as FactsAnswer;
    const b = repaired as FactsAnswer;
    const failedReport = failing.get("report") ?? new Set<number>();
    return {
      client: a.client && b.client ? mergeFields(a.client, b.client, failed) : (b.client ?? a.client),
      caregivers: mergeKeyed(a.caregivers, b.caregivers, whole, failed),
      settings: mergeKeyed(a.settings, b.settings, whole, failed),
      deficits: mergeKeyed(a.deficits, b.deficits, whole, failed),
      strengths: mergeKeyed(a.strengths, b.strengths, whole, failed),
      facts: mergeKeyed(a.facts, b.facts, whole, failed),
      openItems: joinOpen(a.openItems, b.openItems),
      report: b.report.length > 0 ? [...a.report.filter((_item, index) => !failedReport.has(index)), ...b.report] : a.report,
    };
  }
  const a = first as BehaviorsAnswer;
  const b = repaired as BehaviorsAnswer;
  return {
    behaviors: mergeKeyed(a.behaviors, b.behaviors, whole, failed),
    groups: mergeKeyed(a.groups, b.groups, whole, failed),
    risks: mergeKeyed(a.risks, b.risks, whole, failed),
    openItems: joinOpen(a.openItems, b.openItems),
  };
}
