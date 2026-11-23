import { measureRequest, requestTooLargeMessage } from "./limits.ts";
import { toSafeError } from "./providers/index.ts";
import type { Effort, OutputFormat, PromptParts, Provider, ProviderCredential, SourceDocument } from "./providers/types.ts";
import { buildPrompt, type SectionId } from "./rules.ts";
import type { GenerationEvent } from "./generation-events.ts";

export type { GenerationEvent } from "./generation-events.ts";

export interface GenerationRequest {
  provider: Provider;
  /** The user's key or sign-in for this provider. It is passed to the provider and nowhere else. */
  credential: ProviderCredential;
  model: string;
  section: SectionId;
  effort: Effort;
  maxOutputTokens: number;
  /** "prewarm" writes the cacheable prefix (rules and sources) without generating text. */
  mode: "generate" | "prewarm";
  sources: SourceDocument[];
  signal: AbortSignal;
  /** Where the rules files are; scripts and tests leave it to the default. */
  rulesDir?: string;
}

/**
 * One generation from start to end: builds the prompt from the rules and the sources,
 * checks the provider's size limit, then streams the provider's events. Failures (a
 * request over the limit included) become an "error" event whose message is
 * safe to show; after a cancel (signal aborted) nothing more is reported.
 * Nothing here logs the request: not the key, not the sources.
 */
export async function* runGeneration(request: GenerationRequest): AsyncGenerator<GenerationEvent> {
  let built: Awaited<ReturnType<typeof buildPrompt>>;
  try {
    built = await buildPrompt(request.section, request.sources, request.rulesDir);
  } catch {
    // The underlying error names the rules folder; it stays out of the event.
    yield { type: "error", code: "rules_error", message: "The writing rules could not be loaded.", status: null };
    return;
  }
  yield* runPromptGeneration({ ...request, prompt: built.prompt, rulesVersions: built.rulesVersions });
}

/** A generation whose prompt is already built (the section workspace builds it in src/main/outgoing.ts). */
export interface PromptGenerationRequest {
  provider: Provider;
  credential: ProviderCredential;
  model: string;
  section: string;
  effort: Effort;
  maxOutputTokens: number;
  mode: "generate" | "prewarm";
  prompt: PromptParts;
  rulesVersions: Record<string, string>;
  signal: AbortSignal;
  /** The case's opaque prompt-cache key (src/main/cache-key.ts); none outside a case. */
  cacheKey?: string | null;
  /** Development only: the evaluation's judge asks for JSON in this schema (src/lib/judge.ts). */
  outputFormat?: OutputFormat | null;
}

/**
 * Sends a built prompt: checks the provider's size limit, then streams the provider's
 * events. Failures become an "error" event whose message is safe to show; after a cancel
 * nothing more is reported. Nothing here logs the request.
 */
export async function* runPromptGeneration(request: PromptGenerationRequest): AsyncGenerator<GenerationEvent> {
  const { provider, signal, prompt, rulesVersions } = request;
  // Checked before anything is sent: the provider would refuse it anyway, after the upload.
  const tooLarge = requestTooLargeMessage(provider.id, measureRequest(prompt));
  if (tooLarge) {
    yield { type: "error", code: "request_too_large", message: tooLarge, status: null };
    return;
  }
  const options = {
    credential: request.credential,
    model: request.model,
    effort: request.effort,
    maxOutputTokens: request.maxOutputTokens,
    prompt,
    signal,
    cacheKey: request.cacheKey ?? null,
    outputFormat: request.outputFormat ?? null,
  };
  yield {
    type: "meta",
    provider: provider.id,
    model: request.model,
    section: request.section,
    effort: request.effort,
    mode: request.mode,
    rulesVersions,
  };

  try {
    if (request.mode === "prewarm") {
      const usage = await provider.prewarm(options);
      yield { type: "done", complete: true, stopReason: "prewarm", servedModel: request.model, usage, attempts: null };
      return;
    }
    for await (const event of provider.generate(options)) {
      if (signal.aborted) return;
      yield event;
    }
  } catch (error) {
    if (signal.aborted) return;
    const safe = toSafeError(error);
    yield { type: "error", code: safe.code, message: safe.message, status: safe.status };
  }
}
