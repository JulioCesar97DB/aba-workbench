import Anthropic from "@anthropic-ai/sdk";
import { pdfPageLimitMessage, providerTooLargeMessage } from "../limits.ts";
import {
  ProviderError,
  sourceHeader,
  textSourceBlock,
  type GenerateEvent,
  type GenerateOptions,
  type ModelOption,
  type Provider,
  type ProviderDeps,
  type TokenUsage,
  type UsageAttempt,
} from "./types.ts";

type Beta = Anthropic.Beta.Messages.BetaMessage;
type BetaUsage = Anthropic.Beta.Messages.BetaUsage;

/**
 * Server-side fallbacks (beta, chosen by the owner on 2026-11-21). When the requested
 * model declines on policy grounds, Anthropic re-runs the request on the model it
 * recommends for that refusal category, inside the same call. To turn it off, set this
 * to null; nothing else changes. Some categories have no fallback and still come back
 * as stop_reason "refusal", which generate() reports.
 */
const SERVER_SIDE_FALLBACKS = {
  betas: ["server-side-fallback-2026-07-01"],
  fallbacks: "default",
} as const satisfies { betas: Anthropic.Beta.AnthropicBeta[]; fallbacks: "default" };

function makeClient(apiKey: string, deps: ProviderDeps): Anthropic {
  // The key arrives with the request and lives only in this client object. Logging is
  // off so that ANTHROPIC_LOG=debug can never print a request body.
  return new Anthropic({ apiKey, maxRetries: 2, logLevel: "off", ...(deps.fetch ? { fetch: deps.fetch } : {}) });
}

/**
 * system (rules) ▼ | sources ▼ | task
 * Two cache breakpoints: the rules are shared by every case, the sources by every
 * section of one case. The task after the last breakpoint is never written to cache.
 */
function buildParams(options: GenerateOptions, includeTask = true) {
  const { prompt } = options;
  const content: Array<Anthropic.Beta.Messages.BetaTextBlockParam | Anthropic.Beta.Messages.BetaRequestDocumentBlock> = [];
  for (const source of prompt.sources) {
    if (source.kind === "pdf") {
      content.push({ type: "text", text: sourceHeader(source) });
      content.push({
        type: "document",
        title: source.title,
        source: { type: "base64", media_type: "application/pdf", data: source.base64 },
      });
    } else {
      content.push({ type: "text", text: textSourceBlock(source) });
    }
  }
  const lastSource = content.at(-1);
  if (lastSource) lastSource.cache_control = { type: "ephemeral" };
  if (includeTask) content.push({ type: "text", text: prompt.task });

  return {
    model: options.model,
    max_tokens: options.maxOutputTokens,
    // Current models think adaptively; effort is the control (Opus 5.5 defaults to medium).
    thinking: { type: "adaptive" as const },
    output_config: { effort: options.effort },
    system: [{ type: "text" as const, text: prompt.system, cache_control: { type: "ephemeral" as const } }],
    messages: [{ role: "user" as const, content }],
    ...(SERVER_SIDE_FALLBACKS ?? {}),
  };
}

function toTokenUsage(u: {
  input_tokens: number;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
  output_tokens: number;
}): TokenUsage {
  return {
    uncachedInputTokens: u.input_tokens,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    outputTokens: u.output_tokens,
    reasoningTokens: null,
  };
}

/**
 * With fallbacks, the top-level usage covers only the attempt that produced the final
 * message; usage.iterations lists every attempt, each billed at its own model's price.
 */
export function readUsage(message: Pick<Beta, "usage">, requestedModel: string): { usage: TokenUsage; attempts: UsageAttempt[] | null } {
  const top = message.usage;
  const iterations = (top.iterations ?? []).filter(
    (it): it is Extract<NonNullable<BetaUsage["iterations"]>[number], { type: "message" | "fallback_message" }> =>
      it.type === "message" || it.type === "fallback_message",
  );
  const fallbackRan = iterations.some((it) => it.type === "fallback_message");
  if (!fallbackRan) {
    const usage = toTokenUsage(top);
    usage.reasoningTokens = top.output_tokens_details?.thinking_tokens ?? null;
    return { usage, attempts: null };
  }
  const attempts = iterations.map((it) => ({
    model: it.model ?? requestedModel,
    fallback: it.type === "fallback_message",
    usage: toTokenUsage(it),
  }));
  const sum = (key: keyof Omit<TokenUsage, "reasoningTokens">) => attempts.reduce((n, a) => n + a.usage[key], 0);
  return {
    usage: {
      uncachedInputTokens: sum("uncachedInputTokens"),
      cacheWriteTokens: sum("cacheWriteTokens"),
      cacheReadTokens: sum("cacheReadTokens"),
      outputTokens: sum("outputTokens"),
      reasoningTokens: null,
    },
    attempts,
  };
}

export function toProviderError(error: unknown): ProviderError | null {
  if (!(error instanceof Anthropic.APIError)) return null;
  const status = error.status ?? null;
  if (error instanceof Anthropic.AuthenticationError) {
    return new ProviderError("invalid_key", "Anthropic rejected the API key.", status);
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return new ProviderError("forbidden", "This Anthropic key is not allowed to use that model or feature.", status);
  }
  if (error instanceof Anthropic.NotFoundError) {
    return new ProviderError("model_not_found", "Anthropic does not know that model for this key.", status);
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new ProviderError("rate_limited", "Anthropic rate limit reached; try again in a minute.", status);
  }
  // 413 request_too_large: the size check before sending should prevent it (limits.ts).
  if (status === 413) {
    return new ProviderError("request_too_large", providerTooLargeMessage("anthropic"), status);
  }
  if (error instanceof Anthropic.BadRequestError) {
    // The documentation does not give the wording of the PDF page-limit error, so any
    // refusal that names PDFs and pages is explained as one, with Claude's own words kept.
    if (/pdf/i.test(error.message) && /page/i.test(error.message)) {
      return new ProviderError("too_many_pdf_pages", pdfPageLimitMessage(error.message), status);
    }
    return new ProviderError("bad_request", `Anthropic refused the request: ${error.message.slice(0, 300)}`, status);
  }
  return new ProviderError("provider_error", `Anthropic error ${status ?? ""}`.trim(), status);
}

export function createAnthropicProvider(deps: ProviderDeps = {}): Provider {
  const client = (apiKey: string) => makeClient(apiKey, deps);
  return {
    id: "anthropic",

    async listModels(apiKey, signal) {
      const models: ModelOption[] = [];
      for await (const model of client(apiKey).models.list({ limit: 100 }, { signal })) {
        if (model.lifecycle === "retired") continue;
        models.push({ id: model.id, label: model.display_name, createdAt: model.created_at });
      }
      return models;
    },

    async *generate(options): AsyncIterable<GenerateEvent> {
      const stream = client(options.apiKey).beta.messages.stream(buildParams(options), { signal: options.signal });
      for await (const event of stream) {
        if (event.type === "content_block_start") {
          const block = event.content_block;
          if (block.type === "thinking") yield { type: "status", phase: "thinking" };
          else if (block.type === "text") yield { type: "status", phase: "writing" };
          // A fallback keeps the text already streamed and the next model continues it.
          else if (block.type === "fallback") yield { type: "fallback", from: block.from.model, to: block.to.model };
        } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          yield { type: "text", delta: event.delta.text };
        }
      }
      const message = await stream.finalMessage();
      // A refusal that no fallback rescued: whatever text arrived must be discarded.
      const refused = message.stop_reason === "refusal";
      if (refused) {
        yield {
          type: "refusal",
          discard: true,
          category: message.stop_details?.category ?? null,
          explanation: message.stop_details?.explanation ?? null,
        };
      }
      const { usage, attempts } = readUsage(message, options.model);
      yield {
        type: "done",
        complete: message.stop_reason === "end_turn" && !refused,
        stopReason: message.stop_reason ?? "unknown",
        servedModel: message.model,
        usage,
        attempts,
      };
    },

    async prewarm(options) {
      // max_tokens 0 runs prefill only: it writes the cache up to the last breakpoint
      // (the end of the sources) and returns no content. Same settings as the real call.
      const message = await client(options.apiKey).beta.messages.create(
        { ...buildParams(options, false), max_tokens: 0 },
        { signal: options.signal },
      );
      return readUsage(message, options.model).usage;
    },
  };
}

export const anthropicProvider = createAnthropicProvider();
