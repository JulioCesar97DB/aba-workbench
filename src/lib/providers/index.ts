import { anthropicProvider, toProviderError as anthropicError } from "./anthropic.ts";
import { mockProvider } from "./mock.ts";
import { openaiProvider, toProviderError as openaiError } from "./openai.ts";
import { ProviderError, type Provider, type ProviderId } from "./types.ts";

export * from "./types.ts";

export function mockEnabled(): boolean {
  return process.env.ABA_ENABLE_MOCK_PROVIDER === "1";
}

export function getProvider(id: string): Provider | null {
  if (id === "anthropic") return anthropicProvider;
  if (id === "openai") return openaiProvider;
  if (id === "mock" && mockEnabled()) return mockProvider;
  return null;
}

/** Turns any failure into a message that is safe to send to the browser. */
export function toSafeError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  const known = anthropicError(error) ?? openaiError(error);
  if (known) return known;
  return new ProviderError("internal_error", "The request failed before the provider answered.");
}

/**
 * The default model is the most capable one in the provider's list. Providers do not
 * rank capability in their model lists, so the ranking is ours and lives here.
 */
const MOST_CAPABLE_FIRST: Record<ProviderId, string[]> = {
  anthropic: ["claude-fable-5-2", "claude-opus-5-5"],
  openai: ["gpt-6.2-astra", "gpt-6.2-sol"],
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
