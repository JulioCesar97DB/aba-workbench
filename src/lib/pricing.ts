import type { TokenUsage, UsageAttempt } from "./providers/types";

/**
 * Standard-tier prices in USD per million tokens, short context, as published on the
 * date below. Used to report what each generation cost. Update when providers change them.
 *
 * cacheWrite is the price of the cache lifetime this project uses: Claude's default
 * 5-minute cache (1.25x input) and OpenAI's default 30-minute cache (1.25x input).
 */
export const PRICES_CHECKED_ON = "2026-11-21";

export interface ModelPrice {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  source: string;
}

export const PRICES: Record<string, ModelPrice> = {
  "claude-opus-5-5": { input: 4, cacheWrite: 5, cacheRead: 0.2, output: 20, source: "https://platform.claude.com/docs/en/about-claude/pricing" },
  "claude-fable-5-2": { input: 8, cacheWrite: 10, cacheRead: 0.2, output: 40, source: "https://platform.claude.com/docs/en/about-claude/pricing" },
  "gpt-6.2-astra": { input: 8, cacheWrite: 10, cacheRead: 0.4, output: 40, source: "https://developers.openai.com/api/docs/models/gpt-6.2-astra" },
  "gpt-6.2-sol": { input: 2, cacheWrite: 2.5, cacheRead: 0.1, output: 10, source: "https://developers.openai.com/api/docs/models/gpt-6.2-sol" },
};

/**
 * Cost of one generation. After a Claude fallback, each attempt is priced at the rate
 * of the model that ran it; null when a model's price is unknown.
 */
export function generationCostUsd(model: string, usage: TokenUsage, attempts: UsageAttempt[] | null): number | null {
  if (!attempts) return costUsd(model, usage);
  let total = 0;
  for (const attempt of attempts) {
    const cost = costUsd(attempt.model, attempt.usage);
    if (cost === null) return null;
    total += cost;
  }
  return total;
}

export function costUsd(model: string, usage: TokenUsage): number | null {
  const price = PRICES[model];
  if (!price) return null;
  return (
    (usage.uncachedInputTokens * price.input +
      usage.cacheWriteTokens * price.cacheWrite +
      usage.cacheReadTokens * price.cacheRead +
      usage.outputTokens * price.output) /
    1_000_000
  );
}
