/**
 * Phase 0 experiment. For each invented case and each model under test, it asks the
 * provider layer for the Medical Necessity section, through the same code the desktop
 * app's main process uses (src/lib/generate.ts), and saves the text with its token
 * usage, cost and timings. No server and no window are involved.
 *
 *   pnpm phase0                         real runs, for every provider whose key is set
 *   pnpm phase0 --mock                  plumbing check with the mock provider: no key, no cost
 *   pnpm phase0 --only claude-opus-5-5  only these model ids (comma-separated)
 *   pnpm phase0 --case case-a-mateo     only these case ids (comma-separated)
 *   pnpm phase0 --budget 5              never start a call that could take the total past $5
 *   pnpm phase0 --no-prewarm            skip the cache pre-warm request
 *
 * Keys: ANTHROPIC_API_KEY and OPENAI_API_KEY in .env.phase0 (gitignored; the pnpm script
 * loads it into this process only). Each key is passed to its provider and is never
 * printed or written to disk.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runGeneration } from "../src/lib/generate.ts";
import { MAX_REQUEST_BODY_BYTES, requestTooLargeMessage } from "../src/lib/limits.ts";
import { costUsd, generationCostUsd, PRICES_CHECKED_ON } from "../src/lib/pricing.ts";
import { getProvider, rankModels, toSafeError } from "../src/lib/providers/index.ts";
import { mockProvider } from "../src/lib/providers/mock.ts";
import type { Provider, SourceDocument, TokenUsage, UsageAttempt } from "../src/lib/providers/types.ts";
import { buildPrompt } from "../src/lib/rules.ts";
import {
  countPdfPages,
  inputTokensUpperBound,
  parseArgs,
  SpendTracker,
  UnknownPriceError,
  worstCaseCallUsd,
} from "./budget.mts";

// ---------- what is under test ----------

interface ModelUnderTest {
  provider: "anthropic" | "openai" | "mock";
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  keyVar: string | null;
}

// Effort: each provider's own recommendation for quality-sensitive writing.
// Anthropic: high for intelligence-sensitive work (Opus 5.5 defaults to medium, so it is set).
// OpenAI: medium is their documented starting point for GPT-6.2.
const REAL_MODELS: ModelUnderTest[] = [
  { provider: "anthropic", model: "claude-opus-5-5", effort: "high", keyVar: "ANTHROPIC_API_KEY" },
  { provider: "anthropic", model: "claude-fable-5-2", effort: "high", keyVar: "ANTHROPIC_API_KEY" },
  { provider: "openai", model: "gpt-6.2-sol", effort: "medium", keyVar: "OPENAI_API_KEY" },
  { provider: "openai", model: "gpt-6.2-astra", effort: "medium", keyVar: "OPENAI_API_KEY" },
];
const MOCK_MODELS: ModelUnderTest[] = [{ provider: "mock", model: "mock-echo", effort: "high", keyVar: null }];

const SECTION = "medical-necessity";
const MAX_OUTPUT_TOKENS = 32_000;

// ---------- cases ----------

interface CaseFixture {
  id: string;
  label: string;
  sources: SourceDocument[];
  /** The size the request would have as the Phase 0 HTTP body; the 4.5 MB cap applies to it. */
  bodyBytes: number;
  pdfBytes: number;
  pdfPages: number;
  /** Characters of everything sent as text: rules, section request and text sources. */
  promptChars: number;
}

async function loadCases(only: string[] | null): Promise<CaseFixture[]> {
  const root = path.resolve("fixtures/cases");
  const cases: CaseFixture[] = [];
  for (const dir of (await readdir(root)).sort()) {
    if (only && !only.includes(dir)) continue;
    const meta = JSON.parse(await readFile(path.join(root, dir, "case.json"), "utf8"));
    const sources: SourceDocument[] = [];
    let pdfBytes = 0;
    let pdfPages = 0;
    for (const s of meta.sources) {
      const file = path.join(root, dir, s.file);
      if (s.file.endsWith(".pdf")) {
        const data = await readFile(file);
        pdfBytes += data.length;
        pdfPages += countPdfPages(data);
        sources.push({ id: s.id, title: s.title, kind: "pdf", filename: path.basename(s.file), base64: data.toString("base64") });
      } else {
        sources.push({ id: s.id, title: s.title, kind: "text", text: await readFile(file, "utf8") });
      }
    }
    const { prompt } = await buildPrompt(SECTION, sources);
    const promptChars =
      prompt.system.length + prompt.task.length + sources.reduce((n, s) => n + (s.kind === "text" ? s.text.length + s.title.length + 60 : 200), 0);
    const body = { provider: REAL_MODELS[0].provider, model: REAL_MODELS[0].model, section: SECTION, effort: REAL_MODELS[0].effort, maxOutputTokens: MAX_OUTPUT_TOKENS, mode: "generate", sources };
    const bodyBytes = Buffer.byteLength(JSON.stringify(body));
    cases.push({ id: meta.id, label: meta.label, sources, bodyBytes, pdfBytes, pdfPages, promptChars });
  }
  if (only) {
    const missing = only.filter((id) => !cases.some((c) => c.id === id));
    if (missing.length) throw new Error(`Unknown case id: ${missing.join(", ")}.`);
  }
  return cases;
}

// ---------- calling the provider layer ----------

/** Never aborted: a run ends when the provider finishes. Ctrl-C ends the process and its calls. */
const NO_CANCEL = new AbortController().signal;

function providerFor(m: ModelUnderTest): Provider {
  const provider = m.provider === "mock" ? mockProvider : getProvider(m.provider);
  if (!provider) throw new Error(`Unknown provider ${m.provider}.`);
  return provider;
}

function apiKeyFor(m: ModelUnderTest): string {
  return m.keyVar ? (process.env[m.keyVar] ?? "") : "";
}

interface StreamResult {
  text: string;
  meta: { rulesVersions: Record<string, string> } | null;
  done: { complete: boolean; stopReason: string; servedModel: string; usage: TokenUsage; attempts: UsageAttempt[] | null } | null;
  fallbacks: { from: string; to: string }[];
  refusal: { category: string | null; explanation: string | null } | null;
  error: { code: string; message: string } | null;
  msToFirstText: number | null;
  msTotal: number;
}

async function callGenerate(m: ModelUnderTest, c: CaseFixture, mode: "generate" | "prewarm"): Promise<StreamResult> {
  const started = performance.now();
  const result: StreamResult = {
    text: "",
    meta: null,
    done: null,
    fallbacks: [],
    refusal: null,
    error: null,
    msToFirstText: null,
    msTotal: 0,
  };
  const events = runGeneration({
    provider: providerFor(m),
    apiKey: apiKeyFor(m),
    model: m.model,
    section: SECTION,
    effort: m.effort,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    mode,
    sources: c.sources,
    signal: NO_CANCEL,
  });
  try {
    for await (const event of events) {
      if (event.type === "text") {
        result.msToFirstText ??= performance.now() - started;
        result.text += event.delta;
      } else if (event.type === "meta") result.meta = { rulesVersions: event.rulesVersions };
      else if (event.type === "done") result.done = event;
      else if (event.type === "refusal") result.refusal = { category: event.category, explanation: event.explanation };
      else if (event.type === "fallback") result.fallbacks.push({ from: event.from, to: event.to });
      else if (event.type === "error") result.error = { code: event.code, message: event.message };
    }
  } finally {
    result.msTotal = performance.now() - started;
  }
  return result;
}

type RunStatus = "complete" | "incomplete" | "refused" | "error";

function statusOf(run: StreamResult): { status: RunStatus; reason: string } {
  if (run.refusal) return { status: "refused", reason: `refusal${run.refusal.category ? ` (${run.refusal.category})` : ""}` };
  if (run.error) return { status: "error", reason: `${run.error.code}: ${run.error.message}` };
  if (!run.done) return { status: "error", reason: "the stream ended without a done event" };
  if (!run.done.complete) return { status: "incomplete", reason: `stopped with ${run.done.stopReason}` };
  return { status: "complete", reason: run.done.stopReason };
}

// ---------- main ----------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(args.mock ? "tmp/phase0-mock" : "docs/phase0/outputs");

  const cases = await loadCases(args.cases);
  for (const c of cases) {
    console.log(`${c.id}: request body ${(c.bodyBytes / 1_000_000).toFixed(3)} MB (PDFs ${(c.pdfBytes / 1_000_000).toFixed(3)} MB raw, ${c.pdfPages} pages)`);
    const tooLarge = requestTooLargeMessage(c.bodyBytes);
    if (tooLarge) throw new Error(`${c.id}: ${tooLarge} (limit ${MAX_REQUEST_BODY_BYTES} bytes)`);
  }

  const pool = args.mock ? MOCK_MODELS : REAL_MODELS;
  if (args.only) {
    const unknown = args.only.filter((id) => !pool.some((m) => m.model === id));
    if (unknown.length) throw new Error(`Unknown model id for this mode: ${unknown.join(", ")}.`);
  }
  const models = pool.filter((m) => !args.only || args.only.includes(m.model));
  const missingKeys = [...new Set(models.filter((m) => m.keyVar && !process.env[m.keyVar]).map((m) => m.keyVar!))];
  for (const key of missingKeys) console.log(`${key} is not set: its models are skipped. Put it in .env.phase0.`);
  const runnable = models.filter((m) => !m.keyVar || process.env[m.keyVar]);
  if (runnable.length === 0) {
    console.log("Nothing to run. Use --mock to check the plumbing without keys.");
    return;
  }

  const tracker = new SpendTracker(args.budgetUsd);
  const records: Record<string, unknown>[] = [];
  let stopped: string | null = null;
  await mkdir(outDir, { recursive: true });
  // The provider's model list, once per provider, ranked as the app ranks it.
  for (const m of runnable.filter((m, i) => runnable.findIndex((other) => other.provider === m.provider) === i)) {
    let ids: string[] = [];
    let error: { code: string; message: string } | null = null;
    try {
      ids = rankModels(m.provider, await providerFor(m).listModels(apiKeyFor(m), NO_CANCEL)).map((x) => x.id);
    } catch (e) {
      const safe = toSafeError(e);
      error = { code: safe.code, message: safe.message };
    }
    const defaultModel = ids[0] ?? null;
    console.log(`models ${m.provider}: ${ids.length} models, default ${defaultModel ?? "none"}${error ? `, error: ${error.message}` : ""}`);
    await writeFile(path.join(outDir, `models-${m.provider}.json`), JSON.stringify({ defaultModel, ids, error }, null, 2) + "\n");
  }

  outer: for (const c of cases) {
    for (const m of runnable) {
      const inputTokens = inputTokensUpperBound(c.promptChars, c.pdfPages);
      const worst = worstCaseCallUsd({ provider: m.provider, model: m.model, inputTokens, maxOutputTokens: MAX_OUTPUT_TOKENS, prewarm: args.prewarm });
      if (!tracker.canStart(worst)) {
        console.log(`${c.id} / ${m.model}: skipped; its worst case $${worst.toFixed(2)} could take the total past $${args.budgetUsd} (spent $${tracker.spentUsd.toFixed(2)}).`);
        records.push({ case: c.id, model: m.model, skipped: "budget", worstCaseUsd: worst });
        continue;
      }

      let warm: StreamResult | null = null;
      let warmCost: number | null = null;
      if (args.prewarm) {
        warm = await callGenerate(m, c, "prewarm");
        warmCost = warm.done ? costUsd(m.model, warm.done.usage) : null;
        if (m.provider !== "mock" && !tracker.charge(warmCost, worst).known) {
          stopped = `${c.id} / ${m.model}: the pre-warm's cost is unknown (${warm.error?.message ?? "no done event"}); charged its worst case and stopped.`;
        }
      }
      const run: StreamResult | null = stopped ? null : await callGenerate(m, c, "generate");
      const runCost = run?.done ? generationCostUsd(m.model, run.done.usage, run.done.attempts) : null;
      if (run && m.provider !== "mock" && !tracker.charge(runCost, worst).known) {
        stopped = `${c.id} / ${m.model}: the generation's cost is unknown (${run.error?.message ?? (run.done ? "a model without a price answered" : "no done event")}); charged its worst case and stopped.`;
      }

      const outcome = run ? statusOf(run) : { status: "error" as RunStatus, reason: "not run after the pre-warm failed" };
      const record = {
        case: c.id,
        provider: m.provider,
        model: m.model,
        servedModel: run?.done?.servedModel ?? null,
        status: outcome.status,
        statusReason: outcome.reason,
        fallbackUsed: (run?.fallbacks.length ?? 0) > 0 || (run?.done?.attempts?.some((a) => a.fallback) ?? false),
        fallbacks: run?.fallbacks ?? [],
        attempts: run?.done?.attempts ?? null,
        effort: m.effort,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        rulesVersions: run?.meta?.rulesVersions ?? null,
        requestBodyBytes: c.bodyBytes,
        worstCaseUsd: worst,
        prewarm: warm ? { usage: warm.done?.usage ?? null, costUsd: warmCost, msTotal: Math.round(warm.msTotal), error: warm.error } : null,
        stopReason: run?.done?.stopReason ?? null,
        refusal: run?.refusal ?? null,
        error: run?.error ?? null,
        usage: run?.done?.usage ?? null,
        costUsd: runCost,
        totalCostUsd: (warmCost ?? 0) + (runCost ?? 0),
        msToFirstText: run?.msToFirstText == null ? null : Math.round(run.msToFirstText),
        msTotal: run ? Math.round(run.msTotal) : null,
        words: run?.text.trim() ? run.text.trim().split(/\s+/).length : 0,
        missingMarkers: (run?.text.match(/\[MISSING:/g) ?? []).length,
        checkMarkers: (run?.text.match(/\[CHECK:/g) ?? []).length,
        pricesCheckedOn: PRICES_CHECKED_ON,
        generatedAt: new Date().toISOString(),
      };
      records.push(record);

      const caseDir = path.join(outDir, c.id);
      await mkdir(caseDir, { recursive: true });
      await writeFile(path.join(caseDir, `${m.model}.json`), JSON.stringify(record, null, 2) + "\n");
      const header = `<!-- ${c.label} | Medical Necessity | requested ${m.model} (effort ${m.effort}) | written by ${record.servedModel ?? "none"} | invented case -->`;
      if (outcome.status === "complete") {
        await writeFile(path.join(caseDir, `${m.model}.md`), `${header}\n\n${run!.text.trim()}\n`);
      } else {
        // Only a complete answer may look like a draft. A refusal's text is discarded
        // (provider contract); other partial text is kept apart for diagnosis.
        await writeFile(path.join(caseDir, `${m.model}.md`), `${header}\n\nINCOMPLETE (${outcome.status}): ${outcome.reason}. This is not a usable section.\n`);
        if (outcome.status !== "refused" && run?.text.trim()) {
          await writeFile(path.join(caseDir, `${m.model}.partial.md`), `${header}\n\nPARTIAL TEXT, NOT A DRAFT (${outcome.reason})\n\n${run.text.trim()}\n`);
        }
      }
      console.log(
        `${c.id} / ${m.model}: ${outcome.status} (${outcome.reason}), ${record.words} words, ` +
          `${((record.msTotal ?? 0) / 1000).toFixed(1)} s, $${record.totalCostUsd.toFixed(4)} (spent so far $${tracker.spentUsd.toFixed(2)})`,
      );
      if (stopped) break outer;
    }
  }

  await writeFile(
    path.join(outDir, "runs.json"),
    JSON.stringify({ budgetUsd: args.budgetUsd, spentUsd: tracker.spentUsd, stopped, runs: records }, null, 2) + "\n",
  );
  if (stopped) throw new Error(`Stopped: ${stopped}`);
  console.log(`Done. Spent $${tracker.spentUsd.toFixed(4)}. Outputs in ${path.relative(process.cwd(), outDir)}.`);
}

main().catch((error) => {
  const message = error instanceof UnknownPriceError || error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
