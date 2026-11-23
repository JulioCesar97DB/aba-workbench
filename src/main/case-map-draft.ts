import { randomUUID } from "node:crypto";
import { checkMapAnswer, failingItems, MAP_SCHEMA_NAMES, mapAnswerSchema, mergeRepair, parseMapAnswer, PARTS_OF_REQUEST, type AnswerClaim, type AnswerRef, type BehaviorsAnswer, type CheckResult, type FactsAnswer, type MapAnswer, type MapAnswerFormat } from "../lib/case-map-extraction.ts";
import { generationCostUsd } from "../lib/pricing.ts";
import type { Effort, Provider, ProviderCredential, TokenUsage } from "../lib/providers/types.ts";
import type { DraftingProvider, GenerationUpdateEvent } from "../shared/api.ts";
import { minutesOfLength, type MapPartId, type MapRequestKind } from "../shared/case-map.ts";
import { REPORT_SECTIONS } from "../shared/report-sections.ts";
import type { CaseData } from "./case-file.ts";
import { applyMapAnswer, caseMapSummary, caseMapView, herMapForPrompt, mapFactsForPrompt, partsWithVersions, type AnswerItem, type AnswerPart, type MapExtractionRecord } from "./case-map.ts";
import { finalVersion, sessionNotes } from "./case-sections.ts";
import type { CaseLibrary } from "./cases.ts";
import { caseCacheKey } from "./cache-key.ts";
import { outgoingSourcesOf, prepareMapRequest, type OutgoingSource } from "./outgoing.ts";
import { runSectionGeneration, type FinishedText } from "./section-generation.ts";

/*
 * "Draft the map" / "Update the map" (step 1, pull request 2; D4, D5, D12 to D14, D32):
 * two requests, one after the other, each prepared by src/main/outgoing.ts like every
 * request about a case. Each answer is asked for in a JSON schema the provider enforces
 * (plain JSON when a route refuses it), read with Zod, then checked by code: every quote
 * found word for word in what it cites (a PDF's quotes are "not checked" until PDF text
 * can be read), every number in one of its quotes, every link known. An answer with
 * problems gets one repair request about the items that failed; the repair's items replace
 * those of the first answer by key, and when the repair cannot be used the first answer is
 * saved as it is. What still fails is saved and flagged with a [CHECK]. Each request's
 * parts are saved as soon as they pass, as new versions.
 */

type RunEvent = Exclude<GenerationUpdateEvent, { type: "finished" }>;

/** Same settings as every section request (review M4), so the cached prefix is shared. */
const EFFORT: Effort = "high";
/** A real case's map answer runs to 20,000 tokens and more, and Claude's thinking shares the cap (review round 1, S5). */
const MAX_OUTPUT_TOKENS = 64_000;
/** How often the progress line moves while the answer arrives, in characters. */
const PROGRESS_STEP = 1_500;
/** A route that refused the JSON schema is asked for plain JSON from then on, for the rest of the app's run. */
const formats = new Map<DraftingProvider, MapAnswerFormat>();

/** For the tests: forget what the routes refused. */
export function resetMapFormats(): void {
  formats.clear();
}

export interface MapDraftOptions {
  cases: Pick<CaseLibrary, "changeCase">;
  caseId: string;
  rulesDir: string;
  providerId: DraftingProvider;
  provider: Provider;
  credential: ProviderCredential;
  model: string;
  /** Her standing instructions for the map (her thresholds); empty until she confirms them (D16). */
  instructions: string;
  signal: AbortSignal;
  log: (message: string) => void;
}

interface RequestOutcome {
  answer: MapAnswer;
  checks: CheckResult;
  format: MapAnswerFormat;
  repaired: boolean;
  repairUsed: boolean;
  problemsBeforeRepair: string[];
  generation: Record<string, unknown>;
}

const zeroUsage: TokenUsage = { uncachedInputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0, reasoningTokens: null };
function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    uncachedInputTokens: a.uncachedInputTokens + b.uncachedInputTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens === null && b.reasoningTokens === null ? null : (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0),
  };
}

/** Her sections that are hers or approved, in the report's order, with their versions. */
function herSectionsOf(data: CaseData) {
  return REPORT_SECTIONS.flatMap((section) => {
    const version = finalVersion(data, section.id);
    return version && version.text.trim() !== "" ? [{ id: section.id, title: section.title, text: version.text, version: version.number }] : [];
  });
}

async function readCase(options: MapDraftOptions): Promise<{ data: CaseData; folder: string } | null> {
  const read = await options.cases.changeCase(options.caseId, () => ({ save: null, value: null }));
  return read.kind === "saved" || read.kind === "unchanged" ? { data: read.data, folder: read.folder } : null;
}

/**
 * A route that refused the JSON schema: a 400 or an "unsupported" answer that names the
 * schema or the output format (review round 1, M5). Any other refusal (a PDF over a page
 * limit, a request too large) is reported as it is, and the route keeps its schema.
 */
export function refusedFormat(failure: { code: string; message: string }): boolean {
  return /bad_request|unsupported|invalid_request/.test(failure.code) && /schema|json_schema|output_config|output.format|text\.format|response_format|structured/i.test(failure.message);
}

/** The whole draft: the facts, then the behaviors, each saved as soon as it passes. */
export async function* runMapDraft(options: MapDraftOptions): AsyncGenerator<RunEvent> {
  const run = randomUUID();
  const start = await readCase(options);
  if (!start) {
    yield { type: "error", code: "case_unavailable", message: "The case could not be read.", status: null };
    return;
  }
  const before = partsWithVersions(start.data);
  for (const kind of ["map-facts", "map-behaviors"] as const) {
    const current = kind === "map-facts" ? start : await readCase(options);
    if (!current) {
      yield { type: "error", code: "case_unavailable", message: "The case could not be read.", status: null };
      return;
    }
    const outcome: RequestOutcome | null = yield* request(options, kind, current.data, current.folder);
    if (!outcome || options.signal.aborted) return;
    const notesSession = current.data.sessionNotes?.startedAt ?? null;
    const sectionVersions = new Map(herSectionsOf(current.data).map((section) => [section.id, section.version]));
    const facts = kind === "map-behaviors" ? mapFactsForPrompt(current.data) : null;
    const parts = toAnswerParts(kind, outcome.answer, outcome.checks, { notesSession, sectionVersions, settingIds: facts?.settingIds ?? new Set<string>(), behaviorIds: behaviorIdsOf(current.data) });
    const record: MapExtractionRecord = {
      id: randomUUID(),
      kind,
      at: "",
      run,
      generation: outcome.generation,
      format: outcome.format,
      repaired: outcome.repaired,
      ...(outcome.repaired ? { repairUsed: outcome.repairUsed, problemsBeforeRepair: outcome.problemsBeforeRepair } : {}),
      problems: outcome.checks.problems,
    };
    if (options.signal.aborted) return;
    let written: MapPartId[] = [];
    let kept: MapPartId[] = [];
    const saved = await options.cases.changeCase(options.caseId, (data, _folder, now) => {
      const applied = applyMapAnswer(data, parts, { ...record, at: now }, before, now);
      written = applied.written;
      kept = applied.kept;
      return { save: applied.data, value: null };
    });
    if (saved.kind === "unavailable") {
      yield { type: "error", code: "case_unavailable", message: "The case could not be read.", status: null };
      return;
    }
    const result = saved.kind === "failed" ? { outcome: saved.outcome } : { outcome: "saved" as const, map: caseMapView(saved.data), summary: caseMapSummary(saved.data), version: null, itemId: null };
    yield { type: "map-saved", step: kind, result, written, kept, problems: outcome.checks.problems.length };
    if (saved.kind === "failed") return;
  }
}

/** One request of the draft, with its plain-JSON resend and its one repair. Null when it failed (the error is reported). */
async function* request(options: MapDraftOptions, kind: MapRequestKind, data: CaseData, folder: string): AsyncGenerator<RunEvent, RequestOutcome | null> {
  const herSections = herSectionsOf(data);
  const sources: OutgoingSource[] = outgoingSourcesOf(data, folder);
  const facts = kind === "map-behaviors" ? mapFactsForPrompt(data) : null;
  const herMap = herMapForPrompt(data, PARTS_OF_REQUEST[kind]);
  const notes = sessionNotes(data);
  const context = {
    sources: sources.map((source) => ({ id: source.id, title: source.title, text: source.kind === "text" ? source.text : null })),
    sections: herSections,
    notes,
    settingIds: facts?.settingIds ?? new Set<string>(),
    behaviorIds: behaviorIdsOf(data),
    instructions: kind === "map-behaviors" ? options.instructions : "",
  };
  let format: MapAnswerFormat = formats.get(options.providerId) ?? "json-schema";
  /** The first answer that could be read, kept whatever the repair brings (review round 1, B1). */
  let first: { answer: MapAnswer; checks: CheckResult } | null = null;
  let repair: { previousAnswer: string; problems: string[]; whole: boolean } | null = null;
  let problemsBeforeRepair: string[] = [];
  let switched = false;
  let usage = zeroUsage;
  let cost: number | null = 0;
  let servedModel = options.model;
  let rulesVersions: Record<string, string> = {};
  let deidentified: unknown = null;
  const outcome = (answer: MapAnswer, checks: CheckResult, repairUsed: boolean): RequestOutcome => ({
    answer,
    checks,
    format,
    repaired: repair !== null,
    repairUsed,
    problemsBeforeRepair,
    generation: {
      provider: options.providerId,
      requestedModel: options.model,
      servedModel,
      effort: EFFORT,
      rulesVersions,
      sourcesUsed: sources.map(({ id, title }) => ({ id, title })),
      sectionsUsed: herSections.map(({ id, version }) => ({ id, version })),
      ...(kind === "map-behaviors" && options.instructions.trim() !== "" ? { instructions: options.instructions } : {}),
      ...(notes.trim() !== "" ? { notes } : {}),
      deidentified,
      usage,
      costUsd: cost,
    },
  });
  for (let attempt = 0; attempt < 4; attempt++) {
    const phase = repair ? "repairing" : switched ? "plain-json" : "writing";
    yield { type: "map-progress", step: kind, phase, characters: 0 };
    let prepared;
    try {
      prepared = await prepareMapRequest({
        kind,
        sources,
        herSections,
        herMap,
        instructions: kind === "map-behaviors" ? options.instructions : null,
        notes,
        mapFacts: facts?.text ?? null,
        format,
        repair,
        rulesDir: options.rulesDir,
      });
    } catch (error) {
      options.log(`A case map request could not be prepared (${(error as NodeJS.ErrnoException).code ?? "error"}).`);
      if (first) return outcome(first.answer, first.checks, false);
      yield { type: "error", code: "prepare_failed", message: "The case's sources could not be read.", status: null };
      return null;
    }
    rulesVersions = prepared.rulesVersions;
    deidentified = prepared.deidentified;
    let finished: FinishedText | null = null;
    let failure: { code: string; message: string; status: number | null } | null = null;
    let characters = 0;
    let shown = 0;
    for await (const event of runSectionGeneration<FinishedText>({
      prepared,
      provider: options.provider,
      credential: options.credential,
      model: options.model,
      effort: EFFORT,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      section: `case-map:${kind}`,
      signal: options.signal,
      cacheKey: options.credential.kind === "chatgpt" ? caseCacheKey(options.caseId) : null,
      outputFormat: format === "json-schema" ? { name: MAP_SCHEMA_NAMES[kind], schema: mapAnswerSchema(kind) } : null,
      save: async (text) => text,
    })) {
      if (event.type === "text") {
        characters += event.delta.length;
        if (characters - shown >= PROGRESS_STEP) {
          shown = characters;
          yield { type: "map-progress", step: kind, phase, characters };
        }
      } else if (event.type === "error") failure = event;
      else if (event.type === "refusal") yield event;
      else if (event.type === "done") {
        usage = addUsage(usage, event.usage);
        servedModel = event.servedModel;
        const spent = generationCostUsd(event.servedModel, event.usage, event.attempts);
        cost = cost === null || spent === null ? null : cost + spent;
      } else if (event.type === "saved") finished = event.result;
    }
    if (options.signal.aborted) return null;
    if (failure && format === "json-schema" && !switched && repair === null && refusedFormat(failure)) {
      // The route does not take the schema: the same request as plain JSON, checked the same way.
      format = "plain-json";
      switched = true;
      formats.set(options.providerId, "plain-json");
      continue;
    }
    if (failure || !finished) {
      // The repair failed or was cut short: the first answer is saved as it is, with its flags.
      if (first) return outcome(first.answer, first.checks, false);
      if (failure) yield { type: "error", code: failure.code, message: failure.message, status: failure.status };
      else yield { type: "error", code: "incomplete", message: "The answer was cut short or refused, so nothing was saved.", status: null };
      return null;
    }
    const parsed = parseMapAnswer(kind, finished.text);
    if (repair !== null) {
      if (!parsed.ok) {
        if (first) return outcome(first.answer, first.checks, false);
        yield { type: "error", code: "unreadable_answer", message: "The AI's answer could not be read, even after asking it again, so nothing was saved.", status: null };
        return null;
      }
      const answer = first ? mergeRepair(kind, first.answer, parsed.answer, first.checks.failing) : parsed.answer;
      return outcome(answer, checkMapAnswer(kind, answer, context), true);
    }
    if (parsed.ok) {
      const checks = checkMapAnswer(kind, parsed.answer, context);
      if (checks.problems.length === 0) return outcome(parsed.answer, checks, false);
      first = { answer: parsed.answer, checks };
      problemsBeforeRepair = checks.problems;
      repair = { previousAnswer: JSON.stringify(failingItems(kind, parsed.raw, checks)), problems: checks.problems.slice(0, 40), whole: checks.whole };
    } else {
      problemsBeforeRepair = parsed.problems;
      // The whole text, uncut: an answer that could not be read is asked again in full.
      repair = { previousAnswer: finished.text, problems: parsed.problems, whole: true };
    }
  }
  if (first) return outcome(first.answer, first.checks, false);
  yield { type: "error", code: "unreadable_answer", message: "The AI's answer could not be read, so nothing was saved.", status: null };
  return null;
}

/** The ids of the behaviors the map holds now: a group or a risk of an update may name them. */
function behaviorIdsOf(data: CaseData): Set<string> {
  return new Set(caseMapView(data).parts.behaviors.items.map((item) => (item as { id: string }).id));
}

/* From an answer to the map's stored shape */

interface ConvertContext {
  notesSession: string | null;
  sectionVersions: ReadonlyMap<string, number>;
  /** The settings the map has: a behavior's other setting links are left out, with an open item (review round 1, B2). */
  settingIds: ReadonlySet<string>;
  /** The behaviors the map has (an update's groups and risks may name them by id). */
  behaviorIds: ReadonlySet<string>;
}

const UNFOUND_CHECK = "A quote of this value was not found word for word in what it cites: check it against the source.";
const NUMBER_CHECK = "This number is not written in the quote it cites: check it against the source.";
const NO_REF_CHECK = "No quote supports this value: check it against the sources.";
const NOT_HERS_CHECK = "Marked as hers, but no quote of her section or her notes was found: check it.";

/** The answer's parts as the map stores them, with each item's key (src/main/case-map.ts turns keys into ids). */
export function toAnswerParts(kind: MapRequestKind, answer: MapAnswer, checks: CheckResult, context: ConvertContext): Partial<Record<MapPartId, AnswerPart>> {
  // A ref the checks never reached is not vouched for: "not-found", never the PDF's "not-checked" (review round 1, M6).
  const checkOf = (item: AnswerRef) => checks.quotes.get(item) ?? "not-found";
  const ref = (item: AnswerRef): Record<string, unknown> => {
    const checked = checkOf(item);
    if (item.kind === "source") return { kind: "source", sourceId: item.id, quote: item.quote, checked };
    if (item.kind === "section") {
      const version = context.sectionVersions.get(item.id);
      return { kind: "section", sectionId: item.id, ...(version ? { version } : {}), quote: item.quote, checked };
    }
    return { kind: "note", ...(context.notesSession ? { session: context.notesSession } : {}), quote: item.quote, checked };
  };
  const claim = (value: AnswerClaim | null, options: { proposedUnlessSourced?: boolean } = {}): Record<string, unknown> | null => {
    if (!value) return null;
    let check = value.check;
    let origin: string = value.origin;
    // "her" only when a quote of her section or her notes was found (review round 1, S2).
    if (origin === "her" && !value.refs.some((item) => item.kind !== "source" && checkOf(item) === "found")) {
      origin = "extracted";
      check ??= NOT_HERS_CHECK;
    }
    // A caregiver's mitigation is a fact only when a source states it (review round 1, S3).
    if (options.proposedUnlessSourced && !value.refs.some((item) => item.kind === "source" && checkOf(item) === "found")) origin = "proposed";
    if (!check && value.refs.some((item) => checkOf(item) === "not-found")) check = UNFOUND_CHECK;
    if (!check && checks.numbers.has(value)) check = NUMBER_CHECK;
    if (!check && (origin === "extracted" || origin === "her") && value.refs.length === 0) check = NO_REF_CHECK;
    return { value: value.value, refs: value.refs.map(ref), origin, check };
  };
  const claims = (values: readonly AnswerClaim[]) => values.map((value) => claim(value)!);
  const openItems = (items: ReadonlyArray<{ kind: string; text: string; homeSection: number | null }>): AnswerItem[] =>
    items.map((item, index) => ({ key: `new-open-${kind}-${index + 1}`, kind: item.kind, text: item.text, itemRef: null, homeSection: item.homeSection, status: "open" }));

  if (kind === "map-facts") {
    const facts = answer as FactsAnswer;
    const client = facts.client;
    return {
      client: {
        items: client
          ? [
              {
                key: "client",
                age: claim(client.age),
                diagnosis: claim(client.diagnosis),
                severityLevel: claim(client.severityLevel),
                evaluator: claim(client.evaluator),
                evaluationDate: claim(client.evaluationDate),
                medications: claims(client.medications),
                school: claim(client.school),
                grade: claim(client.grade),
                schedule: claim(client.schedule),
                iep: claim(client.iep),
                otherServices: client.otherServices.map((service) => ({ name: claim(service.name), provider: claim(service.provider), paid: claim(service.paid) })),
                languages: claims(client.languages),
              },
            ]
          : [],
      },
      caregivers: {
        items: facts.caregivers.map((item) => ({
          key: item.key,
          role: claim(item.role),
          language: claim(item.language),
          availability: claim(item.availability),
          participation: claim(item.participation),
          limits: claim(item.limits),
          mitigation: claim(item.mitigation, { proposedUnlessSourced: true }),
        })),
      },
      settings: { items: facts.settings.map((item) => ({ key: item.key, name: claim(item.name), kind: claim(item.kind), evidence: claim(item.evidence), by: claim(item.by), dates: claim(item.dates) })) },
      deficits: {
        items: facts.deficits.map((item) => ({
          key: item.key,
          area: claim(item.area),
          scores: item.scores.map((score) => ({ instrument: claim(score.instrument), scale: claim(score.scale), score: claim(score.score), percentile: claim(score.percentile), level: claim(score.level) })),
          evidence: claims(item.evidence),
          impact: claim(item.impact),
        })),
      },
      strengths: { items: facts.strengths.map((item) => ({ key: item.key, text: claim(item.text), kind: claim(item.kind), setting: claim(item.setting) })) },
      facts: { items: facts.facts.map((item) => ({ key: item.key, text: claim(item.text), homeSection: item.homeSection })) },
      openItems: { items: openItems(facts.openItems) },
      report: { items: facts.report.map((item, index) => ({ key: `new-report-${index + 1}`, kind: item.kind, text: item.text, sections: item.sections, refs: item.refs.map(ref), status: "open" })) },
    };
  }
  const found = answer as BehaviorsAnswer;
  // Links to nothing the map has are left out, each with an open item, so one bad link never costs the answer (review round 1, B2).
  const unlinked: Array<{ kind: string; text: string; homeSection: number | null }> = [];
  const behaviorKeys = new Set([...found.behaviors.map((item) => item.key), ...context.behaviorIds]);
  const nameOf = (item: { key: string; name: AnswerClaim | null }) => item.name?.value ?? item.key;
  const knownBehaviors = (keys: readonly string[], owner: string) => {
    const known = keys.filter((key) => behaviorKeys.has(key));
    const dropped = keys.filter((key) => !behaviorKeys.has(key));
    if (dropped.length > 0) unlinked.push({ kind: "check", text: `${owner} named behaviors that are not in the map (${dropped.join(", ")}): link the right ones by hand.`, homeSection: null });
    return known;
  };
  const behaviors = found.behaviors.map((item) => {
    const settingIds = item.settingIds.filter((id) => context.settingIds.has(id));
    const dropped = item.settingIds.filter((id) => !context.settingIds.has(id));
    if (dropped.length > 0) unlinked.push({ kind: "check", text: `${nameOf(item)}: the AI named settings that are not in the map (${dropped.join(", ")}). Link its settings by hand.`, homeSection: null });
    return {
      key: item.key,
      name: claim(item.name),
      topographies: claims(item.topographies),
      measure: claim(item.measure),
      definition: claim(item.definition),
      onset: claim(item.onset),
      offset: claim(item.offset),
      examples: claims(item.examples),
      nonExamples: claims(item.nonExamples),
      baseline: {
        observations: item.baseline.observations.map((observation) => {
          // The app's minutes from the length the notes give (review round 1, S7), never the AI's.
          const minutes = observation.length ? minutesOfLength(observation.length.value) : null;
          return {
            date: claim(observation.date),
            setting: claim(observation.setting),
            length: claim(observation.length),
            minutes: minutes === null ? null : { value: String(minutes), refs: [{ kind: "app" }], origin: "extracted", check: null },
            value: claim(observation.value),
          };
        }),
        other: claims(item.baseline.other),
      },
      // Intensity is hers only (D19).
      intensity: null,
      settingIds,
      antecedents: claims(item.antecedents),
      consequences: claims(item.consequences),
      function: {
        primary: item.function.primary,
        secondary: item.function.secondary,
        origin: "hypothesis",
        evidence: item.function.evidence.map((entry) => ({ tool: entry.tool, respondent: entry.respondent, result: claim(entry.result), supports: entry.supports })),
        reasoning: item.function.reasoning,
        check: item.function.check,
      },
      // Barrier tags from her list, as proposals (D18).
      barriers: item.barriers.length > 0 ? { value: item.barriers, refs: [], origin: "proposed", check: null } : null,
      risks: claims(item.risks),
    };
  });
  const groups = found.groups.map((group) => ({ key: group.key, behaviorKeys: knownBehaviors(group.behaviorKeys, `The group "${group.nature}"`), nature: group.nature, function: group.function, measure: group.measure, reason: group.reason, origin: "hypothesis" }));
  const risks = found.risks.map((risk) => ({ key: risk.key, behaviorKeys: knownBehaviors(risk.behaviorKeys, `The risk "${risk.what?.value.slice(0, 80) ?? risk.key}"`), what: claim(risk.what), evidence: claims(risk.evidence), level: claim(risk.level) }));
  return {
    behaviors: { items: behaviors, groups },
    risks: { items: risks },
    // The open items of the behaviors join those the facts request wrote.
    openItems: { items: openItems([...found.openItems, ...unlinked]), mode: "join" },
  };
}
