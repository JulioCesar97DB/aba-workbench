import { toSafeError } from "./providers/index.ts";
import type { Effort, Provider, SourceDocument } from "./providers/types.ts";
import { buildPrompt, type SectionId } from "./rules.ts";
import type { GenerationEvent } from "./generation-events.ts";

export type { GenerationEvent } from "./generation-events.ts";

export interface GenerationRequest {
  provider: Provider;
  /** The user's key for this provider. It is passed to the provider and nowhere else. */
  apiKey: string;
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
 * then streams the provider's events. Failures become an "error" event whose message is
 * safe to show; after a cancel (signal aborted) nothing more is reported.
 * Nothing here logs the request: not the key, not the sources.
 */
export async function* runGeneration(request: GenerationRequest): AsyncGenerator<GenerationEvent> {
  const { provider, signal } = request;

  let built: Awaited<ReturnType<typeof buildPrompt>>;
  try {
    built = await buildPrompt(request.section, request.sources, request.rulesDir);
  } catch {
    // The underlying error names the rules folder; it stays out of the event.
    yield { type: "error", code: "rules_error", message: "The writing rules could not be loaded.", status: null };
    return;
  }
  const { prompt, rulesVersions } = built;
  const options = {
    apiKey: request.apiKey,
    model: request.model,
    effort: request.effort,
    maxOutputTokens: request.maxOutputTokens,
    prompt,
    signal,
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
