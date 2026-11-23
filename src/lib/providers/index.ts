import { anthropicProvider, toProviderError as anthropicError } from "./anthropic.ts";
import { openaiProvider, toProviderError as openaiError } from "./openai.ts";
import { ProviderError, type Provider, type ProviderId } from "./types.ts";
import { MODEL_CHOICES } from "../../shared/models.ts";

export * from "./types.ts";

/**
 * The real providers by id. The mock is not here: the code that wants it (the
 * development check, `pnpm phase0 --mock`) imports it directly, so a provider id that
 * arrives from outside can never select it.
 */
export function getProvider(id: string): Provider | null {
  if (id === "anthropic") return anthropicProvider;
  if (id === "openai") return openaiProvider;
  return null;
}

/** Turns any failure into a message that is safe to show the user: no key, path or request body. */
export function toSafeError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  // The SDKs wrap a refusal from the pinned fetch (endpoints.ts) in a connection error.
  if (error instanceof Error && error.cause instanceof ProviderError) return error.cause;
  const known = anthropicError(error) ?? openaiError(error);
  if (known) return known;
  return new ProviderError("internal_error", "The request failed before the provider answered.");
}

/**
 * The default model is the most capable one in the provider's list. Providers do not
 * rank capability in their model lists, so the ranking is ours and lives here.
 */
const MOST_CAPABLE_FIRST: Record<ProviderId, string[]> = {
  anthropic: MODEL_CHOICES.anthropic.map((choice) => choice.id),
  openai: MODEL_CHOICES.openai.map((choice) => choice.id),
  mock: ["mock-echo"],
};

export function rankModels<T extends { id: string; createdAt: string | null }>(provider: ProviderId, models: T[]): T[] {
  const ranking = MOST_CAPABLE_FIRST[provider];
  const rank = (id: string) => {
    const index = ranking.indexOf(id);
    return index === -1 ? ranking.length : index;
  };
  return [...models].sort((a, b) => rank(a.id) - rank(b.id) || (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
}
