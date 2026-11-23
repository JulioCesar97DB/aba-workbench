import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { countPdfPages, parseArgs, SpendTracker, UnknownPriceError, worstCaseCallUsd } from "../scripts/budget.mts";
import { generationCostUsd } from "../src/lib/pricing.ts";

test("arguments: --name=value and --name value both work", () => {
  assert.equal(parseArgs(["--budget=3"]).budgetUsd, 3);
  assert.equal(parseArgs(["--budget", "2.5"]).budgetUsd, 2.5);
  assert.deepEqual(parseArgs(["--only", "claude-opus-5-5,gpt-6.2-sol"]).only, ["claude-opus-5-5", "gpt-6.2-sol"]);
  assert.deepEqual(parseArgs(["--case=case-a-mateo"]).cases, ["case-a-mateo"]);
  const defaults = parseArgs([]);
  assert.equal(defaults.budgetUsd, 5);
  assert.equal(defaults.prewarm, true);
  assert.equal(parseArgs(["--no-prewarm", "--mock"]).prewarm, false);
});

test("arguments: a budget that is not a positive number, or an unknown option, stops the run", () => {
  for (const argv of [["--budget=abc"], ["--budget", "-1"], ["--budget=0"], ["--budget"], ["--budget", "--mock"], ["--budget=NaN"], ["--bugdet=3"], ["stray"], ["--mock=yes"]]) {
    assert.throws(() => parseArgs(argv), Error, argv.join(" "));
  }
});

test("worst case uses the full output allowance, the pre-warm and a Claude fallback", () => {
  const sol = worstCaseCallUsd({ provider: "openai", model: "gpt-6.2-sol", inputTokens: 20_000, maxOutputTokens: 32_000, prewarm: true });
  // 20,000 x $2.50 x 2 writes + 32,000 x $10, per million
  assert.equal(sol.toFixed(4), "0.4200");
  const opus = worstCaseCallUsd({ provider: "anthropic", model: "claude-opus-5-5", inputTokens: 20_000, maxOutputTokens: 32_000, prewarm: false });
  // 1-hour cache writes: own attempt 20,000 x $8 + 32,000 x $20; fallback attempt 20,000 x $10 + 32,000 x $25
  assert.equal(opus.toFixed(4), (0.16 + 0.64 + 0.2 + 0.8).toFixed(4));
  assert.throws(() => worstCaseCallUsd({ provider: "anthropic", model: "claude-unknown", inputTokens: 1, maxOutputTokens: 1, prewarm: false }), UnknownPriceError);
});

test("the tracker never starts a call that could pass the cap, and an unknown cost stops the run", () => {
  const tracker = new SpendTracker(5);
  assert.equal(tracker.canStart(5), true);
  assert.equal(tracker.canStart(5.01), false);
  assert.deepEqual(tracker.charge(1.25, 3), { known: true });
  assert.equal(tracker.spentUsd, 1.25);
  assert.deepEqual(tracker.charge(null, 3), { known: false });
  assert.equal(tracker.spentUsd, 4.25, "an unknown cost is charged at its worst case");
  assert.equal(tracker.canStart(1), false);
});

test("cost after a fallback prices each attempt at its own model; an unpriced model gives null", () => {
  const u = (input: number, output: number) => ({ uncachedInputTokens: input, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: output, reasoningTokens: null });
  const cost = generationCostUsd("claude-fable-5-2", u(0, 0), [
    { model: "claude-fable-5-2", fallback: false, usage: u(1_000_000, 0) },
    { model: "claude-opus-5", fallback: true, usage: u(0, 1_000_000) },
  ]);
  assert.equal(cost, 8 + 25);
  assert.equal(generationCostUsd("claude-fable-5-2", u(0, 0), [{ model: "claude-new-model", fallback: true, usage: u(1, 1) }]), null);
});

test("PDF pages are counted from the fixture files", () => {
  assert.equal(countPdfPages(readFileSync("fixtures/cases/case-a-mateo/vineland-3.pdf")), 2);
  assert.equal(countPdfPages(readFileSync("fixtures/cases/case-a-mateo/basc-3-prq.pdf")), 1);
  assert.equal(countPdfPages(new Uint8Array(120_000)), 3, "unknown structure falls back to one page per 50 KB");
});
