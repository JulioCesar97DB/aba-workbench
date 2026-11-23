import { z } from "zod";
import { BARRIER_TAGS, EVIDENCE_TOOLS, FUNCTION_NAMES, MAP_PART_LIMITS, MAP_TEXT_LIMITS, MAX_MAP_GROUPS, MAX_MAP_LIST, MAX_MAP_REFS, MEASURES, OPEN_ITEM_KINDS, REPORT_ITEM_KINDS, SETTING_EVIDENCE, SETTING_KINDS, STRENGTH_KINDS } from "../shared/case-map.ts";

/*
 * The AI's drafts of the case map (step 1, pull request 2; owner's decisions D4, D12 to
 * D14, D32): the two requests, the JSON schema each answer must follow, its check with
 * Zod, and the code checks that follow (every quote found word for word in what it cites,
 * every number of a count or a score in one of its quotes, every link between items known).
 *
 * One schema per request, valid on both providers' structured outputs: every property
 * required, no other property allowed, null written as anyOf, enums for every fixed list,
 * no length or number limits (Claude does not take them; Zod checks them here), no
 * recursion. The same shape is asked for as plain JSON when a route refuses the schema.
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
const nullable = (schema: Schema): Schema => ({ anyOf: [schema, { type: "null" }] });
const list = (items: Schema): Schema => ({ type: "array", items });
const choice = (values: readonly string[]): Schema => ({ type: "string", enum: [...values] });
function object(properties: Record<string, Schema>): Schema {
  return { type: "object", additionalProperties: false, required: Object.keys(properties), properties };
}

const SERVICE_PAID = ["paid", "not-paid"] as const;
const ORIGIN_VALUES = ["extracted", "her", "ai-drafted", "hypothesis", "proposed"] as const;
const REF_KINDS = ["source", "section", "note"] as const;

const refSchema = object({ kind: choice(REF_KINDS), id: str, quote: str });
const claimSchema = object({ value: str, refs: list(refSchema), origin: choice(ORIGIN_VALUES), check: nullable(str) });
const maybeClaim = nullable(claimSchema);
const claims = list(claimSchema);
/** A claim whose value is one of a fixed list: the list is in the schema, so a strict route cannot answer anything else. */
const choiceClaim = (values: readonly string[]): Schema => nullable(object({ value: choice(values), refs: list(refSchema), origin: choice(ORIGIN_VALUES), check: nullable(str) }));
const openItemSchema = object({ kind: choice(OPEN_ITEM_KINDS), text: str, homeSection: nullable(int) });

const factsSchema = object({
  client: nullable(
    object({
      age: maybeClaim,
      diagnosis: maybeClaim,
      severityLevel: maybeClaim,
      evaluator: maybeClaim,
      evaluationDate: maybeClaim,
      medications: claims,
      school: maybeClaim,
      grade: maybeClaim,
      schedule: maybeClaim,
      iep: maybeClaim,
      otherServices: list(object({ name: claimSchema, provider: maybeClaim, paid: choiceClaim(SERVICE_PAID) })),
      languages: claims,
    }),
  ),
  caregivers: list(object({ key: str, role: maybeClaim, language: maybeClaim, availability: maybeClaim, participation: maybeClaim, limits: maybeClaim, mitigation: maybeClaim })),
  settings: list(object({ key: str, name: maybeClaim, kind: choiceClaim(SETTING_KINDS), evidence: choiceClaim(SETTING_EVIDENCE), by: maybeClaim, dates: maybeClaim })),
  deficits: list(
    object({
      key: str,
      area: maybeClaim,
      scores: list(object({ instrument: maybeClaim, scale: maybeClaim, score: maybeClaim, percentile: maybeClaim, level: maybeClaim })),
      evidence: claims,
      impact: maybeClaim,
    }),
  ),
  strengths: list(object({ key: str, text: maybeClaim, kind: choiceClaim(STRENGTH_KINDS), setting: maybeClaim })),
  facts: list(object({ key: str, text: maybeClaim, homeSection: nullable(int) })),
  openItems: list(openItemSchema),
  report: list(object({ kind: choice(REPORT_ITEM_KINDS), text: str, sections: list(str), refs: list(refSchema) })),
});

const behaviorsSchema = object({
  behaviors: list(
    object({
      key: str,
      name: maybeClaim,
      topographies: claims,
      measure: maybeClaim,
      definition: maybeClaim,
      onset: maybeClaim,
      offset: maybeClaim,
      examples: claims,
      nonExamples: claims,
      baseline: object({ observations: list(object({ date: maybeClaim, setting: maybeClaim, minutes: maybeClaim, value: maybeClaim })), other: claims }),
      settingIds: list(str),
      antecedents: claims,
      consequences: claims,
      function: object({
        primary: list(choice(FUNCTION_NAMES)),
        secondary: list(choice(FUNCTION_NAMES)),
        evidence: list(object({ tool: choice(EVIDENCE_TOOLS), respondent: nullable(str), result: maybeClaim, supports: list(choice(FUNCTION_NAMES)) })),
        reasoning: nullable(str),
        check: nullable(str),
      }),
      barriers: list(choice(BARRIER_TAGS)),
      risks: claims,
    }),
  ),
  groups: list(object({ key: str, behaviorKeys: list(str), nature: str, function: nullable(choice(FUNCTION_NAMES)), measure: nullable(choice(MEASURES)), reason: str })),
  risks: list(object({ key: str, behaviorKeys: list(str), what: maybeClaim, evidence: claims, level: maybeClaim })),
  openItems: list(openItemSchema),
});

export function mapAnswerSchema(kind: MapRequestKind): Schema {
  return kind === "map-facts" ? factsSchema : behaviorsSchema;
}

/* The same shape, checked with Zod, with the map's limits (D6) */

const T = MAP_TEXT_LIMITS;
const RefZ = z.strictObject({ kind: z.enum(REF_KINDS), id: z.string().max(64), quote: z.string().max(T.quote) });
const claimZ = (max: number = T.text) => z.strictObject({ value: z.string().max(max), refs: z.array(RefZ).max(MAX_MAP_REFS), origin: z.enum(ORIGIN_VALUES), check: z.string().max(T.text).nullable() });
const maybe = (max: number = T.text) => claimZ(max).nullable();
const ClaimsZ = (max: number = T.text) => z.array(claimZ(max)).max(MAX_MAP_LIST);
const KeyZ = z.string().min(1).max(40);
const OpenItemZ = z.strictObject({ kind: z.enum(OPEN_ITEM_KINDS), text: z.string().max(T.text), homeSection: z.int().min(1).max(22).nullable() });

export const FactsAnswerSchema = z.strictObject({
  client: z
    .strictObject({
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
      otherServices: z.array(z.strictObject({ name: claimZ(T.name), provider: maybe(T.name), paid: maybe(T.short) })).max(MAX_MAP_LIST),
      languages: ClaimsZ(T.name),
    })
    .nullable(),
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
  facts: z.array(z.strictObject({ key: KeyZ, text: maybe(), homeSection: z.int().min(1).max(22).nullable() })).max(MAP_PART_LIMITS.facts),
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
          observations: z.array(z.strictObject({ date: maybe(T.short), setting: maybe(T.name), minutes: maybe(T.short), value: maybe(T.short) })).max(MAX_MAP_LIST),
          other: ClaimsZ(),
        }),
        settingIds: z.array(z.string().max(40)).max(MAX_MAP_LIST),
        antecedents: ClaimsZ(),
        consequences: ClaimsZ(),
        function: z.strictObject({
          primary: z.array(z.enum(FUNCTION_NAMES)).max(5),
          secondary: z.array(z.enum(FUNCTION_NAMES)).max(5),
          evidence: z.array(z.strictObject({ tool: z.enum(EVIDENCE_TOOLS), respondent: z.string().max(T.name).nullable(), result: maybe(), supports: z.array(z.enum(FUNCTION_NAMES)).max(5) })).max(MAX_MAP_LIST),
          reasoning: z.string().max(T.text).nullable(),
          check: z.string().max(T.text).nullable(),
        }),
        barriers: z.array(z.enum(BARRIER_TAGS)).max(9),
        risks: ClaimsZ(),
      }),
    )
    .max(MAP_PART_LIMITS.behaviors),
  groups: z
    .array(z.strictObject({ key: KeyZ, behaviorKeys: z.array(KeyZ).max(MAX_MAP_LIST), nature: z.string().max(T.name), function: z.enum(FUNCTION_NAMES).nullable(), measure: z.enum(MEASURES).nullable(), reason: z.string().max(T.text) }))
    .max(MAX_MAP_GROUPS),
  risks: z.array(z.strictObject({ key: KeyZ, behaviorKeys: z.array(KeyZ).max(MAX_MAP_LIST), what: maybe(), evidence: ClaimsZ(), level: maybe(T.name) })).max(MAP_PART_LIMITS.risks),
  openItems: z.array(OpenItemZ).max(MAP_PART_LIMITS.openItems),
});

export type FactsAnswer = z.infer<typeof FactsAnswerSchema>;
export type BehaviorsAnswer = z.infer<typeof BehaviorsAnswerSchema>;
export type MapAnswer = FactsAnswer | BehaviorsAnswer;
export type AnswerClaim = z.infer<ReturnType<typeof claimZ>>;
export type AnswerRef = z.infer<typeof RefZ>;

/** The JSON object in an answer: the whole text, a fenced block, or the text from the first { to the last }. */
function jsonText(answer: string): string {
  const trimmed = answer.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/u.exec(trimmed);
  if (fenced) return fenced[1];
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  return start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
}

/** Reads an answer: valid JSON in the request's shape and within the limits. The problems are what the repair request says. */
export function parseMapAnswer(kind: MapRequestKind, text: string): { ok: true; answer: MapAnswer } | { ok: false; problems: string[] } {
  let value: unknown;
  try {
    value = JSON.parse(jsonText(text));
  } catch {
    return { ok: false, problems: ["The answer is not valid JSON."] };
  }
  const parsed = (kind === "map-facts" ? FactsAnswerSchema : BehaviorsAnswerSchema).safeParse(value);
  if (!parsed.success) return { ok: false, problems: parsed.error.issues.slice(0, 20).map((issue) => `${issue.path.join(".") || "(answer)"}: ${issue.message}`) };
  return { ok: true, answer: parsed.data };
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
}

/** How a ref's quote was checked. */
export type QuoteCheck = "found" | "not-found" | "not-checked";

/** Text as compared for quotes: one kind of quote mark, of dash and of space, lower case. */
export function normalizeForQuote(text: string): string {
  return text
    .normalize("NFC")
    .replace(/[\u{2018}\u{2019}\u{201A}\u{201B}\u{2032}]/gu, "'")
    .replace(/[\u{201C}\u{201D}\u{201E}\u{201F}\u{2033}]/gu, '"')
    .replace(/[\u{2010}-\u{2015}\u{2212}]/gu, "-")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

/** Every number written in a text, as plain digits ("3", "4.5", "75"). */
function numbersIn(text: string): string[] {
  return [...text.matchAll(/\d+(?:[.,]\d+)?/g)].map((match) => match[0].replace(",", "."));
}

export interface CheckResult {
  /** What the repair request says; empty when the answer passes. */
  problems: string[];
  /** Each ref's quote check, by the ref object itself. */
  quotes: Map<AnswerRef, QuoteCheck>;
  /** Claims whose number is in none of their quotes. */
  numbers: Set<AnswerClaim>;
}

/**
 * The checks after Zod: every ref names a place that was sent and quotes it word for word
 * (a PDF's quotes are not checked yet); every count, minute and score is written in one of
 * its quotes; every link between items is known; keys are unique.
 */
export function checkMapAnswer(kind: MapRequestKind, answer: MapAnswer, context: CheckContext): CheckResult {
  const problems: string[] = [];
  const quotes = new Map<AnswerRef, QuoteCheck>();
  const numbers = new Set<AnswerClaim>();
  const sources = new Map(context.sources.map((source) => [source.id, source]));
  const sourceTexts = new Map(context.sources.filter((source) => source.text !== null).map((source) => [source.id, normalizeForQuote(source.text ?? "")]));
  const sectionTexts = new Map(context.sections.map((section) => [section.id, normalizeForQuote(section.text)]));
  const notes = normalizeForQuote(context.notes);

  const checkRef = (ref: AnswerRef, where: string) => {
    const quote = normalizeForQuote(ref.quote);
    const fail = (message: string) => {
      problems.push(`${where}: ${message}`);
      quotes.set(ref, "not-found");
    };
    if (quote === "") return fail("a ref has an empty quote.");
    if (ref.kind === "source") {
      const source = sources.get(ref.id);
      if (!source) return fail(`"${ref.id}" is not the id of a source that was sent.`);
      if (source.text === null) return void quotes.set(ref, "not-checked");
      if (sourceTexts.get(ref.id)?.includes(quote)) return void quotes.set(ref, "found");
      return fail(`the quote "${ref.quote.slice(0, 80)}" is not found word for word in the source "${source.title}".`);
    }
    if (ref.kind === "section") {
      const text = sectionTexts.get(ref.id);
      if (text === undefined) return fail(`"${ref.id}" is not one of her sections that were sent.`);
      if (text.includes(quote)) return void quotes.set(ref, "found");
      return fail(`the quote "${ref.quote.slice(0, 80)}" is not found word for word in her section "${ref.id}".`);
    }
    if (notes.includes(quote)) return void quotes.set(ref, "found");
    return fail(`the quote "${ref.quote.slice(0, 80)}" is not found word for word in her session notes.`);
  };

  const visitClaim = (claim: AnswerClaim | null, where: string, numeric = false) => {
    if (!claim) return;
    claim.refs.forEach((ref, index) => checkRef(ref, `${where}.refs[${index}]`));
    if (!numeric) return;
    const wanted = numbersIn(claim.value);
    const quoted = new Set(claim.refs.flatMap((ref) => numbersIn(ref.quote)));
    const pdfOnly = claim.refs.length > 0 && claim.refs.every((ref) => quotes.get(ref) === "not-checked");
    if (wanted.length > 0 && !pdfOnly && !wanted.every((number) => quoted.has(number))) {
      numbers.add(claim);
      problems.push(`${where}: the number "${claim.value}" is not written in any of its quotes.`);
    }
  };
  const visitAll = (claims: readonly AnswerClaim[], where: string) => claims.forEach((claim, index) => visitClaim(claim, `${where}[${index}]`));
  const uniqueKeys = (items: ReadonlyArray<{ key: string }>, where: string) => {
    const seen = new Set<string>();
    for (const item of items) {
      if (seen.has(item.key)) problems.push(`${where}: the key "${item.key}" is used twice.`);
      seen.add(item.key);
    }
  };
  const oneOf = (claim: AnswerClaim | null, values: readonly string[], where: string) => {
    if (claim && !values.includes(claim.value)) problems.push(`${where}: "${claim.value}" is not one of ${values.join(", ")}.`);
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
        visitClaim(score.instrument, `${where}.instrument`);
        visitClaim(score.scale, `${where}.scale`);
        visitClaim(score.score, `${where}.score`, true);
        visitClaim(score.percentile, `${where}.percentile`, true);
        visitClaim(score.level, `${where}.level`);
      });
    });
    facts.strengths.forEach((item, index) => {
      for (const key of ["text", "kind", "setting"] as const) visitClaim(item[key], `strengths[${index}].${key}`);
      oneOf(item.kind, STRENGTH_KINDS, `strengths[${index}].kind`);
    });
    facts.facts.forEach((item, index) => visitClaim(item.text, `facts[${index}].text`));
    facts.report.forEach((item, index) => {
      item.refs.forEach((ref, at) => checkRef(ref, `report[${index}].refs[${at}]`));
      for (const id of item.sections) if (!sectionTexts.has(id)) problems.push(`report[${index}]: "${id}" is not one of her sections that were sent.`);
    });
    uniqueKeys(facts.caregivers, "caregivers");
    uniqueKeys(facts.settings, "settings");
    uniqueKeys(facts.deficits, "deficits");
    uniqueKeys(facts.strengths, "strengths");
    uniqueKeys(facts.facts, "facts");
  } else {
    const found = answer as BehaviorsAnswer;
    const behaviorKeys = new Set(found.behaviors.map((behavior) => behavior.key));
    found.behaviors.forEach((behavior, index) => {
      const where = `behaviors[${index}]`;
      for (const key of ["name", "measure", "definition", "onset", "offset"] as const) visitClaim(behavior[key], `${where}.${key}`);
      oneOf(behavior.measure, MEASURES, `${where}.measure`);
      for (const key of ["topographies", "examples", "nonExamples", "antecedents", "consequences", "risks"] as const) visitAll(behavior[key], `${where}.${key}`);
      behavior.baseline.observations.forEach((observation, at) => {
        const place = `${where}.baseline.observations[${at}]`;
        visitClaim(observation.date, `${place}.date`);
        visitClaim(observation.setting, `${place}.setting`);
        visitClaim(observation.minutes, `${place}.minutes`, true);
        visitClaim(observation.value, `${place}.value`, true);
      });
      visitAll(behavior.baseline.other, `${where}.baseline.other`);
      behavior.function.evidence.forEach((entry, at) => visitClaim(entry.result, `${where}.function.evidence[${at}].result`));
      for (const id of behavior.settingIds) if (!context.settingIds.has(id)) problems.push(`${where}.settingIds: "${id}" is not a setting of the map.`);
      const both = behavior.function.primary.filter((name) => behavior.function.secondary.includes(name));
      if (both.length > 0) problems.push(`${where}.function: ${both.join(", ")} is both primary and secondary.`);
    });
    const grouped = new Map<string, string>();
    found.groups.forEach((group, index) => {
      for (const key of group.behaviorKeys) {
        if (!behaviorKeys.has(key)) problems.push(`groups[${index}]: "${key}" is not the key of a behavior in this answer.`);
        if (grouped.has(key)) problems.push(`groups: the behavior "${key}" is in two groups (${grouped.get(key)} and ${group.key}).`);
        grouped.set(key, group.key);
      }
    });
    found.risks.forEach((risk, index) => {
      visitClaim(risk.what, `risks[${index}].what`);
      visitClaim(risk.level, `risks[${index}].level`);
      visitAll(risk.evidence, `risks[${index}].evidence`);
      for (const key of risk.behaviorKeys) if (!behaviorKeys.has(key)) problems.push(`risks[${index}]: "${key}" is not the key of a behavior in this answer.`);
    });
    uniqueKeys(found.behaviors, "behaviors");
    uniqueKeys(found.groups, "groups");
    uniqueKeys(found.risks, "risks");
  }
  return { problems: [...new Set(problems)], quotes, numbers };
}
