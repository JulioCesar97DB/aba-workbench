/**
 * Phase 0 experiment. For each invented case and each model under test, it asks our
 * own route handler (POST /api/generate) for the Medical Necessity section, exactly as
 * the browser will, and saves the text with its token usage, cost and timings.
 *
 *   pnpm build && pnpm phase0           real runs, for every provider whose key is set
 *   pnpm phase0 --mock                  plumbing check with the mock provider: no key, no cost
 *   pnpm phase0 --only claude-opus-5-5  only these model ids (comma-separated)
 *   pnpm phase0 --case case-a-mateo     only these case ids (comma-separated)
 *   pnpm phase0 --budget 5              never start a call that could take the total past $5
 *   pnpm phase0 --no-prewarm            skip the cache pre-warm request
 *   pnpm phase0 --base-url http://...   use a server that is already running
 *
 * Keys: ANTHROPIC_API_KEY and OPENAI_API_KEY in .env.phase0 (gitignored; the pnpm script
 * loads it). Not in .env.local: Next.js loads that file into the server, and the server
 * must run without keys so that only the per-request key can ever be used. The keys are
 * sent to the route in a header, as the browser will send the user's key, and are never
 * printed or written to disk.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { MAX_REQUEST_BODY_BYTES, requestTooLargeMessage } from "../src/lib/limits.ts";
import { costUsd, generationCostUsd, PRICES_CHECKED_ON } from "../src/lib/pricing.ts";
import type { SourceDocument, TokenUsage, UsageAttempt } from "../src/lib/providers/types.ts";
import { buildPrompt } from "../src/lib/rules.ts";
import {
  countPdfPages,
  inputTokensUpperBound,
  parseArgs,
  SpendTracker,
  UnknownPriceError,
  worstCaseCallUsd,
  type Phase0Args,
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
/** The env files Next.js loads into the server at start. Keys must not be in them. */
const NEXT_ENV_FILES = [".env", ".env.local", ".env.production", ".env.production.local"];
const PORT = 3517;

// ---------- cases ----------

interface CaseFixture {
  id: string;
  label: string;
  sources: SourceDocument[];
  bodyBytes: number;
  pdfBytes: number;
  pdfPages: number;
  /** Characters of everything sent as text: rules, section request and text sources. */
  promptChars: number;
}

function requestBody(m: ModelUnderTest, sources: SourceDocument[], mode: "generate" | "prewarm") {
  return { provider: m.provider, model: m.model, section: SECTION, effort: m.effort, maxOutputTokens: MAX_OUTPUT_TOKENS, mode, sources };
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
    const bodyBytes = Buffer.byteLength(JSON.stringify(requestBody(REAL_MODELS[0], sources, "generate")));
    cases.push({ id: meta.id, label: meta.label, sources, bodyBytes, pdfBytes, pdfPages, promptChars });
  }
  if (only) {
    const missing = only.filter((id) => !cases.some((c) => c.id === id));
    if (missing.length) throw new Error(`Unknown case id: ${missing.join(", ")}.`);
  }
  return cases;
}

// ---------- server ----------

async function keysInNextEnvFiles(): Promise<string[]> {
  const found: string[] = [];
  for (const name of NEXT_ENV_FILES) {
    if (!existsSync(name)) continue;
    const text = await readFile(name, "utf8");
    for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]) {
      if (new RegExp(`^\\s*(export\\s+)?${key}\\s*=\\s*\\S`, "m").test(text)) found.push(`${name}: ${key}`);
    }
  }
  return found;
}

async function startServer(args: Phase0Args, baseUrl: string): Promise<ChildProcess | null> {
  if (args.baseUrl) return null;
  if (!existsSync(".next/BUILD_ID")) throw new Error("No production build found. Run `pnpm build` first.");
  const leaked = await keysInNextEnvFiles();
  if (leaked.length) {
    throw new Error(
      `Next.js would load provider keys into the server (${leaked.join("; ")}). ` +
        "Move them to .env.phase0: the server must run without keys so only the per-request key is used.",
    );
  }
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(PORT) };
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;
  if (args.mock) env.ABA_ENABLE_MOCK_PROVIDER = "1";
  const server = spawn("pnpm", ["exec", "next", "start", "-p", String(PORT)], { env, stdio: ["ignore", "ignore", "inherit"] });
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
  done: { complete: boolean; stopReason: string; servedModel: string; usage: TokenUsage; attempts: UsageAttempt[] | null } | null;
  fallbacks: { from: string; to: string }[];
  refusal: { category: string | null; explanation: string | null } | null;
  error: { code: string; message: string } | null;
  httpStatus: number;
  msToFirstText: number | null;
  msTotal: number;
}

async function callGenerate(baseUrl: string, m: ModelUnderTest, c: CaseFixture, mode: "generate" | "prewarm"): Promise<StreamResult> {
  const started = performance.now();
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-provider-key": m.keyVar ? (process.env[m.keyVar] ?? "") : "mock",
  };
  const result: StreamResult = {
    text: "",
    meta: null,
    done: null,
    fallbacks: [],
    refusal: null,
    error: null,
    httpStatus: 0,
    msToFirstText: null,
    msTotal: 0,
  };
  try {
    const response = await fetch(`${baseUrl}/api/generate`, { method: "POST", headers, body: JSON.stringify(requestBody(m, c.sources, mode)) });
    result.httpStatus = response.status;
    if (!response.ok || !response.body) {
      const body = (await response.json().catch(() => null)) as { error?: { code: string; message: string } } | null;
      result.error = body?.error ?? { code: `http_${response.status}`, message: response.statusText };
      return result;
    }
    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = "";
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
  } catch (error) {
    result.error = { code: "connection", message: error instanceof Error ? error.message : String(error) };
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
  const baseUrl = args.baseUrl ?? `http://127.0.0.1:${PORT}`;
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
  const server = await startServer(args, baseUrl);
  try {
    await mkdir(outDir, { recursive: true });
    // The model-list route, once per provider.
    for (const provider of [...new Set(runnable.map((m) => m.provider))]) {
      const keyVar = runnable.find((m) => m.provider === provider)!.keyVar;
      const res = await fetch(`${baseUrl}/api/models?provider=${provider}`, {
        headers: { "x-provider-key": keyVar ? (process.env[keyVar] ?? "") : "mock" },
      });
      const body = (await res.json()) as { defaultModel?: string; models?: { id: string }[]; error?: { message: string } };
      const ids = body.models?.map((x) => x.id) ?? [];
      console.log(`/api/models ${provider}: HTTP ${res.status}, ${ids.length} models, default ${body.defaultModel ?? "none"}${body.error ? `, error: ${body.error.message}` : ""}`);
      await writeFile(path.join(outDir, `models-${provider}.json`), JSON.stringify({ status: res.status, defaultModel: body.defaultModel ?? null, ids, error: body.error ?? null }, null, 2) + "\n");
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
          warm = await callGenerate(baseUrl, m, c, "prewarm");
          warmCost = warm.done ? costUsd(m.model, warm.done.usage) : null;
          if (m.provider !== "mock" && !tracker.charge(warmCost, worst).known) {
            stopped = `${c.id} / ${m.model}: the pre-warm's cost is unknown (${warm.error?.message ?? "no done event"}); charged its worst case and stopped.`;
          }
        }
        const run: StreamResult | null = stopped ? null : await callGenerate(baseUrl, m, c, "generate");
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
  } finally {
    server?.kill();
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
