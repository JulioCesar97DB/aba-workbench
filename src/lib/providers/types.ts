/**
 * The provider layer: one small interface, one implementation per AI provider.
 *
 * A prompt is always split the same way, so both providers can cache the part that
 * repeats across the section calls of one assessment:
 *   system  - rules for the whole assessment and payer facts (same for every case)
 *   sources - the case's documents (same for every section of one case)
 *   task    - the section's own rules and the request (changes every call, never cached)
 */

export type ProviderId = "anthropic" | "openai" | "mock";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type SourceDocument =
  | { id: string; title: string; kind: "text"; text: string }
  | { id: string; title: string; kind: "pdf"; filename: string; base64: string };

export interface PromptParts {
  system: string;
  sources: SourceDocument[];
  task: string;
  /** What the task is: a section's (the default) or the case map's (its own preamble on the ChatGPT route; review round 1, M4). */
  kind?: "section" | "case-map" | "definition-review";
}

/**
 * How a request proves who it is for. "api-key": the user's own key for the provider
 * (Claude in the app; both providers in development and in pnpm phase0). "chatgpt": the
 * access token of Sign in with ChatGPT, which spends the user's ChatGPT plan (OpenAI
 * only); its requests follow OpenAI's rules for that flow (openai.ts).
 */
export type ProviderCredential = { kind: "api-key"; apiKey: string } | { kind: "chatgpt"; accessToken: string };

export function apiKeyCredential(apiKey: string): ProviderCredential {
  return { kind: "api-key", apiKey };
}

export interface GenerateOptions {
  /** Passed to the provider's client and nowhere else: never logged, never in an error. */
  credential: ProviderCredential;
  model: string;
  effort: Effort;
  maxOutputTokens: number;
  prompt: PromptParts;
  signal: AbortSignal;
  /**
   * An opaque key that groups the requests of one case for the provider's prompt cache
   * (OpenAI's `prompt_cache_key`, sent on the ChatGPT route only). Never the client's
   * name or anything she wrote: src/main/cache-key.ts derives it from the case's internal id.
   */
  cacheKey?: string | null;
  /**
   * The answer must be JSON in this schema: the case map's requests (src/lib/case-map-extraction.ts)
   * and the evaluation's judge (src/lib/judge.ts). OpenAI enforces it with text.format
   * (strict), Claude with output_config.format; the answer is still checked with Zod, and
   * a route that refuses the schema is asked for plain JSON. Never set on a section's request.
   */
  outputFormat?: OutputFormat | null;
}

/** A JSON schema the answer must follow. */
export interface OutputFormat {
  name: string;
  schema: Record<string, unknown>;
}

/** Token counts normalized across providers. The four buckets do not overlap. */
export interface TokenUsage {
  /** Input billed at the normal input rate. */
  uncachedInputTokens: number;
  /** Input written to the prompt cache (billed above the normal rate). */
  cacheWriteTokens: number;
  /** Input read from the prompt cache (billed far below the normal rate). */
  cacheReadTokens: number;
  /** All output, reasoning included. */
  outputTokens: number;
  /** The reasoning share of outputTokens, when the provider reports it. */
  reasoningTokens: number | null;
}

/** One model's share of a generation. There is more than one when a fallback model took over. */
export interface UsageAttempt {
  model: string;
  fallback: boolean;
  usage: TokenUsage;
}

export type GenerateEvent =
  | { type: "status"; phase: "thinking" | "writing" }
  | { type: "text"; delta: string }
  /** The requested model declined and another model continues the same answer. */
  | { type: "fallback"; from: string; to: string }
  /**
   * The provider refused and no fallback rescued the answer. This invalidates ALL text
   * received for this generation: the client must discard it, never show it as a draft.
   */
  | { type: "refusal"; discard: true; category: string | null; explanation: string | null }
  | {
      type: "done";
      /**
       * True only when the model finished on its own (Claude "end_turn", OpenAI
       * "completed") without a refusal. Anything else (output limit reached, content
       * filter, refusal) means the text is partial and must not be used as a draft.
       */
      complete: boolean;
      stopReason: string;
      /** The model that wrote the final text, which differs from the requested one after a fallback. */
      servedModel: string;
      /** Totals across all attempts. */
      usage: TokenUsage;
      /** Per-model breakdown when the provider reports one (Claude with fallbacks); null otherwise. */
      attempts: UsageAttempt[] | null;
    };

export interface ModelOption {
  id: string;
  label: string;
  createdAt: string | null;
}

/** What a provider needs from outside; tests pass a stub fetch so no network call is made. */
export interface ProviderDeps {
  fetch?: typeof fetch;
}

export interface Provider {
  id: ProviderId;
  /** The models this credential can use. A free call, so it also proves the credential works. */
  listModels(credential: ProviderCredential, signal: AbortSignal): Promise<ModelOption[]>;
  generate(options: GenerateOptions): AsyncIterable<GenerateEvent>;
  /** Writes the cacheable prefix (system + sources) without generating text. */
  prewarm(options: GenerateOptions): Promise<TokenUsage>;
}

/** An error whose message is safe to show the user: it never contains the key. */
export class ProviderError extends Error {
  readonly code: string;
  readonly status: number | null;

  constructor(code: string, message: string, status: number | null = null) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    this.status = status;
  }
}

/** How a text source is shown to the model. PDFs get the same header, then the file. */
export function sourceHeader(source: SourceDocument): string {
  const format = source.kind === "pdf" ? ' format="pdf" note="the PDF file follows this line"' : "";
  return `<source id="${source.id}" title="${source.title}"${format}>`;
}

export function textSourceBlock(source: Extract<SourceDocument, { kind: "text" }>): string {
  return `${sourceHeader(source)}\n${source.text.trim()}\n</source>`;
}
