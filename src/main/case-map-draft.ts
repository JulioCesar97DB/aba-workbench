import { randomUUID } from "node:crypto";
import { checkMapAnswer, MAP_SCHEMA_NAMES, mapAnswerSchema, parseMapAnswer, PARTS_OF_REQUEST, type AnswerClaim, type AnswerRef, type BehaviorsAnswer, type CheckResult, type FactsAnswer, type MapAnswer, type MapAnswerFormat } from "../lib/case-map-extraction.ts";
import { generationCostUsd } from "../lib/pricing.ts";
import type { Effort, Provider, ProviderCredential, TokenUsage } from "../lib/providers/types.ts";
import type { DraftingProvider, GenerationUpdateEvent } from "../shared/api.ts";
import type { MapPartId, MapRequestKind } from "../shared/case-map.ts";
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
 * can be read), every count and score in one of its quotes, every link known. An answer
 * with problems gets one repair request; what still fails is saved and flagged, never
 * dropped. Each request's parts are saved as soon as they pass, as new versions.
 */

type RunEvent = Exclude<GenerationUpdateEvent, { type: "finished" }>;

/** Same settings as every section request (review M4), so the cached prefix is shared. */
const EFFORT: Effort = "high";
const MAX_OUTPUT_TOKENS = 32_000;
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

/** A route that refused the JSON schema: a 400 or an "unsupported" answer before anything was written. */
function refusedFormat(code: string): boolean {
  return /bad_request|unsupported|invalid_request/.test(code);
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
    const parts = toAnswerParts(kind, outcome.answer, outcome.checks, { notesSession, sectionVersions });
    const record: MapExtractionRecord = {
      id: randomUUID(),
      kind,
      at: "",
      run,
      generation: outcome.generation,
      format: outcome.format,
      repaired: outcome.repaired,
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
  };
  let format: MapAnswerFormat = formats.get(options.providerId) ?? "json-schema";
  let repair: { previousAnswer: string; problems: string[] } | null = null;
  let switched = false;
  let usage = zeroUsage;
  let cost: number | null = 0;
  let servedModel = options.model;
  let rulesVersions: Record<string, string>;
  for (let attempt = 0; attempt < 4; attempt++) {
    yield { type: "map-progress", step: kind, phase: repair ? "repairing" : switched ? "plain-json" : "writing", characters: 0 };
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
      yield { type: "error", code: "prepare_failed", message: "The case's sources could not be read.", status: null };
      return null;
    }
    rulesVersions = prepared.rulesVersions;
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
          yield { type: "map-progress", step: kind, phase: repair ? "repairing" : switched ? "plain-json" : "writing", characters };
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
    if (failure) {
      if (format === "json-schema" && !switched && refusedFormat(failure.code)) {
        // The route does not take the schema: the same request as plain JSON, checked the same way.
        format = "plain-json";
        switched = true;
        formats.set(options.providerId, "plain-json");
        continue;
      }
      yield { type: "error", code: failure.code, message: failure.message, status: failure.status };
      return null;
    }
    if (!finished) {
      yield { type: "error", code: "incomplete", message: "The answer was cut short or refused, so nothing was saved.", status: null };
      return null;
    }
    const parsed = parseMapAnswer(kind, finished.text);
    const checks = parsed.ok ? checkMapAnswer(kind, parsed.answer, context) : null;
    const problems = parsed.ok ? checks!.problems : parsed.problems;
    if (problems.length > 0 && repair === null) {
      repair = { previousAnswer: finished.text.slice(0, 60_000), problems: problems.slice(0, 30) };
      continue;
    }
    if (!parsed.ok) {
      yield { type: "error", code: "unreadable_answer", message: "The AI's answer could not be read, even after asking it again, so nothing was saved.", status: null };
      return null;
    }
    return {
      answer: parsed.answer,
      checks: checks!,
      format,
      repaired: repair !== null,
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
        deidentified: prepared.deidentified,
        usage,
        costUsd: cost,
      },
    };
  }
  yield { type: "error", code: "unreadable_answer", message: "The AI's answer could not be read, so nothing was saved.", status: null };
  return null;
}

/* From an answer to the map's stored shape */

interface ConvertContext {
  notesSession: string | null;
  sectionVersions: ReadonlyMap<string, number>;
}

const UNFOUND_CHECK = "A quote of this value was not found word for word in what it cites: check it against the source.";
const NUMBER_CHECK = "This number is not written in the quote it cites: check it against the source.";

/** The answer's parts as the map stores them, with each item's key (src/main/case-map.ts turns keys into ids). */
export function toAnswerParts(kind: MapRequestKind, answer: MapAnswer, checks: CheckResult, context: ConvertContext): Partial<Record<MapPartId, AnswerPart>> {
  const ref = (item: AnswerRef): Record<string, unknown> => {
    const checked = checks.quotes.get(item) ?? "not-checked";
    if (item.kind === "source") return { kind: "source", sourceId: item.id, quote: item.quote, checked };
    if (item.kind === "section") {
      const version = context.sectionVersions.get(item.id);
      return { kind: "section", sectionId: item.id, ...(version ? { version } : {}), quote: item.quote, checked };
    }
    return { kind: "note", ...(context.notesSession ? { session: context.notesSession } : {}), quote: item.quote, checked };
  };
  const claim = (value: AnswerClaim | null): Record<string, unknown> | null => {
    if (!value) return null;
    // "her" only when her section or her notes is cited; "hypothesis" and "proposed" stay as the AI marked them.
    const herCited = value.refs.some((item) => item.kind !== "source");
    const origin = value.origin === "her" && !herCited ? "extracted" : value.origin;
    let check = value.check;
    if (!check && value.refs.some((item) => checks.quotes.get(item) === "not-found")) check = UNFOUND_CHECK;
    if (!check && checks.numbers.has(value)) check = NUMBER_CHECK;
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
          mitigation: claim(item.mitigation),
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
  return {
    behaviors: {
      items: found.behaviors.map((item) => ({
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
          observations: item.baseline.observations.map((observation) => ({ date: claim(observation.date), setting: claim(observation.setting), minutes: claim(observation.minutes), value: claim(observation.value) })),
          other: claims(item.baseline.other),
        },
        // Intensity is hers only (D19).
        intensity: null,
        settingIds: item.settingIds,
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
      })),
      groups: found.groups.map((group) => ({ key: group.key, behaviorKeys: group.behaviorKeys, nature: group.nature, function: group.function, measure: group.measure, reason: group.reason, origin: "hypothesis" })),
    },
    risks: { items: found.risks.map((risk) => ({ key: risk.key, behaviorKeys: risk.behaviorKeys, what: claim(risk.what), evidence: claims(risk.evidence), level: claim(risk.level) })) },
    // The open items of the behaviors join those the facts request wrote.
    openItems: { items: openItems(found.openItems), mode: "join" },
  };
}
