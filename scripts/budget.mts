/**
 * The spending cap for pnpm phase0, kept apart from the script so it can be tested.
 * It fails closed: a budget that is not a positive number, a model without a price,
 * or a call whose cost is unknown all stop the run instead of counting as zero.
 */
import { CLAUDE_FALLBACK_TARGETS, PRICES } from "../src/lib/pricing.ts";

export interface Phase0Args {
  mock: boolean;
  only: string[] | null;
  cases: string[] | null;
  budgetUsd: number;
  prewarm: boolean;
}

const BOOLEAN_FLAGS = new Set(["mock", "no-prewarm"]);
const VALUE_FLAGS = new Set(["only", "case", "budget"]);

/** Accepts --name=value and --name value; anything unknown or malformed throws. */
export function parseArgs(argv: string[]): Phase0Args {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument "${arg}".`);
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    if (BOOLEAN_FLAGS.has(name)) {
      if (inline !== undefined) throw new Error(`--${name} takes no value.`);
      flags.add(name);
    } else if (VALUE_FLAGS.has(name)) {
      const value = inline ?? argv[++i];
      if (value === undefined || value === "" || value.startsWith("--")) throw new Error(`--${name} needs a value.`);
      values.set(name, value);
    } else {
      throw new Error(`Unknown option --${name}.`);
    }
  }

  const budgetText = values.get("budget") ?? "5";
  const budgetUsd = Number(budgetText);
  if (!/^\d+(\.\d+)?$/.test(budgetText) || !Number.isFinite(budgetUsd) || budgetUsd <= 0) {
    throw new Error(`--budget must be a positive number of dollars, got "${budgetText}".`);
  }
  const list = (value: string | undefined) =>
    value === undefined ? null : value.split(",").map((s) => s.trim()).filter(Boolean);

  return {
    mock: flags.has("mock"),
    only: list(values.get("only")),
    cases: list(values.get("case")),
    budgetUsd,
    prewarm: !flags.has("no-prewarm"),
  };
}

export class UnknownPriceError extends Error {}

function priceOf(model: string) {
  const price = PRICES[model];
  if (!price) throw new UnknownPriceError(`There is no price for ${model} in src/lib/pricing.ts; the run cannot stay inside the budget.`);
  return price;
}

/**
 * The most one generate call can cost, with its pre-warm: every input token billed at
 * the cache-write price (twice when a pre-warm runs first), the whole output allowance
 * used, and for Claude one more full attempt on the most expensive fallback model.
 */
export function worstCaseCallUsd(call: {
  provider: string;
  model: string;
  inputTokens: number;
  maxOutputTokens: number;
  prewarm: boolean;
}): number {
  if (call.provider === "mock") return 0;
  const price = priceOf(call.model);
  const writes = call.prewarm ? 2 : 1;
  let worst = (call.inputTokens * price.cacheWrite * writes + call.maxOutputTokens * price.output) / 1_000_000;
  if (call.provider === "anthropic") {
    worst += Math.max(
      ...CLAUDE_FALLBACK_TARGETS.map((model) => {
        const p = priceOf(model);
        return (call.inputTokens * p.cacheWrite + call.maxOutputTokens * p.output) / 1_000_000;
      }),
    );
  }
  return worst;
}

/** Input tokens are bounded generously: 3 characters per token and 3,000 tokens per PDF page. */
export function inputTokensUpperBound(textChars: number, pdfPages: number): number {
  return Math.ceil(textChars / 3) + pdfPages * 3_000 + 1_000;
}

/** Page objects in the PDF; failing that the page tree's /Count; failing that one page per 50 KB. */
export function countPdfPages(pdf: Uint8Array): number {
  const text = new TextDecoder("latin1").decode(pdf);
  const pageObjects = (text.match(/\/Type\s*\/Page(?!s)/g) ?? []).length;
  if (pageObjects > 0) return pageObjects;
  const counts = [...text.matchAll(/\/Count\s+(\d+)/g)].map((m) => Number(m[1]));
  if (counts.length > 0) return Math.max(...counts);
  return Math.max(1, Math.ceil(pdf.byteLength / 50_000));
}

export class SpendTracker {
  readonly budgetUsd: number;
  spentUsd = 0;

  constructor(budgetUsd: number) {
    this.budgetUsd = budgetUsd;
  }

  /** A call may start only if its worst case cannot take the total past the budget. */
  canStart(worstCaseUsd: number): boolean {
    return this.spentUsd + worstCaseUsd <= this.budgetUsd;
  }

  /**
   * Adds what a call cost. When the cost is unknown (the stream died, or a model has no
   * price) the worst case is charged and `known` is false: the caller must stop.
   */
  charge(actualUsd: number | null, worstCaseUsd: number): { known: boolean } {
    if (actualUsd === null || !Number.isFinite(actualUsd)) {
      this.spentUsd += worstCaseUsd;
      return { known: false };
    }
    this.spentUsd += actualUsd;
    return { known: true };
  }
}
