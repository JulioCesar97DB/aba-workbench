import { randomUUID } from "node:crypto";
import { checkMapAnswer, cutText, limitOf, SCORE_LIMITS, TEXT_LIMITS, MAP_SCHEMA_NAMES, mapAnswerSchema, mergeRepair, numbersIn, parseMapAnswer, PARTS_OF_REQUEST, repairInput, sameNumber, SCORE_FIELDS, type AnswerClaim, type AnswerRef, type BehaviorsAnswer, type CheckContext, type CheckResult, type FactsAnswer, type MapAnswer, type MapAnswerFormat, type RepairScope, type ScoreRow } from "../lib/case-map-extraction.ts";
import { JsonItemScanner, type ClosedItem } from "../lib/json-items.ts";
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
 * problems gets one repair request about what failed: the values that failed, or an item
 * whole when the problem is the item's own; the repair's answer is merged into the first
 * answer by key, field by field and entry by entry, and when the repair cannot be used the
 * first answer is saved as it is. What still fails is saved and flagged with a [CHECK].
 * Each request's parts are saved as soon as they pass, as new versions.
 *
 * While an answer arrives, each item is read as soon as its JSON closes and checked on its
 * own; one that passes is shown at once ("map-preview"), read-only and marked as not saved
 * yet. Nothing is saved before the whole answer's checks (case map speed, 2026-11-23).
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
  /** Why the repair was asked for, and about how much (case map speed). */
  repairScope: RepairScope | null;
  repairCauses: Record<string, number>;
  repairValues: number;
  /** How long the answer and the repair took, in seconds. */
  seconds: { answer: number; repair?: number };
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
      ...(outcome.repaired
        ? { repairUsed: outcome.repairUsed, problemsBeforeRepair: outcome.problemsBeforeRepair, repairScope: outcome.repairScope ?? "whole", repairCauses: outcome.repairCauses, repairValues: outcome.repairValues }
        : {}),
      problems: outcome.checks.problems,
      seconds: outcome.seconds,
    };
    if (options.signal.aborted) return;
    let written: MapPartId[] = [];
    let kept: MapPartId[] = [];
    let problemsLeft = outcome.checks.problems.length;
    const saved = await options.cases.changeCase(options.caseId, (data, _folder, now) => {
      const applied = applyMapAnswer(data, parts, { ...record, at: now }, before, now);
      written = applied.written;
      kept = applied.kept;
      // What the save itself left out (links, items over the limits) counts too (review round 2, M4).
      problemsLeft = applied.problems.length;
      return { save: applied.data, value: null };
    });
    if (saved.kind === "unavailable") {
      yield { type: "error", code: "case_unavailable", message: "The case could not be read.", status: null };
      return;
    }
    const result = saved.kind === "failed" ? { outcome: saved.outcome } : { outcome: "saved" as const, map: caseMapView(saved.data), summary: caseMapSummary(saved.data), version: null, itemId: null };
    yield { type: "map-saved", step: kind, result, written, kept, problems: problemsLeft };
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
  const context: CheckContext & { behaviorIds: ReadonlySet<string> } = {
    sources: sources.map((source) => ({ id: source.id, title: source.title, text: source.kind === "text" ? source.text : null })),
    sections: herSections,
    notes,
    settingIds: facts?.settingIds ?? new Set<string>(),
    behaviorIds: behaviorIdsOf(data),
    instructions: kind === "map-behaviors" ? options.instructions : "",
  };
  const convert: ConvertContext = {
    notesSession: data.sessionNotes?.startedAt ?? null,
    sectionVersions: new Map(herSections.map((section) => [section.id, section.version])),
    settingIds: context.settingIds,
    behaviorIds: context.behaviorIds,
  };
  let format: MapAnswerFormat = formats.get(options.providerId) ?? "json-schema";
  /** The first answer that could be read, kept whatever the repair brings (review round 1, B1). */
  let first: { answer: MapAnswer; checks: CheckResult } | null = null;
  let repair: { previousAnswer: string; problems: string[]; whole: boolean } | null = null;
  let problemsBeforeRepair: string[] = [];
  let repairScope: RepairScope | null = null;
  let repairCauses: Record<string, number> = {};
  let repairValues = 0;
  const seconds: { answer: number; repair?: number } = { answer: 0 };
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
    repairScope,
    repairCauses,
    repairValues,
    seconds,
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
    const started = Date.now();
    yield { type: "map-progress", step: kind, phase, characters: 0, ...(repair ? { values: repairValues, scope: repairScope ?? "whole" } : { arrived: 0, shown: 0 }) };
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
    let reported = 0;
    // A first answer is read item by item as it arrives; a repair is small and is not.
    const preview = repair === null ? new ArrivingItems(kind, context, convert, savedOf(data)) : null;
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
        const arrivedBefore = preview?.arrived ?? 0;
        if (preview) for (const shown of preview.feed(event.delta)) yield { type: "map-preview", step: kind, ...shown };
        if (characters - reported >= PROGRESS_STEP || (preview?.arrived ?? 0) > arrivedBefore) {
          reported = characters;
          yield { type: "map-progress", step: kind, phase, characters, ...(preview ? { arrived: preview.arrived, shown: preview.shown } : { values: repairValues, scope: repairScope ?? "whole" }) };
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
    const took = Math.round((Date.now() - started) / 1000);
    if (repair) seconds.repair = (seconds.repair ?? 0) + took;
    else seconds.answer += took;
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
      // What failed: the claims, and the objects that hold a text that failed on its own (a reasoning, a respondent).
      const failed = new Set<unknown>([...first?.checks.failedClaims ?? [], ...(first?.checks.failedFields.keys() ?? [])]);
      const answer = first ? mergeRepair(kind, first.answer, parsed.answer, first.checks.failing, first.checks.whole, failed) : parsed.answer;
      return outcome(answer, checkMapAnswer(kind, answer, context), true);
    }
    if (parsed.ok) {
      const checks = checkMapAnswer(kind, parsed.answer, context);
      if (checks.problems.length === 0) return outcome(parsed.answer, checks, false);
      first = { answer: parsed.answer, checks };
      problemsBeforeRepair = checks.problems;
      // Only what failed is quoted and asked for again (case map speed, 2026-11-23), and why is recorded.
      const input = repairInput(kind, parsed.raw, parsed.answer, checks);
      repairScope = input.scope;
      repairCauses = checks.causes;
      repairValues = checks.failedValues;
      repair = { previousAnswer: JSON.stringify(input.previousAnswer), problems: withItemKeys(checks.problems, parsed.answer).slice(0, 40), whole: input.scope === "whole" };
    } else {
      problemsBeforeRepair = parsed.problems;
      repairScope = "whole";
      repairCauses = { unreadable: parsed.problems.length };
      repairValues = 0;
      // The whole text, uncut: an answer that could not be read is asked again in full.
      repair = { previousAnswer: finished.text, problems: parsed.problems, whole: true };
    }
  }
  if (first) return outcome(first.answer, first.checks, false);
  yield { type: "error", code: "unreadable_answer", message: "The AI's answer could not be read, so nothing was saved.", status: null };
  return null;
}

/**
 * A problem's place with its item's key ("caregivers[0].role…: … (item "new-1")"), since a
 * repair's quote holds only the items that failed, so their places in the first answer no
 * longer match.
 */
function withItemKeys(problems: readonly string[], answer: MapAnswer): string[] {
  const lists = answer as unknown as Record<string, unknown>;
  return problems.map((problem) => {
    const listed = /^([a-zA-Z]+)\[(\d+)\]/u.exec(problem);
    const items = listed ? lists[listed[1]] : null;
    const key = Array.isArray(items) ? (items[Number(listed![2])] as { key?: unknown } | undefined)?.key : undefined;
    return typeof key === "string" ? `${problem} (item "${key}")` : problem;
  });
}

/** The part each list of an answer fills, for the items shown as they arrive. A group is shown once its request saves. */
const PREVIEW_PARTS: Partial<Record<string, MapPartId>> = {
  client: "client",
  caregivers: "caregivers",
  settings: "settings",
  deficits: "deficits",
  strengths: "strengths",
  facts: "facts",
  openItems: "openItems",
  report: "report",
  behaviors: "behaviors",
  risks: "risks",
};

/** What the map holds before a request, for its previews: the parts she approved, and each part's items, hers (changed by hand) apart. */
interface SavedItems {
  approved: ReadonlySet<MapPartId>;
  items: ReadonlyMap<MapPartId, ReadonlySet<string>>;
  hers: ReadonlyMap<MapPartId, ReadonlySet<string>>;
}

function savedOf(data: CaseData): SavedItems {
  const view = caseMapView(data);
  const approved = new Set<MapPartId>();
  const items = new Map<MapPartId, Set<string>>();
  const hers = new Map<MapPartId, Set<string>>();
  for (const [part, partView] of Object.entries(view.parts) as Array<[MapPartId, (typeof view.parts)[MapPartId]]>) {
    if (partView.status === "approved") approved.add(part);
    items.set(part, new Set(partView.items.map((item) => item.id)));
    hers.set(part, new Set(partView.items.filter((item) => item.editedAt !== null).map((item) => item.id)));
  }
  return { approved, items, hers };
}

/** An item shown as it arrives: its part, its own id ("preview:…"), and the saved item it would replace, if any. */
interface ShownItem {
  part: MapPartId;
  id: string;
  item: Record<string, unknown>;
  replaces: string | null;
}

/**
 * The items of an answer as they arrive (case map speed, 2026-11-23): each one read as
 * soon as its JSON closes, checked on its own (its quotes, numbers and links, as the whole
 * answer's checks do), and, when it passes, put in the map's stored shape to be shown
 * read-only. Checks across items (keys used twice, a group's members) wait for the whole
 * answer, as does every save.
 *
 * Only what the save would write is shown (review round 1 of case map speed, S4): nothing
 * of a part she approved, nothing under the id of an item she changed by hand (hers is
 * kept), and no client when one is saved (the screen shows the saved one). An item under
 * the id of a saved item is that item's new version, and says which it replaces.
 */
class ArrivingItems {
  readonly #scanner = new JsonItemScanner();
  readonly #kind: MapRequestKind;
  readonly #context: CheckContext & { behaviorIds: ReadonlySet<string> };
  readonly #convert: ConvertContext;
  readonly #saved: SavedItems;
  /** The behaviors' keys arrived so far: a risk that arrives after them may name them. */
  readonly #behaviorKeys = new Set<string>();
  arrived = 0;
  shown = 0;

  constructor(kind: MapRequestKind, context: CheckContext & { behaviorIds: ReadonlySet<string> }, convert: ConvertContext, saved: SavedItems) {
    this.#kind = kind;
    this.#context = context;
    this.#convert = convert;
    this.#saved = saved;
  }

  feed(piece: string): ShownItem[] {
    const out: ShownItem[] = [];
    for (const closed of this.#scanner.feed(piece)) {
      this.arrived++;
      const shown = this.#check(closed);
      if (!shown) continue;
      this.shown++;
      out.push(shown);
    }
    return out;
  }

  #check(closed: ClosedItem): ShownItem | null {
    let value: unknown;
    try {
      value = JSON.parse(closed.text);
    } catch {
      return null;
    }
    if (closed.list === "behaviors" && typeof (value as { key?: unknown }).key === "string") this.#behaviorKeys.add((value as { key: string }).key);
    const part = PREVIEW_PARTS[closed.list];
    if (!part || this.#saved.approved.has(part)) return null;
    if (part === "client" && (this.#saved.items.get("client")?.size ?? 0) > 0) return null;
    const alone: Record<string, unknown> = this.#kind === "map-facts" ? { client: null, caregivers: [], settings: [], deficits: [], strengths: [], facts: [], openItems: [], report: [] } : { behaviors: [], groups: [], risks: [], openItems: [] };
    if (!(closed.list in alone)) return null;
    alone[closed.list] = closed.index === null ? value : [value];
    const parsed = parseMapAnswer(this.#kind, JSON.stringify(alone));
    if (!parsed.ok) return null;
    const behaviorIds = new Set([...this.#context.behaviorIds, ...this.#behaviorKeys]);
    const checks = checkMapAnswer(this.#kind, parsed.answer, { ...this.#context, behaviorIds });
    if (checks.problems.length > 0) return null;
    const parts = toAnswerParts(this.#kind, parsed.answer, checks, { ...this.#convert, behaviorIds });
    const item = parts[part]?.items[0];
    if (!item) return null;
    // Open items are joined to the saved ones, never in place of one.
    const key = part === "openItems" ? null : String(item.key);
    if (key !== null && this.#saved.hers.get(part)?.has(key)) return null;
    const replaces = key !== null && this.#saved.items.get(part)?.has(key) ? key : null;
    return { part, id: `preview:${this.#kind}:${closed.list}:${closed.index ?? 0}`, item, replaces };
  }
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
const PDF_NUMBER_CHECK = "A number of this value is only in a PDF's quote, which the app cannot check yet: check it against the PDF.";
const CUT_CHECK = "This value was longer than the map allows, even after the AI was asked to shorten it, so it was cut: check it against the source.";
const QUOTE_CUT_CHECK = "This quote was cut to fit: check the value against the source.";
/** A text that is not a claim, cut to fit: the note goes on what holds it (review round 1 of case map speed, M1). */
const textCutCheck = (what: string) => `The ${what} was longer than the map allows, even after the AI was asked to shorten it, so it was cut: check it.`;

/**
 * A check with a note after it, both kept within the check's limit (review round 1 of case
 * map speed, M2): a value flagged for another reason and cut is told both.
 */
export function joinChecks(check: string | null, note: string): string {
  if (!check) return note;
  if (check.includes(note)) return check;
  const room = TEXT_LIMITS.check - note.length - 1;
  return `${check.length <= room ? check : cutText(check, room)} ${note}`;
}

/** A quote's passage of at most the limit, from the word at `start`, ending at a word. */
function windowAt(quote: string, start: number): string {
  const room = quote.slice(start, start + TEXT_LIMITS.quote);
  if (start + TEXT_LIMITS.quote >= quote.length) return room.trimEnd();
  const space = room.lastIndexOf(" ");
  return (space > TEXT_LIMITS.quote / 2 ? room.slice(0, space) : room).trimEnd();
}

/**
 * A quote cut to the limit at words, with no mark added, so it is still as the source writes
 * it and still found. It keeps the passage that holds the value's numbers the quote gives
 * (review round 1 of case map speed, S3): its first words when they do, else a passage
 * that does, the numbers in its middle. `lost` when no passage holds them all.
 */
export function cutQuote(quote: string, numbers: readonly string[] = []): { quote: string; lost: boolean } {
  if (quote.length <= TEXT_LIMITS.quote) return { quote, lost: false };
  const inQuote = numbersIn(quote);
  const wanted = numbers.filter((number) => inQuote.some((quoted) => sameNumber(number, quoted)));
  const holdsAll = (text: string) => {
    const held = numbersIn(text);
    return wanted.every((number) => held.some((quoted) => sameNumber(number, quoted)));
  };
  const first = windowAt(quote, 0);
  if (holdsAll(first)) return { quote: first, lost: false };
  // Of the passages that hold them all, the middle one: the numbers with words on both sides.
  const holding: number[] = [];
  for (let start = 1; start < quote.length; start++) {
    if (quote[start - 1] === " " && quote[start] !== " " && holdsAll(windowAt(quote, start))) holding.push(start);
  }
  if (holding.length === 0) return { quote: first, lost: true };
  return { quote: windowAt(quote, holding[Math.floor(holding.length / 2)]), lost: false };
}
const NOT_HERS_CHECK = "Marked as hers, but no quote of her section or her notes was found: check it.";

/** The answer's parts as the map stores them, with each item's key (src/main/case-map.ts turns keys into ids). */
export function toAnswerParts(kind: MapRequestKind, answer: MapAnswer, checks: CheckResult, context: ConvertContext): Partial<Record<MapPartId, AnswerPart>> {
  // A ref the checks never reached is not vouched for: "not-found", never the PDF's "not-checked" (review round 1, M6).
  const checkOf = (item: AnswerRef) => checks.quotes.get(item) ?? "not-found";
  /** A quote cut to fit lost a number of the value it vouched for (S3): set by `ref`, read by its caller. */
  let quoteLost = false;
  const ref = (item: AnswerRef, numbers: readonly string[] = []): Record<string, unknown> => {
    const checked = checkOf(item);
    // A quote still too long after the repair is cut to fit, keeping the passage with the value's numbers: still word for word, so still found.
    const cut = cutQuote(item.quote, numbers);
    if (cut.lost && checked === "found") quoteLost = true;
    const quote = cut.quote;
    if (item.kind === "source") return { kind: "source", sourceId: item.id, quote, checked };
    if (item.kind === "section") {
      const version = context.sectionVersions.get(item.id);
      return { kind: "section", sectionId: item.id, ...(version ? { version } : {}), quote, checked };
    }
    return { kind: "note", ...(context.notesSession ? { session: context.notesSession } : {}), quote, checked };
  };
  /** A claim's refs as stored, and whether a cut quote lost one of its numbers. */
  const refsOf = (refs: readonly AnswerRef[], text: string) => {
    quoteLost = false;
    const numbers = numbersIn(text);
    const stored = refs.map((item) => ref(item, numbers));
    return { refs: stored, lost: quoteLost };
  };
  /** A claim's check before any cut: its own, or what the checks found. */
  const baseOf = (value: AnswerClaim, options: { proposedUnlessSourced?: boolean } = {}) => {
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
    if (!check && checks.pdfNumbers.has(value)) check = PDF_NUMBER_CHECK;
    if (!check && (origin === "extracted" || origin === "her") && value.refs.length === 0) check = NO_REF_CHECK;
    return { check, origin };
  };
  const claim = (value: AnswerClaim | null, options: { proposedUnlessSourced?: boolean } = {}): Record<string, unknown> | null => {
    if (!value) return null;
    const base = baseOf(value, options);
    const origin = base.origin;
    let check = base.check;
    const { refs, lost } = refsOf(value.refs, value.value);
    // A value still longer than its field allows after the repair is cut to fit, with a [CHECK] (owner's decision, 2026-11-23),
    // told after any earlier check (M2).
    const max = limitOf(value);
    const tooLong = value.value.length > max;
    if (tooLong) check = joinChecks(check, CUT_CHECK);
    if (lost) check = joinChecks(check, QUOTE_CUT_CHECK);
    return { value: tooLong ? cutText(value.value, max) : value.value, refs, origin, check: check === null ? null : cutText(check, TEXT_LIMITS.check) };
  };
  const claims = (values: readonly AnswerClaim[]) => values.map((value) => claim(value)!);
  /**
   * A score row, one claim on the wire, stored as today's five claims (owner's decision,
   * 2026-11-23): each field with the row's refs and origin. The row's own [CHECK] goes on its
   * score (or its first field); a number the quotes do not give is flagged on the field that
   * holds it.
   */
  const scoreClaims = (row: ScoreRow): Record<string, Record<string, unknown> | null> => {
    const base = baseOf(row);
    const { refs, lost } = refsOf(row.refs, row.value);
    const holder = row.score !== null ? "score" : SCORE_FIELDS.find((field) => row[field] !== null);
    const unquoted = checks.unquotedNumbers.get(row) ?? [];
    const unquotedFields = checks.unquotedFields.get(row);
    // "A number is not in its quote" belongs to the field that holds the number, not to the row.
    const rowCheck = base.check === NUMBER_CHECK && unquoted.length > 0 ? null : base.check;
    return Object.fromEntries(
      SCORE_FIELDS.map((field) => {
        const value = row[field];
        if (value === null) return [field, null];
        const ownNumber = unquotedFields ? unquotedFields.has(field) : numbersIn(value).some((number) => unquoted.includes(number));
        const tooLong = value.length > SCORE_LIMITS[field];
        let check: string | null = field === holder && rowCheck ? rowCheck : ownNumber ? NUMBER_CHECK : null;
        if (tooLong) check = joinChecks(check, CUT_CHECK);
        if (lost && field === holder) check = joinChecks(check, QUOTE_CUT_CHECK);
        return [field, { value: tooLong ? cutText(value, SCORE_LIMITS[field]) : value, refs, origin: base.origin, check: check === null ? null : cutText(check, TEXT_LIMITS.check) }];
      }),
    );
  };
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
          scores: item.scores.map((row) => scoreClaims(row)),
          evidence: claims(item.evidence),
          impact: claim(item.impact),
        })),
      },
      strengths: { items: facts.strengths.map((item) => ({ key: item.key, text: claim(item.text), kind: claim(item.kind), setting: claim(item.setting) })) },
      facts: { items: facts.facts.map((item) => ({ key: item.key, text: claim(item.text), homeSection: item.homeSection })) },
      // Report items before the open items: a report item cut to fit adds one (M1).
      ...(() => {
        const cutNotes: Array<{ kind: string; text: string; homeSection: number | null }> = [];
        const report = facts.report.map((item, index) => {
          const { refs, lost } = refsOf(item.refs, item.text);
          const what = `The report item "${cutText(item.text, 80)}"`;
          if (item.text.length > TEXT_LIMITS.report) cutNotes.push({ kind: "check", text: `${what} was longer than the map allows, even after the AI was asked to shorten it, so it was cut: check it.`, homeSection: null });
          if (lost) cutNotes.push({ kind: "check", text: `${what}: a quote was cut to fit, so check the item against the source.`, homeSection: null });
          return { key: `new-report-${index + 1}`, kind: item.kind, text: cutText(item.text, TEXT_LIMITS.report), sections: item.sections, refs, status: "open" };
        });
        return { openItems: { items: openItems([...facts.openItems, ...cutNotes]) }, report: { items: report } };
      })(),
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
  /**
   * A behavior's function as stored. A reasoning, a respondent or a check still too long
   * after the repair is cut to fit, and the function's check says so (review round 1 of
   * case map speed, M1), after any check it had.
   */
  const functionOf = (fn: BehaviorsAnswer["behaviors"][number]["function"]) => {
    const cut: string[] = [];
    const fit = (text: string | null, max: number, what: string) => {
      if (text === null || text.length <= max) return text;
      cut.push(what);
      return cutText(text, max);
    };
    const evidence = fn.evidence.map((entry) => ({ tool: entry.tool, respondent: fit(entry.respondent, TEXT_LIMITS.respondent, "respondent of an evidence"), result: claim(entry.result), supports: entry.supports }));
    const reasoning = fit(fn.reasoning, TEXT_LIMITS.reasoning, "reasoning");
    let check = fn.check;
    if (check !== null && check.length > TEXT_LIMITS.check) cut.push("function's check");
    for (const what of [...new Set(cut)]) check = joinChecks(check, textCutCheck(what));
    return { primary: fn.primary, secondary: fn.secondary, origin: "hypothesis", evidence, reasoning, check: check === null ? null : cutText(check, TEXT_LIMITS.check) };
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
            minutes: minutes === null ? null : { value: String(minutes), refs: [{ kind: "app" }], origin: "app", check: null },
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
      function: functionOf(item.function),
      // Barrier tags from her list, as proposals (D18).
      barriers: item.barriers.length > 0 ? { value: item.barriers, refs: [], origin: "proposed", check: null } : null,
      risks: claims(item.risks),
    };
  });
  const groups = found.groups.map((group) => {
    // A group's nature or reason cut to fit is named in an open item (M1): a group has no check of its own.
    const nature = cutText(group.nature, TEXT_LIMITS.nature);
    for (const [what, text, max] of [["nature", group.nature, TEXT_LIMITS.nature], ["reason", group.reason, TEXT_LIMITS.reason]] as const) {
      if (text.length > max) unlinked.push({ kind: "check", text: `The group "${nature}": its ${what} was longer than the map allows, even after the AI was asked to shorten it, so it was cut: check it.`, homeSection: null });
    }
    return { key: group.key, behaviorKeys: knownBehaviors(group.behaviorKeys, `The group "${group.nature}"`), nature, function: group.function, measure: group.measure, reason: cutText(group.reason, TEXT_LIMITS.reason), origin: "hypothesis" };
  });
  const risks = found.risks.map((risk) => ({ key: risk.key, behaviorKeys: knownBehaviors(risk.behaviorKeys, `The risk "${risk.what?.value.slice(0, 80) ?? risk.key}"`), what: claim(risk.what), evidence: claims(risk.evidence), level: claim(risk.level) }));
  return {
    behaviors: { items: behaviors, groups },
    risks: { items: risks },
    // The open items of the behaviors join those the facts request wrote.
    openItems: { items: openItems([...found.openItems, ...unlinked]), mode: "join" },
  };
}
