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
}

export interface GenerateOptions {
  apiKey: string;
  model: string;
  effort: Effort;
  maxOutputTokens: number;
  prompt: PromptParts;
  signal: AbortSignal;
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
  | { type: "refusal"; category: string | null; explanation: string | null }
  | {
      type: "done";
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

export interface Provider {
  id: ProviderId;
  listModels(apiKey: string, signal: AbortSignal): Promise<ModelOption[]>;
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
