import { randomUUID } from "node:crypto";
import { refusedFormat } from "../lib/case-map-extraction.ts";
import { parseReviewAnswer, reviewAnswerSchema, reviewedBehaviors, REVIEW_SCHEMA_NAME, type ReviewFormat } from "../lib/definition-review.ts";
import { generationCostUsd } from "../lib/pricing.ts";
import type { Effort, Provider, ProviderCredential, TokenUsage } from "../lib/providers/types.ts";
import type { DraftingProvider, GenerationUpdateEvent } from "../shared/api.ts";
import { reviewFingerprint, type DefinitionReviewFinding } from "../shared/definition-checks.ts";
import type { CaseData } from "./case-file.ts";
import { appendMapExtraction, caseMapSummary, caseMapView, type MapExtractionRecord } from "./case-map.ts";
import type { CaseLibrary } from "./cases.ts";
import { caseCacheKey } from "./cache-key.ts";
import { prepareDefinitionReviewRequest } from "./outgoing.ts";
import { runSectionGeneration, type FinishedText } from "./section-generation.ts";

/*
 * The AI review of the behaviors' definitions (T3, owner's decisions of 2026-11-28): one
 * request after each map draft saves its behaviors, and one more each time she asks for it
 * ("Review the definitions again"). It reads the definitions of the behaviors version shown
 * and reports the dead-man failures and the overlapping pairs (src/lib/definition-review.ts).
 *
 * Its result is one entry of caseMap.extractions, kind "map-review" (owner's decision 1A):
 * the same generation record as the draft's requests, and a `review` with its status, the
 * behaviors version it read, each behavior's fingerprint, and its findings. A review that
 * could not run is recorded too ("failed", with why), so the map shows it; the map itself is
 * never touched, and a failed review never fails the draft.
 */

type RunEvent = Exclude<GenerationUpdateEvent, { type: "finished" }>;

const EFFORT: Effort = "high";
const MAX_OUTPUT_TOKENS = 16_000;
/** A route that refused the review's JSON schema is asked for plain JSON from then on, for the rest of the app's run. */
const formats = new Map<DraftingProvider, ReviewFormat>();

/** For the tests: forget what the routes refused. */
export function resetReviewFormats(): void {
  formats.clear();
}

export interface DefinitionReviewOptions {
  cases: Pick<CaseLibrary, "changeCase">;
  caseId: string;
  rulesDir: string;
  providerId: DraftingProvider;
  provider: Provider;
  credential: ProviderCredential;
  model: string;
  signal: AbortSignal;
  log: (message: string) => void;
  /** The draft it follows; a review she asks for on its own has its own. */
  run?: string;
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

async function readCase(options: DefinitionReviewOptions): Promise<CaseData | null> {
  const read = await options.cases.changeCase(options.caseId, () => ({ save: null, value: null }));
  return read.kind === "saved" || read.kind === "unchanged" ? read.data : null;
}

/**
 * One review of the map's definitions. Yields its progress ("map-review") and, once its
 * record is saved, the whole map ("map-review-saved"). Nothing is recorded when it is
 * stopped, or when the map has no behavior to review.
 */
export async function* runDefinitionReview(options: DefinitionReviewOptions): AsyncGenerator<RunEvent> {
  const data = await readCase(options);
  if (!data) {
    yield { type: "error", code: "case_unavailable", message: "The case could not be read.", status: null };
    return;
  }
  const part = caseMapView(data).parts.behaviors;
  const items = part.items as unknown as Array<{ id: string } & Record<string, unknown>>;
  const behaviors = reviewedBehaviors(items);
  if (behaviors.length === 0) return;
  const fingerprints = Object.fromEntries(items.map((item) => [item.id, reviewFingerprint(item)]));
  const ids = new Set(behaviors.map((behavior) => behavior.id));
  let format: ReviewFormat = formats.get(options.providerId) ?? "json-schema";
  let usage = zeroUsage;
  let cost: number | null = 0;
  let servedModel = options.model;
  let rulesVersions: Record<string, string> = {};
  let failure: string | null = null;
  let findings: DefinitionReviewFinding[] = [];
  const problems: string[] = [];
  const started = Date.now();
  for (let attempt = 0; attempt < 2; attempt++) {
    yield { type: "map-review", phase: format === "json-schema" ? "reviewing" : "plain-json" };
    let prepared;
    try {
      prepared = await prepareDefinitionReviewRequest({ behaviors, format, rulesDir: options.rulesDir });
    } catch (error) {
      options.log(`The definitions review could not be prepared (${(error as NodeJS.ErrnoException).code ?? "error"}).`);
      failure = "prepare_failed";
      break;
    }
    rulesVersions = prepared.rulesVersions;
    let finished: FinishedText | null = null;
    let error: { code: string; message: string } | null = null;
    let refused = false;
    for await (const event of runSectionGeneration<FinishedText>({
      prepared,
      provider: options.provider,
      credential: options.credential,
      model: options.model,
      effort: EFFORT,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      section: "case-map:map-review",
      signal: options.signal,
      cacheKey: options.credential.kind === "chatgpt" ? caseCacheKey(options.caseId) : null,
      outputFormat: format === "json-schema" ? { name: REVIEW_SCHEMA_NAME, schema: reviewAnswerSchema() } : null,
      save: async (text) => text,
    })) {
      if (event.type === "error") error = event;
      else if (event.type === "refusal") refused = true;
      else if (event.type === "done") {
        usage = addUsage(usage, event.usage);
        servedModel = event.servedModel;
        const spent = generationCostUsd(event.servedModel, event.usage, event.attempts);
        cost = cost === null || spent === null ? null : cost + spent;
      } else if (event.type === "saved") finished = event.result;
    }
    if (options.signal.aborted) return;
    if (error && format === "json-schema" && attempt === 0 && refusedFormat(error)) {
      format = "plain-json";
      formats.set(options.providerId, "plain-json");
      continue;
    }
    if (error) {
      failure = error.code || "error";
      break;
    }
    if (refused || !finished) {
      failure = refused ? "refused" : "incomplete";
      break;
    }
    const parsed = parseReviewAnswer(finished.text, ids);
    if (!parsed.ok) {
      failure = "unreadable_answer";
      problems.push(...parsed.problems);
      break;
    }
    findings = parsed.findings;
    if (parsed.dropped > 0) problems.push(`${parsed.dropped} findings named a behavior the review was not sent, or repeated one, and were left out.`);
    break;
  }
  const record: MapExtractionRecord = {
    id: randomUUID(),
    kind: "map-review",
    at: "",
    run: options.run ?? randomUUID(),
    generation: { provider: options.providerId, requestedModel: options.model, servedModel, effort: EFFORT, rulesVersions, deidentified: false, usage, costUsd: cost },
    format,
    repaired: false,
    problems,
    seconds: { answer: Math.round((Date.now() - started) / 1000) },
    review: { status: failure ? "failed" : "done", failure, behaviorsVersion: part.currentVersion, fingerprints, findings },
  };
  const saved = await options.cases.changeCase(options.caseId, (current, _folder, now) => ({ save: appendMapExtraction(current, { ...record, at: now }), value: null }));
  if (saved.kind === "unavailable") {
    yield { type: "error", code: "case_unavailable", message: "The case could not be read.", status: null };
    return;
  }
  const result = saved.kind === "failed" ? { outcome: saved.outcome } : { outcome: "saved" as const, map: caseMapView(saved.data), summary: caseMapSummary(saved.data), version: null, itemId: null };
  yield { type: "map-review-saved", result, status: failure ? "failed" : "done", findings: findings.length };
}
