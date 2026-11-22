import OpenAI from "openai";
import { z } from "zod";
import { providerTooLargeMessage } from "../limits.ts";
import { OPENAI_BASE_URL, pinnedFetch, removeEnvHeaders } from "./endpoints.ts";
import {
  ProviderError,
  sourceHeader,
  textSourceBlock,
  type GenerateEvent,
  type GenerateOptions,
  type ModelOption,
  type Provider,
  type ProviderCredential,
  type ProviderDeps,
  type TokenUsage,
} from "./types.ts";

function makeClient(credential: ProviderCredential, deps: ProviderDeps): OpenAI {
  // The key or token arrives with the request and lives only in this client object. Every
  // setting the SDK would otherwise take from the environment is given here
  // (endpoints.ts lists them): the official address, no extra headers, no organization,
  // project or admin key, and no logging, so OPENAI_LOG=debug can never print a body.
  // Sign in with ChatGPT: the access token is the SDK's bearer credential, as OpenAI's
  // own example does. No automatic retries: a retried 429 there would spend the user's
  // plan limits again, and OpenAI's recovery for each error is not "repeat the request".
  const chatgpt = credential.kind === "chatgpt";
  return new OpenAI({
    apiKey: chatgpt ? credential.accessToken : credential.apiKey,
    baseURL: OPENAI_BASE_URL,
    defaultHeaders: removeEnvHeaders("OPENAI_CUSTOM_HEADERS"),
    adminAPIKey: null,
    organization: null,
    project: null,
    webhookSecret: null,
    maxRetries: chatgpt ? 0 : 2,
    logLevel: "off",
    fetch: pinnedFetch(OPENAI_BASE_URL, deps.fetch),
  });
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

/** OpenAI's input_tokens includes both cached reads and cache writes (see the prompt caching guide's usage example). */
export function normalizeUsage(usage: OpenAI.Responses.ResponseUsage | undefined): TokenUsage {
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

/**
 * What OpenAI's Sign in with ChatGPT flow answers for its own failures, and what to do
 * about each (developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery,
 * read 2026-11-22). They can come back as the HTTP error of the request or, after the
 * stream has started, as a failed response.
 */
const CHATGPT_ERRORS: Record<string, { code: string; message: string }> = {
  subscription_sharing_user_not_eligible: {
    code: "chatgpt_not_eligible",
    message: "This ChatGPT account cannot use its plan in ABA Workbench (its plan, workspace or a policy does not allow it).",
  },
  subscription_sharing_usage_limit_exceeded: {
    code: "chatgpt_usage_limit",
    message: "A ChatGPT usage limit was reached, for your plan or for this app. See your usage in ChatGPT's settings.",
  },
  subscription_sharing_usage_unavailable: {
    code: "chatgpt_unavailable",
    message: "ChatGPT could not check your plan's usage just now. Try again in a few minutes.",
  },
  subscription_sharing_user_unavailable: {
    code: "chatgpt_unavailable",
    message: "ChatGPT could not reach your account's details just now. Try again in a few minutes.",
  },
  subscription_sharing_unsupported_capability: {
    code: "chatgpt_unsupported",
    message: "ChatGPT plan use does not support part of this request.",
  },
  subscription_sharing_route_not_supported: {
    code: "chatgpt_unsupported",
    message: "ChatGPT plan use does not support this kind of request.",
  },
  subscription_sharing_invalid_user: {
    code: "chatgpt_signed_out",
    message: "ChatGPT did not accept your sign-in. Sign in again in Settings.",
  },
  chatpass_v2_scope_not_authorized: {
    code: "chatgpt_not_authorized",
    message: "Your ChatGPT sign-in does not allow this. Sign in again in Settings and allow ABA Workbench to use your plan.",
  },
  chatpass_v2_invalid_authorization_context: {
    code: "chatgpt_not_authorized",
    message: "Your ChatGPT sign-in does not allow this. Sign in again in Settings and allow ABA Workbench to use your plan.",
  },
};

/** A ChatGPT plan error by OpenAI's code; `param` (the part of the request it refused) is kept when given. */
function chatgptError(errorCode: string | null | undefined, status: number | null, param?: string | null): ProviderError | null {
  const known = errorCode ? CHATGPT_ERRORS[errorCode] : undefined;
  if (!known) return null;
  if (known.code === "chatgpt_unsupported" && param) {
    return new ProviderError(known.code, `${known.message.replace(/\.$/, "")} (${param.slice(0, 100)}).`, status);
  }
  return new ProviderError(known.code, known.message, status);
}

/**
 * Turns an SDK error into a message that is safe to show. `credential` says which way the
 * request authenticated, since the same status means different things for an API key and
 * for a ChatGPT sign-in.
 */
export function toProviderError(error: unknown, credential: ProviderCredential["kind"] = "api-key"): ProviderError | null {
  if (!(error instanceof OpenAI.APIError)) return null;
  const status = error.status ?? null;
  if (credential === "chatgpt") {
    const known = chatgptError(error.code, status, error.param);
    if (known) return known;
    // Before a stream opens, the plan route can answer with a bare {"detail": "..."}: by status.
    if (status === 401) return new ProviderError("chatgpt_signed_out", "ChatGPT did not accept your sign-in. Sign in again in Settings.", status);
    if (status === 403) return new ProviderError("chatgpt_not_allowed", "ChatGPT refused the request (a policy or permission check, such as the region it is sent from).", status);
    if (status === 429) return new ProviderError("chatgpt_usage_limit", CHATGPT_ERRORS.subscription_sharing_usage_limit_exceeded.message, status);
    if (status === 503) return new ProviderError("chatgpt_unavailable", "ChatGPT plan use is not available just now. Try again in a few minutes.", status);
  }
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
  // A body over the limit: the size check before sending should prevent it (limits.ts).
  if (status === 413) {
    return new ProviderError("request_too_large", providerTooLargeMessage("openai"), status);
  }
  if (error instanceof OpenAI.BadRequestError) {
    return new ProviderError("bad_request", `OpenAI refused the request: ${error.message.slice(0, 300)}`, status);
  }
  return new ProviderError("provider_error", `OpenAI error ${status ?? ""}`.trim(), status);
}

/** Only text-generation models are offered; image, audio and realtime models are not. */
const NOT_TEXT_GENERATION = /(image|audio|realtime|transcribe|tts|live|whisper|translate|search|embedding|moderation|cyber)/;

/**
 * The model list Sign in with ChatGPT gives: `models[]` with `slug` and `display_name`,
 * in the order the server chose (models-and-inference, step 1). Only `visibility: "list"`
 * is meant for display.
 */
const ChatGptModelList = z.object({
  models: z.array(
    z.looseObject({
      slug: z.string().min(1).max(200),
      display_name: z.string().max(200).nullish(),
      visibility: z.string().nullish(),
    }),
  ),
});

/**
 * The request body for the Responses API. With Sign in with ChatGPT, OpenAI's preview
 * rules apply (preview-limitations, read 2026-11-22): `stream: true` and `store: false`
 * on every request, `input` as an array, and none of `max_output_tokens`,
 * `prompt_cache_retention`, `metadata`, `temperature`, `top_p`, `truncation`, `user`
 * and the other fields it lists. The cache's `ttl` replaces `prompt_cache_retention`
 * (the SDK marks that field deprecated in its favor), so it is left out too and the
 * breakpoints keep OpenAI's default lifetime.
 */
export function responsesRequest(options: GenerateOptions): OpenAI.Responses.ResponseCreateParamsStreaming {
  const base = {
    model: options.model,
    input: buildInput(options, true),
    stream: true as const,
    store: false, // nothing about the case is kept on OpenAI's side for later retrieval
    reasoning: { effort: options.effort },
  };
  if (options.credential.kind === "chatgpt") return { ...base, prompt_cache_options: { mode: "explicit" } };
  return { ...base, max_output_tokens: options.maxOutputTokens, prompt_cache_options: { mode: "explicit", ttl: "30m" } };
}

export function createOpenAIProvider(deps: ProviderDeps = {}): Provider {
  const client = (credential: ProviderCredential) => makeClient(credential, deps);
  /** Runs `call`, turning an SDK error into a safe one that knows how the request authenticated. */
  async function guarded<T>(credential: ProviderCredential, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      throw toProviderError(error, credential.kind) ?? error;
    }
  }
  return {
    id: "openai",

    async listModels(credential, signal) {
      if (credential.kind === "chatgpt") {
        const body = await guarded(credential, () => client(credential).get<unknown>("/models", { signal }));
        const parsed = ChatGptModelList.safeParse(body);
        if (!parsed.success) throw new ProviderError("provider_error", "OpenAI answered with a model list this app does not understand.");
        return parsed.data.models
          .filter((model) => model.visibility === "list")
          .map((model) => ({ id: model.slug, label: model.display_name || model.slug, createdAt: null }));
      }
      return guarded(credential, async () => {
        const models: ModelOption[] = [];
        for await (const model of client(credential).models.list({ signal })) {
          if (!/^gpt-\d/.test(model.id) || NOT_TEXT_GENERATION.test(model.id)) continue;
          models.push({ id: model.id, label: model.id, createdAt: new Date(model.created * 1000).toISOString() });
        }
        return models;
      });
    },

    async *generate(options): AsyncIterable<GenerateEvent> {
      const kind = options.credential.kind;
      const stream = await guarded(options.credential, () => client(options.credential).responses.create(responsesRequest(options), { signal: options.signal }));

      let final: OpenAI.Responses.Response | null = null;
      let refusal = "";
      let writing = false;
      try {
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
            case "response.failed": {
              // A ChatGPT usage limit can arrive here, after the stream has begun.
              const failure = event.response.error;
              const known = kind === "chatgpt" ? chatgptError(failure?.code, null) : null;
              throw known ?? new ProviderError("provider_error", `OpenAI could not finish: ${failure?.message ?? "unknown error"}`);
            }
            case "error": {
              const known = kind === "chatgpt" ? chatgptError(event.code, null, event.param) : null;
              throw known ?? new ProviderError("provider_error", `OpenAI stream error: ${event.message}`);
            }
          }
        }
      } catch (error) {
        throw toProviderError(error, kind) ?? error;
      }
      // Only response.completed (or .incomplete, reported as not complete) ends a generation.
      if (!final) throw new ProviderError("provider_error", "OpenAI stream ended without a final response.");

      if (refusal) yield { type: "refusal", discard: true, category: null, explanation: refusal };
      const stopReason =
        final.status === "incomplete" ? (final.incomplete_details?.reason ?? "incomplete") : refusal ? "refusal" : (final.status ?? "unknown");
      yield {
        type: "done",
        complete: final.status === "completed" && !refusal,
        stopReason,
        servedModel: final.model,
        usage: normalizeUsage(final.usage),
        attempts: null,
      };
    },

    async prewarm(options) {
      // Pre-warming is a request that does not stream, which Sign in with ChatGPT refuses.
      if (options.credential.kind === "chatgpt") {
        throw new ProviderError("chatgpt_unsupported", "Pre-warming the cache is not available with Sign in with ChatGPT.");
      }
      const response = await guarded(options.credential, () =>
        client(options.credential).responses.create(
          {
            model: options.model,
            input: buildInput(options, false),
            store: false,
            reasoning: { effort: options.effort },
            prompt_cache_options: { mode: "explicit", ttl: "30m", prewarm: true },
          },
          { signal: options.signal },
        ),
      );
      return normalizeUsage(response.usage);
    },
  };
}

export const openaiProvider = createOpenAIProvider();
