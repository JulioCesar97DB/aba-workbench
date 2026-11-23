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
      scores: list(object({ instrument: claimSchema, scale: claimSchema, score: claimSchema, percentile: claimSchema, level: claimSchema })),
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

/* The same shape, checked with Zod, with the map's limits (D6). Absent forms become null; null itself is accepted too (plain JSON). */

const T = MAP_TEXT_LIMITS;
const RefZ = z.strictObject({ kind: z.enum(REF_KINDS), id: z.string().max(64), quote: z.string().max(T.quote) });
const WireClaimZ = (max: number) => z.strictObject({ value: z.string().max(max), refs: z.array(RefZ).max(MAX_MAP_REFS), origin: z.enum(ORIGIN_VALUES), check: z.string().max(T.text).nullable() });
type WireClaim = z.infer<ReturnType<typeof WireClaimZ>>;
const absent = (claim: WireClaim | null): claim is null => claim === null || claim.value.trim() === "";
const finish = (claim: WireClaim) => ({ ...claim, check: claim.check !== null && claim.check.trim() !== "" ? claim.check : null });
const maybe = (max: number = T.text) => WireClaimZ(max).nullable().transform((claim) => (absent(claim) ? null : finish(claim)));
const ClaimsZ = (max: number = T.text) =>
  z
    .array(WireClaimZ(max))
    .max(MAX_MAP_LIST)
    .transform((values) => values.filter((claim) => !absent(claim)).map(finish));
const TextOrNullZ = (max: number) =>
  z
    .string()
    .max(max)
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
const OpenItemZ = z.strictObject({ kind: z.enum(OPEN_ITEM_KINDS), text: z.string().max(T.text), homeSection: HomeSectionZ });

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
        scores: z.array(z.strictObject({ instrument: maybe(T.name), scale: maybe(T.name), score: maybe(T.short), percentile: maybe(T.short), level: maybe(T.name) })).max(MAX_MAP_LIST),
        evidence: ClaimsZ(),
        impact: maybe(),
      }),
    )
    .max(MAP_PART_LIMITS.deficits),
  strengths: z.array(z.strictObject({ key: KeyZ, text: maybe(), kind: maybe(T.short), setting: maybe(T.name) })).max(MAP_PART_LIMITS.strengths),
  facts: z.array(z.strictObject({ key: KeyZ, text: maybe(), homeSection: HomeSectionZ })).max(MAP_PART_LIMITS.facts),
  openItems: z.array(OpenItemZ).max(MAP_PART_LIMITS.openItems),
  report: z
    .array(z.strictObject({ kind: z.enum(REPORT_ITEM_KINDS), text: z.string().max(T.text), sections: z.array(z.string().max(64)).max(22), refs: z.array(RefZ).max(MAX_MAP_REFS) }))
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
          evidence: z.array(z.strictObject({ tool: z.enum(EVIDENCE_TOOLS), respondent: TextOrNullZ(T.name), result: maybe(), supports: z.array(z.enum(FUNCTION_NAMES)).max(5) })).max(MAX_MAP_LIST),
          reasoning: TextOrNullZ(T.text),
          check: TextOrNullZ(T.text),
        }),
        barriers: z.array(z.enum(BARRIER_TAGS)).max(9),
        risks: ClaimsZ(),
      }),
    )
    .max(MAP_PART_LIMITS.behaviors),
  groups: z
    .array(z.strictObject({ key: KeyZ, behaviorKeys: z.array(KeyZ).max(MAX_MAP_LIST), nature: z.string().max(T.name), function: orNone(FUNCTION_NAMES), measure: orNone(MEASURES), reason: z.string().max(T.text) }))
    .max(MAX_MAP_GROUPS),
  risks: z.array(z.strictObject({ key: KeyZ, behaviorKeys: z.array(KeyZ).max(MAX_MAP_LIST), what: maybe(), evidence: ClaimsZ(), level: maybe(T.name) })).max(MAP_PART_LIMITS.risks),
  openItems: z.array(OpenItemZ).max(MAP_PART_LIMITS.openItems),
});

export type FactsAnswer = z.output<typeof FactsAnswerSchema>;
export type BehaviorsAnswer = z.output<typeof BehaviorsAnswerSchema>;
export type MapAnswer = FactsAnswer | BehaviorsAnswer;
export type AnswerRef = z.infer<typeof RefZ>;
export type AnswerClaim = ReturnType<typeof finish>;

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
  for (const note of notesOfEmptyValues(value)) {
    if (answer.openItems.length >= MAP_PART_LIMITS.openItems) break;
    if (!answer.openItems.some((item) => item.text === note)) answer.openItems.push({ kind: "check", text: note.slice(0, T.text), homeSection: null });
  }
  return { ok: true, answer, raw: value as Record<string, unknown> };
}

/** The checks written on empty values ("" with a check), with where each was: "client.severityLevel: the evaluation gives no level". */
function notesOfEmptyValues(value: unknown, where = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((entry, index) => notesOfEmptyValues(entry, `${where}[${index}]`));
  if (!isPlain(value)) return [];
  if (typeof value.value === "string" && Array.isArray(value.refs)) {
    return value.value.trim() === "" && typeof value.check === "string" && value.check.trim() !== "" ? [`${where}: ${value.check.trim()}`] : [];
  }
  return Object.entries(value).flatMap(([key, entry]) => notesOfEmptyValues(entry, where ? `${where}.${key}` : key));
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
  /** Claims with a number found only in a PDF's quote, which cannot be checked yet: not a problem, but marked [CHECK] (review round 2, S1). */
  pdfNumbers: Set<AnswerClaim>;
  /** The items with a problem, by list ("client", "caregivers", "behaviors", "report", …) and index: what a repair asks about. */
  failing: Map<string, Set<number>>;
  /** A problem that belongs to no single item (a key used twice): the repair asks about the whole answer. */
  whole: boolean;
}

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
  const pdfNumbers = new Set<AnswerClaim>();
  const failing = new Map<string, Set<number>>();
  let whole = false;
  const sources = new Map(context.sources.map((source) => [source.id, source]));
  const sourceTexts = new Map(context.sources.filter((source) => source.text !== null).map((source) => [source.id, normalizeForQuote(source.text ?? "")]));
  const sectionTexts = new Map(context.sections.map((section) => [section.id, normalizeForQuote(section.text)]));
  const notes = normalizeForQuote(context.notes);
  const thresholdNumbers = new Set(numbersIn(context.instructions ?? ""));
  const knownBehaviors = context.behaviorIds ?? new Set<string>();

  /** A problem, located: "settings[2].kind" marks settings item 2 as failing; "client.age" the client. */
  const problem = (where: string, message: string) => {
    problems.push(`${where}: ${message}`);
    const listed = /^([a-zA-Z]+)\[(\d+)\]/u.exec(where);
    if (listed && (LISTS as readonly string[]).includes(listed[1])) {
      const set = failing.get(listed[1]) ?? new Set<number>();
      set.add(Number(listed[2]));
      failing.set(listed[1], set);
    } else if (where.startsWith("client")) failing.set("client", new Set([0]));
    else whole = true;
  };

  const checkRef = (ref: AnswerRef, where: string) => {
    const quote = normalizeForQuote(ref.quote);
    const fail = (message: string) => {
      problem(where, message);
      quotes.set(ref, "not-found");
    };
    if (quote === "") return fail("a ref has an empty quote.");
    let text: string | undefined;
    let place: string;
    if (ref.kind === "source") {
      const source = sources.get(ref.id);
      if (!source) return fail(`"${ref.id}" is not the id of a source that was sent.`);
      if (source.text === null) return void quotes.set(ref, "not-checked");
      text = sourceTexts.get(ref.id);
      place = `the source "${source.title}"`;
    } else if (ref.kind === "section") {
      text = sectionTexts.get(ref.id);
      if (text === undefined) return fail(`"${ref.id}" is not one of her sections that were sent.`);
      place = `her section "${ref.id}"`;
    } else {
      text = notes;
      place = "her session notes";
    }
    const words = quote.split(" ").filter((word) => /[\p{L}\p{N}]/u.test(word));
    if (words.length < MIN_QUOTE_WORDS || !words.some((word) => /\p{L}/u.test(word))) {
      return fail(`the quote "${ref.quote.slice(0, 80)}" is too short: copy at least ${MIN_QUOTE_WORDS} words, with words around the value.`);
    }
    if (text?.includes(quote)) return void quotes.set(ref, "found");
    return fail(`the quote "${ref.quote.slice(0, 80)}" is not found word for word in ${place}.`);
  };

  const visitClaim = (claim: AnswerClaim | null, where: string, options: { threshold?: boolean } = {}) => {
    if (!claim) return;
    claim.refs.forEach((ref, index) => checkRef(ref, `${where}.refs[${index}]`));
    if ((claim.origin === "extracted" || claim.origin === "her") && claim.refs.length === 0) problem(where, "a value a source or her text states needs a ref with its quote.");
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
    if (options.threshold && THRESHOLD.test(claim.value) && thresholdNumbers.size === 0) {
      problem(where, `"${claim.value.slice(0, 80)}" gives a threshold that no standing instruction gives: write [MISSING: your threshold for …] in its place.`);
    } else {
      problem(where, `the number ${missing.map((number) => number.replace(/^d:/u, "")).join(", ")} in "${claim.value.slice(0, 80)}" is not written in any of its quotes.`);
    }
  };
  const visitAll = (claims: readonly AnswerClaim[], where: string) => claims.forEach((claim, index) => visitClaim(claim, `${where}[${index}]`));
  const uniqueKeys = (items: ReadonlyArray<{ key: string }>, where: string) => {
    const seen = new Set<string>();
    for (const item of items) {
      if (seen.has(item.key)) problem(where, `the key "${item.key}" is used twice.`);
      seen.add(item.key);
    }
  };
  const oneOf = (claim: AnswerClaim | null, values: readonly string[], where: string) => {
    if (claim && !values.includes(claim.value)) problem(where, `"${claim.value}" is not one of ${values.join(", ")}.`);
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
      item.scores.forEach((score, at) => {
        const where = `deficits[${index}].scores[${at}]`;
        for (const key of ["instrument", "scale", "score", "percentile", "level"] as const) visitClaim(score[key], `${where}.${key}`);
      });
    });
    facts.strengths.forEach((item, index) => {
      for (const key of ["text", "kind", "setting"] as const) visitClaim(item[key], `strengths[${index}].${key}`);
      oneOf(item.kind, STRENGTH_KINDS, `strengths[${index}].kind`);
    });
    facts.facts.forEach((item, index) => visitClaim(item.text, `facts[${index}].text`));
    facts.report.forEach((item, index) => {
      item.refs.forEach((ref, at) => checkRef(ref, `report[${index}].refs[${at}]`));
      for (const id of item.sections) if (!sectionTexts.has(id)) problem(`report[${index}]`, `"${id}" is not one of her sections that were sent.`);
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
      behavior.function.evidence.forEach((entry, at) => visitClaim(entry.result, `${where}.function.evidence[${at}].result`));
      for (const id of behavior.settingIds) if (!context.settingIds.has(id)) problem(`${where}.settingIds`, `"${id}" is not the id of a setting in <map-facts>.`);
      const both = behavior.function.primary.filter((name) => behavior.function.secondary.includes(name));
      if (both.length > 0) problem(`${where}.function`, `${both.join(", ")} is both primary and secondary.`);
    });
    const grouped = new Map<string, string>();
    const byKey = new Map(found.behaviors.map((behavior) => [behavior.key, behavior]));
    found.groups.forEach((group, index) => {
      const where = `groups[${index}]`;
      for (const key of group.behaviorKeys) {
        if (!named(key)) problem(where, `"${key}" is not the key of a behavior in this answer or the id of one in the map.`);
        if (grouped.has(key)) problem(where, `the behavior "${key}" is in two groups (${grouped.get(key)} and ${group.key}).`);
        grouped.set(key, group.key);
        // Her rule: one function and one measure for the whole group (review round 1, S8).
        const member = byKey.get(key);
        if (!member) continue;
        if (group.function && !member.function.primary.includes(group.function)) problem(where, `the group's function ${group.function} is not a primary function of "${key}".`);
        if (group.measure && member.measure && member.measure.value !== group.measure) problem(where, `the group's measure ${group.measure} is not the measure of "${key}" (${member.measure.value}).`);
      }
    });
    found.risks.forEach((risk, index) => {
      visitClaim(risk.what, `risks[${index}].what`);
      visitClaim(risk.level, `risks[${index}].level`);
      visitAll(risk.evidence, `risks[${index}].evidence`);
      for (const key of risk.behaviorKeys) if (!named(key)) problem(`risks[${index}]`, `"${key}" is not the key of a behavior in this answer or the id of one in the map.`);
    });
    uniqueKeys(found.behaviors, "behaviors");
    uniqueKeys(found.groups, "groups (keys)");
    uniqueKeys(found.risks, "risks (keys)");
  }
  return { problems: [...new Set(problems)], quotes, numbers, pdfNumbers, failing, whole };
}

/* The repair (review round 1, B1): only the items that failed are asked about, and the answer is merged back by key */

/** An absent claim, as the wire form writes it. */
const EMPTY_CLAIM = { value: "", refs: [], origin: "extracted", check: "" };

/**
 * The part of an answer a repair quotes: the items that failed, in the request's shape,
 * every other list empty (and the client's values empty unless the client failed). The
 * whole answer when a problem belongs to no single item.
 */
export function failingItems(kind: MapRequestKind, raw: Record<string, unknown>, checks: CheckResult): Record<string, unknown> {
  if (checks.whole) return raw;
  const pick = (list: string) => {
    const items = Array.isArray(raw[list]) ? (raw[list] as unknown[]) : [];
    const wanted = checks.failing.get(list) ?? new Set<number>();
    return items.filter((_item, index) => wanted.has(index));
  };
  if (kind === "map-facts") {
    const client = checks.failing.has("client") ? raw.client : emptyClient();
    return { client, caregivers: pick("caregivers"), settings: pick("settings"), deficits: pick("deficits"), strengths: pick("strengths"), facts: pick("facts"), openItems: [], report: pick("report") };
  }
  return { behaviors: pick("behaviors"), groups: pick("groups"), risks: pick("risks"), openItems: [] };
}

function emptyClient(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ["age", "diagnosis", "severityLevel", "evaluator", "evaluationDate", "school", "grade", "schedule", "iep"]) out[key] = EMPTY_CLAIM;
  return { ...out, medications: [], otherServices: [], languages: [] };
}

const isPlain = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const emptyValue = (value: unknown) => value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0);

/**
 * One item of the first answer with the repair's version over it, field by field (review
 * round 2, S2): a field the repair gives replaces the first answer's; a field the repair
 * leaves empty keeps the first answer's value, which the checks then flag again as before.
 * A claim (an object with a value) is one field; other objects (a baseline, a function) are
 * merged field by field too.
 */
export function mergeFields<T>(first: T, repaired: T): T {
  if (!isPlain(first) || !isPlain(repaired) || "value" in repaired) return emptyValue(repaired) ? first : repaired;
  const out: Record<string, unknown> = { ...repaired };
  for (const [key, value] of Object.entries(first)) {
    const next = repaired[key];
    if (emptyValue(next)) out[key] = value;
    else if (isPlain(value) && isPlain(next) && !("value" in next)) out[key] = mergeFields(value, next);
  }
  return out as T;
}

/**
 * Items by key. After a repair about some items: the first answer's list, each item merged
 * field by field with the repair's item of the same key, then the repair's new keys. After a
 * whole-answer repair: the repair's list first, merged the same way, then the first answer's
 * keys it lacks, once each, so a key the first answer used twice is not doubled (review round 2, M2).
 */
function mergeKeyed<T extends { key: string }>(first: readonly T[], repaired: readonly T[], whole: boolean): T[] {
  const firstByKey = new Map<string, T>();
  for (const item of first) if (!firstByKey.has(item.key)) firstByKey.set(item.key, item);
  if (whole) {
    const out = repaired.map((item) => (firstByKey.has(item.key) ? mergeFields(firstByKey.get(item.key)!, item) : item));
    const present = new Set(repaired.map((item) => item.key));
    for (const [key, item] of firstByKey) if (!present.has(key)) out.push(item);
    return out;
  }
  const fromRepair = new Map(repaired.map((item) => [item.key, item]));
  const out = first.map((item) => (fromRepair.has(item.key) ? mergeFields(item, fromRepair.get(item.key)!) : item));
  for (const item of repaired) if (!firstByKey.has(item.key)) out.push(item);
  return out;
}

const sameText = (a: string, b: string) => normalizeForQuote(a) === normalizeForQuote(b);

/**
 * The first answer with the repair's items in place, by key (review round 1, B1). An item
 * the repair leaves out keeps the first answer's version, with its flags; nothing of the
 * first answer is lost. Unkeyed lists: the report's failed items are replaced by the
 * repair's report items when it gives any; open items are joined without repeats.
 */
export function mergeRepair(kind: MapRequestKind, first: MapAnswer, repaired: MapAnswer, failing: CheckResult["failing"], whole = false): MapAnswer {
  const joinOpen = <T extends { text: string }>(a: readonly T[], b: readonly T[]) => [...a, ...b.filter((item) => !a.some((other) => sameText(other.text, item.text)))];
  if (kind === "map-facts") {
    const a = first as FactsAnswer;
    const b = repaired as FactsAnswer;
    const failedReport = failing.get("report") ?? new Set<number>();
    return {
      client: a.client && b.client ? mergeFields(a.client, b.client) : (b.client ?? a.client),
      caregivers: mergeKeyed(a.caregivers, b.caregivers, whole),
      settings: mergeKeyed(a.settings, b.settings, whole),
      deficits: mergeKeyed(a.deficits, b.deficits, whole),
      strengths: mergeKeyed(a.strengths, b.strengths, whole),
      facts: mergeKeyed(a.facts, b.facts, whole),
      openItems: joinOpen(a.openItems, b.openItems),
      report: b.report.length > 0 ? [...a.report.filter((_item, index) => !failedReport.has(index)), ...b.report] : a.report,
    };
  }
  const a = first as BehaviorsAnswer;
  const b = repaired as BehaviorsAnswer;
  return {
    behaviors: mergeKeyed(a.behaviors, b.behaviors, whole),
    groups: mergeKeyed(a.groups, b.groups, whole),
    risks: mergeKeyed(a.risks, b.risks, whole),
    openItems: joinOpen(a.openItems, b.openItems),
  };
}
