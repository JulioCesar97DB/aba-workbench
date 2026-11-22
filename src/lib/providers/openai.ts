import OpenAI from "openai";
import {
  ProviderError,
  sourceHeader,
  textSourceBlock,
  type GenerateEvent,
  type GenerateOptions,
  type ModelOption,
  type Provider,
  type TokenUsage,
} from "./types";

function client(apiKey: string): OpenAI {
  // The key arrives with the request and lives only in this client object.
  return new OpenAI({ apiKey, maxRetries: 2 });
}

const breakpoint = { mode: "explicit" as const };

/**
 * [developer: rules ▼] [user: sources ▼] [user: task]
 * GPT-6.2 appends top-level `instructions` after the input and never caches them,
 * so the rules go in the first developer message. Explicit-only caching writes just
 * the two stable prefixes; the task is billed as plain input with no cache write.
 */
function buildInput(options: GenerateOptions, includeTask: boolean): OpenAI.Responses.ResponseInput {
  const { prompt } = options;
  const sourceParts: OpenAI.Responses.ResponseInputContent[] = [];
  for (const source of prompt.sources) {
    if (source.kind === "pdf") {
      sourceParts.push({ type: "input_text", text: sourceHeader(source) });
      sourceParts.push({
        type: "input_file",
        filename: source.filename,
        file_data: `data:application/pdf;base64,${source.base64}`,
      });
    } else {
      sourceParts.push({ type: "input_text", text: textSourceBlock(source) });
    }
  }
  // Breakpoint on a closing text block rather than on a file part.
  sourceParts.push({ type: "input_text", text: "</sources>", prompt_cache_breakpoint: breakpoint });

  const input: OpenAI.Responses.ResponseInput = [
    { role: "developer", content: [{ type: "input_text", text: prompt.system, prompt_cache_breakpoint: breakpoint }] },
    { role: "user", content: [{ type: "input_text", text: "<sources>" }, ...sourceParts] },
  ];
  if (includeTask) input.push({ role: "user", content: [{ type: "input_text", text: prompt.task }] });
  return input;
}

function normalizeUsage(usage: OpenAI.Responses.ResponseUsage | undefined): TokenUsage {
  if (!usage) {
    return { uncachedInputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0, reasoningTokens: null };
  }
  const cacheReadTokens = usage.input_tokens_details?.cached_tokens ?? 0;
  const cacheWriteTokens = usage.input_tokens_details?.cache_write_tokens ?? 0;
  return {
    uncachedInputTokens: Math.max(0, usage.input_tokens - cacheReadTokens - cacheWriteTokens),
    cacheWriteTokens,
    cacheReadTokens,
    outputTokens: usage.output_tokens,
    reasoningTokens: usage.output_tokens_details?.reasoning_tokens ?? null,
  };
}

export function toProviderError(error: unknown): ProviderError | null {
  if (!(error instanceof OpenAI.APIError)) return null;
  const status = error.status ?? null;
  // OpenAI's 401 message quotes part of the key, so it is never passed on.
  if (error instanceof OpenAI.AuthenticationError) {
    return new ProviderError("invalid_key", "OpenAI rejected the API key.", status);
  }
  if (error instanceof OpenAI.PermissionDeniedError) {
    return new ProviderError("forbidden", "This OpenAI key is not allowed to use that model or feature.", status);
  }
  if (error instanceof OpenAI.NotFoundError) {
    return new ProviderError("model_not_found", "OpenAI does not know that model for this key.", status);
  }
  if (error instanceof OpenAI.RateLimitError) {
    return new ProviderError("rate_limited", "OpenAI rate limit or quota reached; check the account's billing.", status);
  }
  if (error instanceof OpenAI.BadRequestError) {
    return new ProviderError("bad_request", `OpenAI refused the request: ${error.message.slice(0, 300)}`, status);
  }
  return new ProviderError("provider_error", `OpenAI error ${status ?? ""}`.trim(), status);
}

/** Only text-generation models are offered; image, audio and realtime models are not. */
const NOT_TEXT_GENERATION = /(image|audio|realtime|transcribe|tts|live|whisper|translate|search|embedding|moderation|cyber)/;

export const openaiProvider: Provider = {
  id: "openai",

  async listModels(apiKey, signal) {
    const models: ModelOption[] = [];
    for await (const model of client(apiKey).models.list({ signal })) {
      if (!/^gpt-\d/.test(model.id) || NOT_TEXT_GENERATION.test(model.id)) continue;
      models.push({ id: model.id, label: model.id, createdAt: new Date(model.created * 1000).toISOString() });
    }
    return models;
  },

  async *generate(options): AsyncIterable<GenerateEvent> {
    const stream = await client(options.apiKey).responses.create(
      {
        model: options.model,
        input: buildInput(options, true),
        stream: true,
        store: false, // nothing about the case is kept on OpenAI's side for later retrieval
        reasoning: { effort: options.effort },
        max_output_tokens: options.maxOutputTokens,
        prompt_cache_options: { mode: "explicit", ttl: "30m" },
      },
      { signal: options.signal },
    );

    let final: OpenAI.Responses.Response | null = null;
    let refusal = "";
    let writing = false;
    for await (const event of stream) {
      switch (event.type) {
        case "response.output_item.added":
          if (event.item.type === "reasoning") yield { type: "status", phase: "thinking" };
          break;
        case "response.output_text.delta":
          if (!writing) {
            writing = true;
            yield { type: "status", phase: "writing" };
          }
          yield { type: "text", delta: event.delta };
          break;
        case "response.refusal.delta":
          refusal += event.delta;
          break;
        case "response.completed":
        case "response.incomplete":
          final = event.response;
          break;
        case "response.failed":
          throw new ProviderError("provider_error", `OpenAI could not finish: ${event.response.error?.message ?? "unknown error"}`);
        case "error":
          throw new ProviderError("provider_error", `OpenAI stream error: ${event.message}`);
      }
    }
    if (!final) throw new ProviderError("provider_error", "OpenAI stream ended without a final response.");

    if (refusal) yield { type: "refusal", category: null, explanation: refusal };
    const stopReason =
      final.status === "incomplete" ? (final.incomplete_details?.reason ?? "incomplete") : refusal ? "refusal" : (final.status ?? "unknown");
    yield { type: "done", stopReason, servedModel: final.model, usage: normalizeUsage(final.usage), attempts: null };
  },

  async prewarm(options) {
    const response = await client(options.apiKey).responses.create(
      {
        model: options.model,
        input: buildInput(options, false),
        store: false,
        reasoning: { effort: options.effort },
        prompt_cache_options: { mode: "explicit", ttl: "30m", prewarm: true },
      },
      { signal: options.signal },
    );
    return normalizeUsage(response.usage);
  },
};
