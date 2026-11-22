/**
 * Phase 0 experiment. For each invented case and each model under test, it asks our
 * own route handler (POST /api/generate) for the Medical Necessity section, exactly as
 * the browser will, and saves the text with its token usage, cost and timings.
 *
 *   pnpm build && pnpm phase0           real runs, for every provider whose key is set
 *   pnpm phase0 --mock                  plumbing check with the mock provider: no key, no cost
 *   pnpm phase0 --only=claude-opus-5-5  only the listed model ids (comma-separated)
 *   pnpm phase0 --case=case-a-mateo     only the listed case ids (comma-separated)
 *   pnpm phase0 --budget=5              do not start a call that could take the total past $5
 *   pnpm phase0 --no-prewarm            skip the cache pre-warm request
 *   pnpm phase0 --base-url=http://...   use a server that is already running
 *
 * Keys come from ANTHROPIC_API_KEY and OPENAI_API_KEY (the pnpm script loads .env.local).
 * They are sent to the route in a header, as the browser will send the user's key, and
 * never printed or written to disk.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { MAX_REQUEST_BODY_BYTES, requestTooLargeMessage } from "../src/lib/limits.ts";
import { costUsd, generationCostUsd, PRICES, PRICES_CHECKED_ON } from "../src/lib/pricing.ts";
import type { SourceDocument, TokenUsage, UsageAttempt } from "../src/lib/providers/types.ts";

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
/** Typical output per call, used only to decide whether a call fits the remaining budget. */
const BUDGET_OUTPUT_TOKENS_GUESS = 12_000;

// ---------- arguments ----------

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, "").split("=");
    return [key, value ?? "true"] as const;
  }),
);
const mock = args.has("mock");
const only = args.get("only")?.split(",");
const onlyCases = args.get("case")?.split(",");
const budgetUsd = Number(args.get("budget") ?? 5);
const prewarm = !args.has("no-prewarm");
const outDir = path.resolve(mock ? "tmp/phase0-mock" : "docs/phase0/outputs");
const port = 3517;
const baseUrl = args.get("base-url") ?? `http://127.0.0.1:${port}`;

// ---------- cases ----------

interface CaseFixture {
  id: string;
  label: string;
  sources: SourceDocument[];
  bodyBytes: number;
  pdfBytes: number;
}

async function loadCases(): Promise<CaseFixture[]> {
  const root = path.resolve("fixtures/cases");
  const cases: CaseFixture[] = [];
  for (const dir of (await readdir(root)).sort()) {
    if (onlyCases && !onlyCases.includes(dir)) continue;
    const meta = JSON.parse(await readFile(path.join(root, dir, "case.json"), "utf8"));
    const sources: SourceDocument[] = [];
    let pdfBytes = 0;
    for (const s of meta.sources) {
      const file = path.join(root, dir, s.file);
      if (s.file.endsWith(".pdf")) {
        const data = await readFile(file);
        pdfBytes += data.length;
        sources.push({ id: s.id, title: s.title, kind: "pdf", filename: path.basename(s.file), base64: data.toString("base64") });
      } else {
        sources.push({ id: s.id, title: s.title, kind: "text", text: await readFile(file, "utf8") });
      }
    }
    const bodyBytes = Buffer.byteLength(JSON.stringify(requestBody(REAL_MODELS[0], sources, "generate")));
    cases.push({ id: meta.id, label: meta.label, sources, bodyBytes, pdfBytes });
  }
  return cases;
}

function requestBody(m: ModelUnderTest, sources: SourceDocument[], mode: "generate" | "prewarm") {
  return { provider: m.provider, model: m.model, section: SECTION, effort: m.effort, maxOutputTokens: MAX_OUTPUT_TOKENS, mode, sources };
}

// ---------- server ----------

async function startServer(): Promise<ChildProcess | null> {
  if (args.has("base-url")) return null;
  if (!existsSync(".next/BUILD_ID")) throw new Error("No production build found. Run `pnpm build` first.");
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port) };
  // The server never needs the provider keys: they travel with each request.
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;
  if (mock) env.ABA_ENABLE_MOCK_PROVIDER = "1";
  const server = spawn("pnpm", ["exec", "next", "start", "-p", String(port)], { env, stdio: ["ignore", "ignore", "inherit"] });
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(baseUrl)).ok) return server;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  server.kill();
  throw new Error("The Next.js server did not start within 60 seconds.");
}

// ---------- calling the route ----------

interface StreamResult {
  text: string;
  meta: Record<string, unknown> | null;
  done: { stopReason: string; servedModel: string; usage: TokenUsage; attempts: UsageAttempt[] | null } | null;
  fallbacks: { from: string; to: string }[];
  refusal: { category: string | null; explanation: string | null } | null;
  error: { code: string; message: string } | null;
  httpStatus: number;
  msToFirstText: number | null;
  msTotal: number;
}

async function callGenerate(m: ModelUnderTest, c: CaseFixture, mode: "generate" | "prewarm"): Promise<StreamResult> {
  const started = performance.now();
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (m.keyVar) headers["x-provider-key"] = process.env[m.keyVar] ?? "";
  else headers["x-provider-key"] = "mock";
  const response = await fetch(`${baseUrl}/api/generate`, { method: "POST", headers, body: JSON.stringify(requestBody(m, c.sources, mode)) });
  const result: StreamResult = {
    text: "",
    meta: null,
    done: null,
    fallbacks: [],
    refusal: null,
    error: null,
    httpStatus: response.status,
    msToFirstText: null,
    msTotal: 0,
  };

  if (!response.ok || !response.body) {
    const body = (await response.json().catch(() => null)) as { error?: { code: string; message: string } } | null;
    result.error = body?.error ?? { code: `http_${response.status}`, message: response.statusText };
    result.msTotal = performance.now() - started;
    return result;
  }

  const decoder = new TextDecoder();
  let buffer = "";
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let event = "message";
      let data = "";
      for (const line of raw.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("data: ")) data += line.slice(6);
      }
      if (!data) continue; // keep-alive comment
      const payload = JSON.parse(data);
      if (event === "text") {
        result.msToFirstText ??= performance.now() - started;
        result.text += payload.delta;
      } else if (event === "meta") result.meta = payload;
      else if (event === "done") result.done = payload;
      else if (event === "refusal") result.refusal = payload;
      else if (event === "fallback") result.fallbacks.push(payload);
      else if (event === "error") result.error = payload;
    }
  }
  result.msTotal = performance.now() - started;
  return result;
}

// ---------- budget ----------

function estimateCallCost(m: ModelUnderTest, c: CaseFixture): number {
  const price = PRICES[m.model];
  if (!price) return 0;
  // Rough upper estimate: about 4 characters per text token, about 3,000 tokens per PDF page
  // (2 pages per report), everything written to cache, plus a typical output.
  const textChars = c.sources.reduce((n, s) => n + (s.kind === "text" ? s.text.length : 0), 0) + 40_000;
  const pdfTokens = c.sources.filter((s) => s.kind === "pdf").length * 2 * 3_000;
  const inputTokens = textChars / 4 + pdfTokens;
  return (inputTokens * price.cacheWrite + BUDGET_OUTPUT_TOKENS_GUESS * price.output) / 1_000_000;
}

// ---------- main ----------

function fmtUsd(n: number | null) {
  return n === null ? "n/a" : `$${n.toFixed(4)}`;
}

async function main() {
  const cases = await loadCases();
  for (const c of cases) {
    const mb = (c.bodyBytes / 1_000_000).toFixed(3);
    console.log(`${c.id}: request body ${mb} MB (PDFs ${(c.pdfBytes / 1_000_000).toFixed(3)} MB raw)`);
    const tooLarge = requestTooLargeMessage(c.bodyBytes);
    if (tooLarge) throw new Error(`${c.id}: ${tooLarge} (limit ${MAX_REQUEST_BODY_BYTES} bytes)`);
  }

  const models = (mock ? MOCK_MODELS : REAL_MODELS).filter((m) => !only || only.includes(m.model));
  const missingKeys = [...new Set(models.filter((m) => m.keyVar && !process.env[m.keyVar]).map((m) => m.keyVar!))];
  for (const key of missingKeys) console.log(`${key} is not set: its models are skipped. Put it in .env.local.`);
  const runnable = models.filter((m) => !m.keyVar || process.env[m.keyVar]);
  if (runnable.length === 0) {
    console.log("Nothing to run. Use --mock to check the plumbing without keys.");
    return;
  }

  const server = await startServer();
  const records: Record<string, unknown>[] = [];
  let spent = 0;
  try {
    // The model-list route, once per provider.
    for (const provider of [...new Set(runnable.map((m) => m.provider))]) {
      const keyVar = runnable.find((m) => m.provider === provider)!.keyVar;
      const res = await fetch(`${baseUrl}/api/models?provider=${provider}`, {
        headers: { "x-provider-key": keyVar ? (process.env[keyVar] ?? "") : "mock" },
      });
      const body = (await res.json()) as { defaultModel?: string; models?: { id: string }[]; error?: { message: string } };
      const ids = body.models?.map((x) => x.id) ?? [];
      console.log(`/api/models ${provider}: HTTP ${res.status}, ${ids.length} models, default ${body.defaultModel ?? "none"}${body.error ? `, error: ${body.error.message}` : ""}`);
      await mkdir(outDir, { recursive: true });
      await writeFile(path.join(outDir, `models-${provider}.json`), JSON.stringify({ status: res.status, defaultModel: body.defaultModel ?? null, ids, error: body.error ?? null }, null, 2) + "\n");
    }

    for (const c of cases) {
      for (const m of runnable) {
        const estimate = estimateCallCost(m, c);
        if (spent + estimate > budgetUsd) {
          console.log(`${c.id} / ${m.model}: skipped, the estimated $${estimate.toFixed(2)} would pass the $${budgetUsd} budget (spent $${spent.toFixed(2)}).`);
          records.push({ case: c.id, model: m.model, skipped: "budget" });
          continue;
        }

        let warm: StreamResult | null = null;
        if (prewarm) {
          warm = await callGenerate(m, c, "prewarm");
          if (warm.error) console.log(`${c.id} / ${m.model}: pre-warm failed: ${warm.error.message}`);
        }
        const run = await callGenerate(m, c, "generate");
        const warmCost = warm?.done ? costUsd(m.model, warm.done.usage) : null;
        const runCost = run.done ? generationCostUsd(m.model, run.done.usage, run.done.attempts) : null;
        spent += (warmCost ?? 0) + (runCost ?? 0);

        const words = run.text.trim() ? run.text.trim().split(/\s+/).length : 0;
        const record = {
          case: c.id,
          provider: m.provider,
          model: m.model,
          servedModel: run.done?.servedModel ?? null,
          fallbackUsed: run.fallbacks.length > 0 || (run.done?.attempts?.some((a) => a.fallback) ?? false),
          fallbacks: run.fallbacks,
          attempts: run.done?.attempts ?? null,
          effort: m.effort,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          rulesVersions: run.meta?.rulesVersions ?? null,
          requestBodyBytes: c.bodyBytes,
          prewarm: warm ? { usage: warm.done?.usage ?? null, costUsd: warmCost, msTotal: Math.round(warm.msTotal), error: warm.error } : null,
          stopReason: run.done?.stopReason ?? null,
          refusal: run.refusal,
          error: run.error,
          usage: run.done?.usage ?? null,
          costUsd: runCost,
          totalCostUsd: (warmCost ?? 0) + (runCost ?? 0),
          msToFirstText: run.msToFirstText === null ? null : Math.round(run.msToFirstText),
          msTotal: Math.round(run.msTotal),
          words,
          missingMarkers: (run.text.match(/\[MISSING:/g) ?? []).length,
          checkMarkers: (run.text.match(/\[CHECK:/g) ?? []).length,
          pricesCheckedOn: PRICES_CHECKED_ON,
          generatedAt: new Date().toISOString(),
        };
        records.push(record);

        const caseDir = path.join(outDir, c.id);
        await mkdir(caseDir, { recursive: true });
        await writeFile(path.join(caseDir, `${m.model}.json`), JSON.stringify(record, null, 2) + "\n");
        // A refused generation keeps no text: a partial answer must not look like a draft.
        const body = run.refusal ? "" : run.text.trim();
        await writeFile(
          path.join(caseDir, `${m.model}.md`),
          `<!-- ${c.label} | Medical Necessity | requested ${m.model} (effort ${m.effort}) | written by ${record.servedModel ?? "none"} | invented case -->\n\n${body || "(no text: see the .json file for the stop reason or error)"}\n`,
        );
        console.log(
          `${c.id} / ${m.model}: ${run.error ? `ERROR ${run.error.message}` : run.done?.stopReason}, ${words} words, ` +
            `${(run.msTotal / 1000).toFixed(1)} s, ${fmtUsd(record.totalCostUsd)} (total so far $${spent.toFixed(2)})`,
        );
      }
    }
  } finally {
    server?.kill();
  }

  await writeFile(path.join(outDir, "runs.json"), JSON.stringify({ budgetUsd, spentUsd: spent, runs: records }, null, 2) + "\n");
  console.log(`Done. Spent $${spent.toFixed(4)}. Outputs in ${path.relative(process.cwd(), outDir)}.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
