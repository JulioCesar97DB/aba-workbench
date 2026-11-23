/*
 * pnpm eval: the evaluation set, run through the real app (docs/evaluation.md).
 *
 * For each invented case with a key (fixtures/cases/<case>/key.json) it starts the built
 * app hidden (--hidden: no window shown, no Dock icon, never the focus), loads the case
 * through window.aba as she would, drafts the nine narrative sections in report order,
 * runs the automatic checks, asks the judge to score each section, writes results.json
 * and summary.md to eval-results/<run>/, and compares them with the last accepted run
 * (eval/baselines/<name>/).
 *
 * Every request goes the way hers do: window.aba (the preload) → the main process's
 * section service → prepareOutgoingRequest → the provider. Nothing here talks to a
 * provider, and nothing reads the app's credentials file.
 *
 *   pnpm eval                           a real run on the ChatGPT sign-in of the eval profile
 *   pnpm eval --sign-in                 first time: sign in to ChatGPT in the browser (once)
 *   pnpm eval --rehearse                the whole run with a fake provider: no request leaves the computer
 *   pnpm eval --draft-app <checkout>    draft with another checkout's app (its rules and code); judge with this one
 *   pnpm eval --cases case-b-sofia      only these cases (comma-separated)
 *   pnpm eval --mode independent        draft without approving (default: chained, each draft approved before the next)
 *   pnpm eval --baseline <name>         compare with eval/baselines/<name>/ (default: the newest)
 *   pnpm eval --accept <name>           also save this run as eval/baselines/<name>/
 *   pnpm eval --label <text>            names the run's folder
 *   pnpm eval --no-build                use the apps as they are built (default: pnpm build in each checkout first)
 *   pnpm eval --from-run <run folder>   take that run's drafts: check them again, and ask the judge only where it has no answer
 */
import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { JUDGE_PROMPT_VERSION, parseJudgeAnswer, type JudgeFormat, type JudgeInput } from "../src/lib/judge.ts";
import type { AbaApi, GenerationUpdateEvent } from "../src/shared/api.ts";
import { REPORT_SECTIONS, type ReportSectionId } from "../src/shared/report-sections.ts";
import { countWords, findMarkers, splitParagraphs } from "../src/shared/section-text.ts";
import { extractExamples, numberIndex, runChecks } from "./checks/checks.ts";
import { loadCase, type LoadedCase } from "./key.ts";
import { compareRuns, RESULTS_VERSION, scoreSection, summaryMarkdown, type CaseResult, type JudgeRecord, type LaunchCheck, type RunResult, type SectionResult, type Usage } from "./results.ts";
import { NUMBERED_LISTS_ALLOWED, RUBRIC, RUBRIC_VERSION, SECTION_EXPECTATIONS, SECTION_SHAPES, STYLE_EXPECTATIONS } from "./rubric.ts";
import { installRehearsalProvider, REHEARSAL_CLAUDE_KEY } from "./rehearsal.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const CASES_DIR = path.join(ROOT, "fixtures", "cases");
const RESULTS_DIR = path.join(ROOT, "eval-results");
const BASELINES_DIR = path.join(ROOT, "eval", "baselines");
/** The owner's choice (2026-11-23): one throwaway profile, kept signed in, outside the repository, ~/ABA Workbench and Documents. */
const EVAL_PROFILE = path.join(homedir(), ".aba-workbench-eval", "profile");
/** How long one request may take before the run gives up on it. */
const REQUEST_TIMEOUT_MS = 6 * 60_000;
/**
 * Errors on the provider's side that a second try may get past (an overloaded server, a
 * dropped connection, no answer in time). A failed request saves nothing, so it is sent
 * once more after a pause; anything else is not retried.
 */
const TRANSIENT = /server_is_overloaded|provider_unavailable|chatgpt_unavailable|timeout|connection_failed|overloaded/;
const RETRY_PAUSE_MS = 30_000;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const { values: args } = parseArgs({
  options: {
    "sign-in": { type: "boolean", default: false },
    rehearse: { type: "boolean", default: false },
    "draft-app": { type: "string" },
    cases: { type: "string" },
    mode: { type: "string", default: "chained" },
    baseline: { type: "string" },
    accept: { type: "string" },
    label: { type: "string" },
    "no-build": { type: "boolean", default: false },
    "from-run": { type: "string" },
  },
});

function fail(message: string): never {
  console.error(`pnpm eval: ${message}`);
  process.exit(1);
}

if (args.mode !== "chained" && args.mode !== "independent") fail('--mode is "chained" or "independent".');
const mode = args.mode as "chained" | "independent";
const rehearse = args.rehearse === true;
const provider = rehearse ? ("anthropic" as const) : ("openai" as const);
const judgeCheckout = ROOT;
/** --from-run: an earlier run whose drafts are checked again and judged where the judge had no answer. */
const fromRun: RunResult | null = args["from-run"] ? (JSON.parse(readFileSync(path.join(path.resolve(args["from-run"]), "results.json"), "utf8")) as RunResult) : null;
if (fromRun && args["draft-app"]) fail("--from-run drafts nothing, so it takes no --draft-app.");
if (fromRun && rehearse !== fromRun.provider.startsWith("rehearsal")) fail("--from-run takes a run of the same kind (real or rehearsal).");
const draftCheckout = args["draft-app"] ? path.resolve(args["draft-app"]) : ROOT;
if (!existsSync(path.join(draftCheckout, "package.json"))) fail(`--draft-app ${draftCheckout} is not a checkout of the app.`);
if (args.accept !== undefined && !/^[a-z0-9][a-z0-9._-]{0,60}$/i.test(args.accept)) fail("--accept takes a short name (letters, digits, dot, dash, underscore).");
if (args.accept !== undefined && args.rehearse) fail("a rehearsal is never accepted as a baseline (eval/baselines/README.md).");

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const label = `${stamp}${args.label ? `-${args.label.replace(/[^a-z0-9._-]+/gi, "-").slice(0, 40)}` : ""}${rehearse ? "-rehearsal" : ""}`;
const runDir = path.join(RESULTS_DIR, label);

/* ---------------------------------------------------------------------------------- */
/* The cases                                                                           */

function selectedCases(): LoadedCase[] {
  const all = readdirSync(CASES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(CASES_DIR, entry.name, "key.json")))
    .map((entry) => entry.name)
    .sort();
  // --from-run takes that run's cases unless --cases names some.
  const wanted = args.cases ? args.cases.split(",").map((name) => name.trim()) : fromRun ? fromRun.cases.map((c) => c.caseId) : all;
  for (const name of wanted) if (!all.includes(name)) fail(`no case ${name} with a key in fixtures/cases (cases: ${all.join(", ")}).`);
  return wanted.map((name) => loadCase(path.join(CASES_DIR, name)));
}

interface LoadPlan {
  id: string;
  type: string;
  title: string;
  date?: string;
  file: string;
  /** What the number check reads for it: the Markdown, or a score report's HTML without its tags. */
  text: string;
}

/** A key's date ("07/30/2026") as the app's date field stores it ("2026-07-30"). */
function isoDate(date: string | undefined): string | undefined {
  if (date === undefined) return undefined;
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(date);
  if (!match) fail(`a key date must be MM/DD/YYYY: ${date}`);
  return `${match[3]}-${match[1]}-${match[2]}`;
}

function sourcePlan(loaded: LoadedCase): LoadPlan[] {
  const textOf = (file: string) => {
    const raw = readFileSync(path.join(loaded.folder, file), "utf8");
    return file.endsWith(".html") ? raw.replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ") : raw;
  };
  const fromCase = loaded.caseFile.sources.map((source) => {
    const load = loaded.key.sources.find((entry) => entry.id === source.id)!;
    const shown = load.textOf ?? source.file;
    return { id: source.id, type: load.type, title: source.title, date: isoDate(load.date), file: source.file, text: shown.endsWith(".pdf") ? "" : textOf(shown) };
  });
  const extra = loaded.key.extraSources.map((source) => ({ id: source.id, type: source.type, title: source.title, date: isoDate(source.date), file: source.file, text: textOf(source.file) }));
  return [...fromCase, ...extra];
}

/* ---------------------------------------------------------------------------------- */
/* The apps                                                                            */

function git(checkout: string, ...gitArgs: string[]): string {
  try {
    return execFileSync("git", ["-C", checkout, ...gitArgs], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function build(checkout: string): void {
  if (args["no-build"]) {
    if (!existsSync(path.join(checkout, "out", "main", "index.js"))) fail(`${checkout} is not built; run without --no-build.`);
    return;
  }
  console.log(`Building ${checkout} ...`);
  execFileSync("pnpm", ["build"], { cwd: checkout, stdio: ["ignore", "ignore", "inherit"] });
}

/** Owner-only folders: the profile holds the ChatGPT sign-in. */
function ownerOnlyFolder(folder: string): void {
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  chmodSync(folder, 0o700);
}

const launches: LaunchCheck[] = [];

/** Visible windows, the Dock icon and focused windows, as the app's main process sees them. */
async function windowState(app: ElectronApplication, role: LaunchCheck["role"], at: LaunchCheck["at"]): Promise<LaunchCheck> {
  const state = await app.evaluate(({ app: electronApp, BrowserWindow }) => ({
    visibleWindows: BrowserWindow.getAllWindows().filter((window) => window.isVisible()).length,
    focusedWindows: BrowserWindow.getAllWindows().filter((window) => window.isFocused()).length,
    dockVisible: electronApp.dock ? electronApp.dock.isVisible() : null,
  }));
  const check = { role, at, ...state };
  launches.push(check);
  return check;
}

async function launch(checkout: string, role: LaunchCheck["role"], profile: string, home: string): Promise<{ app: ElectronApplication; page: Page }> {
  // Never point the window at a dev server.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name, value]) => name !== "ELECTRON_RENDERER_URL" && value !== undefined)) as Record<string, string>;
  const app = await electron.launch({ args: [checkout, `--user-data-dir=${profile}`, `--home-folder=${home}`, "--hidden"], cwd: checkout, env });
  // The computer's real pointer never reaches the window, as in the window tests.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((window) => window.setIgnoreMouseEvents(true)));
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof (globalThis as unknown as { aba?: unknown }).aba === "object");
  const state = await windowState(app, role, "launch");
  console.log(`Started the ${role} app hidden: ${state.visibleWindows} visible windows, Dock icon ${state.dockVisible === null ? "n/a" : state.dockVisible ? "VISIBLE" : "hidden"}, ${state.focusedWindows} focused.`);
  if (state.visibleWindows > 0 || state.dockVisible === true) {
    await app.close().catch(() => undefined);
    fail("the app showed a window or a Dock icon; stopped at once. Is --hidden supported by this checkout?");
  }
  return { app, page };
}

async function closeApp(app: ElectronApplication, role: LaunchCheck["role"]): Promise<void> {
  const state = await windowState(app, role, "end").catch(() => null);
  if (state && (state.visibleWindows > 0 || state.dockVisible === true)) console.error(`Warning: at the end the ${role} app had ${state.visibleWindows} visible windows, Dock ${state.dockVisible}.`);
  await app.close().catch(() => undefined);
}

/**
 * Calls window.aba in the page. The call is sent as an expression through the devtools
 * protocol (the page itself never evaluates code: its content security policy forbids it),
 * with its input as JSON.
 */
function aba<T>(page: Page, call: (api: AbaApi, input: unknown) => Promise<T>, input?: unknown): Promise<T> {
  return page.evaluate(`(${call.toString()})(globalThis.aba, ${JSON.stringify(input ?? null)})`) as Promise<T>;
}

interface RunOutcome {
  text: string;
  events: Array<Exclude<GenerationUpdateEvent, { type: "text" }>>;
  seconds: number;
  firstTextSeconds: number | null;
  start: unknown;
}

/**
 * Starts one generation through window.aba (a draft, or a judge request) and waits in the
 * page for its "finished": the streamed text, every other event, and the timings.
 */
function runGeneration(page: Page, kind: "draft" | "judge", input: { caseId: string; sectionId: ReportSectionId; provider: "openai" | "anthropic"; request: unknown }): Promise<RunOutcome> {
  return page.evaluate(
    async ({ kind, input, timeoutMs }) => {
      const api = (globalThis as unknown as { aba: AbaApi }).aba;
      const generationId = crypto.randomUUID();
      const started = performance.now();
      let text = "";
      let firstText: number | null = null;
      const events: unknown[] = [];
      const done = new Promise<void>((resolve) => {
        const stop = api.onGenerationUpdate((update) => {
          if (update.generationId !== generationId) return;
          if (update.event.type === "text") {
            if (firstText === null) firstText = performance.now();
            text += update.event.delta;
          } else events.push(update.event);
          if (update.event.type === "finished") {
            stop();
            resolve();
          }
        });
        setTimeout(() => {
          void api.cancelGeneration(generationId);
        }, timeoutMs);
      });
      const start =
        kind === "draft"
          ? await api.startSectionGeneration(input.caseId, input.sectionId, generationId, input.provider, input.request as never)
          : await api.judgeSection(input.caseId, input.sectionId, generationId, input.provider, input.request);
      if (start.outcome === "started") await done;
      const seconds = (performance.now() - started) / 1000;
      return { text, events, seconds, firstTextSeconds: firstText === null ? null : (firstText - started) / 1000, start };
    },
    { kind, input, timeoutMs: REQUEST_TIMEOUT_MS },
  ) as Promise<RunOutcome>;
}

/* ---------------------------------------------------------------------------------- */
/* Connecting                                                                          */

async function connect(page: Page, app: ElectronApplication): Promise<string | null> {
  if (rehearse) {
    await installRehearsalProvider(app);
    const saved = await aba(page, (api, key) => api.saveClaudeKey(key as string), REHEARSAL_CLAUDE_KEY);
    if ((saved as { outcome: string }).outcome !== "saved") fail(`the rehearsal could not connect its fake provider (${JSON.stringify(saved)}).`);
    return (await aba(page, (api) => api.getAiPreferences())).models.anthropic;
  }
  let connections = await aba(page, (api) => api.getConnections());
  if (connections.chatgpt.state !== "connected" && args["sign-in"]) {
    console.log("Opening OpenAI's sign-in page in your browser. Sign in with the ChatGPT account whose plan the evaluation may use.");
    const result = await aba(page, (api) => api.signInToChatGpt());
    console.log(`Sign-in: ${result.outcome}.`);
    connections = await aba(page, (api) => api.getConnections());
  }
  if (connections.chatgpt.state !== "connected") {
    fail(`ChatGPT is not connected in the eval profile (${connections.chatgpt.state}). Run pnpm eval --sign-in once.`);
  }
  // A free call (the account's model list) proves the sign-in still works before any request is spent.
  const check = await aba(page, (api) => api.checkChatGpt());
  if (check.outcome !== "working") fail(`the ChatGPT sign-in does not work just now (${check.outcome}).`);
  return (await aba(page, (api) => api.getAiPreferences())).models.openai;
}

/* ---------------------------------------------------------------------------------- */
/* One case                                                                            */

const requests = { drafts: 0, checks: 0, judges: 0, repairs: 0, total: 0 };
let judgeFormat: JudgeFormat | null = null;

async function loadIntoApp(page: Page, loaded: LoadedCase, plan: LoadPlan[]): Promise<string> {
  const created = await aba(page, (api, input) => api.createCase(input as { label: string }), { label: `${loaded.key.child.fullName} (evaluation ${stamp})` });
  if (created.outcome !== "created") fail(`could not create the case (${created.outcome}).`);
  const caseId = created.case.id;
  for (const source of plan) {
    if (source.file.endsWith(".pdf")) {
      const bytes = [...readFileSync(path.join(loaded.folder, source.file))];
      const added = await aba(page, (api, input) => {
        const { caseId: id, name, data } = input as { caseId: string; name: string; data: number[] };
        return api.addDroppedPdf(id, { name, data: new Uint8Array(data) });
      }, { caseId, name: source.file, data: bytes });
      if (added.outcome !== "done" || added.added.length !== 1) fail(`could not add ${source.file} (${JSON.stringify(added).slice(0, 200)}).`);
      const changed = await aba(page, (api, input) => {
        const { caseId: id, sourceId, change } = input as { caseId: string; sourceId: string; change: never };
        return api.changeSource(id, sourceId, change);
      }, { caseId, sourceId: added.added[0], change: { type: source.type, title: source.title, ...(source.date ? { date: source.date } : {}) } });
      if (changed.outcome !== "saved") fail(`could not set the type of ${source.file}.`);
    } else {
      const added = await aba(page, (api, input) => {
        const { caseId: id, source: s } = input as { caseId: string; source: never };
        return api.addTextSource(id, s);
      }, { caseId, source: { type: source.type, title: source.title, ...(source.date ? { date: source.date } : {}), text: readFileSync(path.join(loaded.folder, source.file), "utf8") } });
      if (added.outcome !== "saved") fail(`could not add ${source.file} (${added.outcome}).`);
    }
  }
  if (loaded.key.inputs.notes) {
    const notes = await aba(page, (api, input) => api.saveSessionNotes((input as { caseId: string }).caseId, (input as { notes: string }).notes), { caseId, notes: loaded.key.inputs.notes });
    if (notes.outcome !== "saved") fail("could not save the session notes.");
  }
  for (const [section, text] of Object.entries(loaded.key.inputs.instructions ?? {})) {
    await aba(page, (api, input) => {
      const { caseId: id, section: s, text: t } = input as { caseId: string; section: ReportSectionId; text: string };
      return api.saveSectionInstructions(id, s, t);
    }, { caseId, section, text });
  }
  return caseId;
}

interface Drafted {
  version: number | null;
  error: string | null;
  seconds: number;
  checked: boolean;
}

async function draftSections(page: Page, caseId: string): Promise<Map<ReportSectionId, Drafted>> {
  const drafted = new Map<ReportSectionId, Drafted>();
  for (const { id } of REPORT_SECTIONS) {
    process.stdout.write(`  draft ${id} ... `);
    requests.drafts++;
    requests.total++;
    let outcome = await runGeneration(page, "draft", { caseId, sectionId: id, provider, request: { kind: "draft" } });
    const firstError = outcome.events.find((event) => event.type === "error") as { code: string; message: string } | undefined;
    if (firstError && TRANSIENT.test(`${firstError.code} ${firstError.message}`)) {
      process.stdout.write(`(${firstError.code}; trying once more in ${RETRY_PAUSE_MS / 1000} s) `);
      await pause(RETRY_PAUSE_MS);
      requests.drafts++;
      requests.total++;
      outcome = await runGeneration(page, "draft", { caseId, sectionId: id, provider, request: { kind: "draft" } });
    }
    const start = outcome.start as { outcome: string };
    const saved = outcome.events.find((event) => event.type === "saved") as { result: { outcome: string; section?: { currentVersion: number | null } } } | undefined;
    const error = outcome.events.find((event) => event.type === "error") as { code: string; message: string } | undefined;
    const checked = outcome.events.find((event) => event.type === "checked") as { result: { outcome: string; section?: { versions: Array<{ number: number; consistency?: { status: string } | null }> } } } | undefined;
    const version = saved?.result.outcome === "saved" ? (saved.result.section?.currentVersion ?? null) : null;
    // A check with nothing of hers to compare sends nothing ("nothing-to-compare").
    const status = checked?.result.section?.versions.find((v) => v.number === version)?.consistency?.status;
    const sentCheck = status !== undefined && status !== "nothing-to-compare";
    if (sentCheck) {
      requests.checks++;
      requests.total++;
    }
    const why = start.outcome !== "started" ? `not started: ${start.outcome}` : error ? `${error.code}: ${error.message}` : saved && saved.result.outcome !== "saved" ? `not saved: ${saved.result.outcome}` : version === null ? "no version saved" : null;
    drafted.set(id, { version, error: why, seconds: outcome.seconds, checked: sentCheck });
    console.log(why ? `FAILED (${why})` : `v${version} in ${outcome.seconds.toFixed(1)} s${sentCheck ? ", checked" : ""}`);
    if (error && /usage_limit|chatgpt_signed_out|chatgpt_not_eligible/.test(error.code)) fail(`stopped: ${error.message}`);
    if (mode === "chained" && version !== null) {
      const approved = await aba(page, (api, input) => {
        const { caseId: c, id: s, version: v } = input as { caseId: string; id: ReportSectionId; version: number };
        return api.approveSection(c, s, v);
      }, { caseId, id, version });
      if (approved.outcome !== "saved") fail(`could not approve ${id} v${version}.`);
    }
  }
  return drafted;
}

function judgeInputFor(loaded: LoadedCase, section: ReportSectionId, loadedSources: ReadonlySet<string>, format: JudgeFormat): JudgeInput {
  const key = loaded.key;
  const items = RUBRIC.filter((item) => item.scoredBy === "judge" && item.stage === "body" && item.id !== "key-facts").map((item) => ({ id: item.id, title: item.title, anchors: item.anchors }));
  return {
    rubricVersion: RUBRIC_VERSION,
    items,
    expectations: [...SECTION_EXPECTATIONS[section], ...STYLE_EXPECTATIONS.map((habit) => `Habit: ${habit}`)],
    keyFacts: (key.sectionFacts[section] ?? []).filter((fact) => fact.from.every((id) => loadedSources.has(id))).map(({ id, fact }) => ({ id, fact })),
    caseNotes: [
      ...key.behaviors.map((b) => `Behavior "${b.name}": hypothesized function ${b.functions.primary.join(", ")}${b.functions.secondary.length > 0 ? `; secondary ${b.functions.secondary.join(", ")}` : ""}.`),
      ...key.plantedGaps.map((gap) => `Planted gap: ${gap.gap}`),
      ...key.incidents.filter((incident) => incident.from.every((id) => loadedSources.has(id))).map((incident) => `"${incident.description}" belongs to ${incident.home}; up to ${incident.references} other section(s) may refer to it.`),
    ].slice(0, 30),
    format,
    repair: null,
  };
}

async function judgeSection(page: Page, caseId: string, loaded: LoadedCase, section: ReportSectionId, loadedSources: ReadonlySet<string>): Promise<JudgeRecord> {
  const record: JudgeRecord = { format: judgeFormat ?? "json-schema", repaired: false, answer: null, error: null, requests: 0, seconds: 0, usage: null };
  let input = judgeInputFor(loaded, section, loadedSources, record.format);
  const itemIds = input.items.map((item) => item.id);
  const factIds = input.keyFacts.map((fact) => fact.id);
  let retried = false;
  const send = async (request: JudgeInput): Promise<{ text: string; error: { code: string; message: string } | null }> => {
    record.requests++;
    requests.total++;
    if (request.repair) requests.repairs++;
    else requests.judges++;
    const outcome = await runGeneration(page, "judge", { caseId, sectionId: section, provider, request });
    record.seconds += outcome.seconds;
    const done = outcome.events.find((event) => event.type === "done") as { usage: Usage; complete: boolean } | undefined;
    if (done) record.usage = done.usage;
    const error = outcome.events.find((event) => event.type === "error") as { code: string; message: string } | undefined;
    const start = outcome.start as { outcome: string };
    if (error && TRANSIENT.test(`${error.code} ${error.message}`) && !retried) {
      retried = true;
      process.stdout.write(`(${error.code}; trying once more in ${RETRY_PAUSE_MS / 1000} s) `);
      await pause(RETRY_PAUSE_MS);
      return send(request);
    }
    return { text: outcome.text, error: start.outcome !== "started" ? { code: start.outcome, message: `not started: ${start.outcome}` } : (error ?? (done?.complete ? null : { code: "incomplete", message: "the answer was cut short" })) };
  };
  let answer = await send(input);
  // The first judge request of the run is where the ChatGPT route shows whether it takes a JSON schema.
  // Until one judge answer has come back, the format is unverified: a refusal of any kind
  // (a 400, "unsupported", or an error the stream reports) is taken as the route not taking it.
  const unverified = judgeFormat === null;
  if (answer.error && record.format === "json-schema" && (/bad_request|chatgpt_unsupported/.test(answer.error.code) || (unverified && /provider_error|stream_error/.test(answer.error.code)))) {
    console.log(`    the route refused the JSON-schema format (${answer.error.message.slice(0, 160)}); using plain JSON with validation from now on.`);
    judgeFormat = "plain-json";
    record.format = "plain-json";
    input = { ...input, format: "plain-json" };
    answer = await send(input);
  }
  if (answer.error) {
    record.error = `${answer.error.code}: ${answer.error.message}`;
    if (/usage_limit|chatgpt_signed_out|chatgpt_not_eligible/.test(answer.error.code)) fail(`stopped: ${answer.error.message}`);
    return record;
  }
  if (judgeFormat === null) judgeFormat = record.format;
  let parsed = parseJudgeAnswer(answer.text, section, itemIds, factIds);
  if (!parsed.ok) {
    record.repaired = true;
    const repaired = await send({ ...input, repair: { previousAnswer: answer.text.slice(0, 60_000), problems: parsed.problems.slice(0, 30) } });
    if (repaired.error) {
      record.error = `repair failed: ${repaired.error.code}: ${repaired.error.message}`;
      return record;
    }
    parsed = parseJudgeAnswer(repaired.text, section, itemIds, factIds);
  }
  if (parsed.ok) record.answer = parsed.answer;
  else record.error = `no valid answer after one repair: ${parsed.problems.slice(0, 3).join(" ")}`;
  return record;
}

async function currentTexts(page: Page, caseId: string): Promise<Map<ReportSectionId, { version: number; text: string; detail: unknown }>> {
  const texts = new Map<ReportSectionId, { version: number; text: string; detail: unknown }>();
  for (const { id } of REPORT_SECTIONS) {
    const got = await aba(page, (api, input) => api.getSection((input as { caseId: string }).caseId, (input as { id: ReportSectionId }).id), { caseId, id });
    if (got.outcome !== "read" || got.section.currentVersion === null) continue;
    const version = got.section.versions.find((v) => v.number === got.section.currentVersion);
    if (version) texts.set(id, { version: version.number, text: version.text, detail: version });
  }
  return texts;
}

function examplesOf(checkout: string): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".md")) files.push(full);
    }
  };
  walk(path.join(checkout, "rules"));
  return files.flatMap((file) => extractExamples(readFileSync(file, "utf8")));
}

/**
 * What the app recorded with each version (the model that answered, its tokens, the rules
 * versions, its consistency check), read from the case's data file in the run's own
 * temporary home: the interface shows less than the file keeps. Only the case file is
 * read, never the profile's credentials.
 */
function recordedVersions(home: string, caseId: string): Map<ReportSectionId, Map<number, unknown>> {
  const found = new Map<ReportSectionId, Map<number, unknown>>();
  const folder = path.join(home, "ABA Workbench");
  if (!existsSync(folder)) return found;
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const file = path.join(folder, entry.name, "aba-case.json");
    if (!entry.isDirectory() || !existsSync(file)) continue;
    const data = JSON.parse(readFileSync(file, "utf8")) as { id?: string; sections?: Record<string, { versions?: Array<{ number: number }> }> };
    if (data.id !== caseId) continue;
    for (const [id, section] of Object.entries(data.sections ?? {})) {
      found.set(id as ReportSectionId, new Map((section.versions ?? []).map((version) => [version.number, version])));
    }
  }
  return found;
}

function rulesVersionsOf(texts: Map<ReportSectionId, { detail: unknown }>): Record<string, string> {
  const all: Record<string, string> = {};
  for (const { detail } of texts.values()) Object.assign(all, (detail as { generation?: { rulesVersions?: Record<string, string> } }).generation?.rulesVersions ?? {});
  return all;
}

/* ---------------------------------------------------------------------------------- */
/* The run                                                                             */

async function main(): Promise<void> {
  const cases = selectedCases();
  const profile = rehearse ? mkdtempSync(path.join(tmpdir(), "aba-eval-rehearsal-profile-")) : EVAL_PROFILE;
  ownerOnlyFolder(profile);
  if (!existsSync(path.join(profile, "settings.json"))) writeFileSync(path.join(profile, "settings.json"), JSON.stringify({ version: 1, language: "en" }), { mode: 0o600 });
  const home = mkdtempSync(path.join(tmpdir(), "aba-eval-home-"));
  ownerOnlyFolder(home);
  const startedAt = new Date().toISOString();
  console.log(`Evaluation run ${label}: ${cases.map((c) => c.key.caseId).join(", ")}; ${mode} drafting; ${rehearse ? "REHEARSAL with a fake provider (no request leaves the computer)" : "ChatGPT sign-in of the eval profile"}.`);

  if (!fromRun) build(draftCheckout);
  if (fromRun || draftCheckout !== judgeCheckout) build(judgeCheckout);

  const caseResults: CaseResult[] = [];
  let model: string | null = null;
  try {
    for (const loaded of cases) {
      console.log(`\n${loaded.key.caseId}`);
      const plan = sourcePlan(loaded);
      const loadedSources = new Set([...plan.map((source) => source.id), ...(loaded.key.inputs.notes ? ["notes"] : [])]);

      const prior = fromRun ? (fromRun.cases.find((c) => c.caseId === loaded.key.caseId) ?? fail(`the run ${fromRun.label} has no case ${loaded.key.caseId}.`)) : null;

      // Draft with the app under test (or, with --from-run, put the earlier run's drafts in place).
      let { app, page } = await launch(prior ? judgeCheckout : draftCheckout, prior ? "judge" : "draft", profile, home);
      let caseId: string;
      let drafted: Map<ReportSectionId, Drafted>;
      let texts: Map<ReportSectionId, { version: number; text: string; detail: unknown }>;
      try {
        model = await connect(page, app);
        caseId = await loadIntoApp(page, loaded, plan);
        if (prior) {
          drafted = new Map();
          for (const section of prior.sections) {
            drafted.set(section.id, { version: section.version, error: section.draftError, seconds: section.generation?.seconds ?? 0, checked: section.consistency !== null && section.consistency.status !== "nothing-to-compare" });
            if (section.text === null) continue;
            const saved = await aba(page, (api, input) => {
              const { caseId: c, id, text } = input as { caseId: string; id: ReportSectionId; text: string };
              return api.saveSectionText(c, id, text, null);
            }, { caseId, id: section.id, text: section.text });
            if (saved.outcome !== "saved") fail(`could not put back the draft of ${section.id}.`);
          }
        } else {
          drafted = await draftSections(page, caseId);
        }
        texts = await currentTexts(page, caseId);
        const recorded = recordedVersions(home, caseId);
        for (const [id, entry] of texts) {
          const stored = recorded.get(id)?.get(entry.version);
          if (stored) entry.detail = stored;
        }
      } finally {
        if (!prior && draftCheckout !== judgeCheckout) await closeApp(app, "draft");
      }

      // Judge with this branch's app (the same one when no --draft-app was given).
      if (!prior && draftCheckout !== judgeCheckout) {
        ({ app, page } = await launch(judgeCheckout, "judge", profile, home));
        if (rehearse) await installRehearsalProvider(app);
        const opened = await aba(page, (api, id) => api.openCase(id as string), caseId);
        if (opened.outcome !== "opened") fail(`the judge app could not open the case (${opened.outcome}).`);
      }
      const judged = new Map<ReportSectionId, JudgeRecord>();
      try {
        for (const { id } of REPORT_SECTIONS) {
          if (!texts.has(id)) continue;
          const earlier = prior?.sections.find((section) => section.id === id)?.judge ?? null;
          if (earlier?.answer) {
            judged.set(id, earlier);
            continue;
          }
          process.stdout.write(`  judge ${id} ... `);
          const record = await judgeSection(page, caseId, loaded, id, loadedSources);
          judged.set(id, record);
          console.log(record.error ? `FAILED (${record.error})` : `${record.format}${record.repaired ? ", repaired" : ""}, ${record.seconds.toFixed(1)} s`);
        }
      } finally {
        await closeApp(app, prior || draftCheckout !== judgeCheckout ? "judge" : "draft");
      }

      // The checks, the scores, the record.
      const shapes = Object.fromEntries(REPORT_SECTIONS.map(({ id }) => [id, SECTION_SHAPES[id] ?? { paragraphs: null, words: null }]));
      const sectionTexts = Object.fromEntries([...texts].map(([id, entry]) => [id, entry.text])) as Partial<Record<ReportSectionId, string>>;
      // The model also sees each source's title and date (src/main/outgoing.ts, outgoingSourceTitle).
      const index = numberIndex([...plan.map((source) => `${source.title} ${source.date ?? ""}\n${source.text}`), loaded.key.inputs.notes ?? "", ...Object.values(loaded.key.inputs.instructions ?? {})]);
      const findings = runChecks(sectionTexts, { key: loaded.key, numbers: index, shapes, examples: examplesOf(draftCheckout), loadedSources, numberedListsAllowed: NUMBERED_LISTS_ALLOWED });
      const sections: SectionResult[] = REPORT_SECTIONS.map(({ id }): SectionResult => {
        const entry = texts.get(id) ?? null;
        const detail = entry?.detail as { generation?: { usage?: Usage; servedModel?: string; rulesVersions?: Record<string, string> }; consistency?: { status: string; items: string[] } | null } | undefined;
        const mine = findings.filter((finding) => finding.section === id);
        const judge = judged.get(id) ?? null;
        const before = prior?.sections.find((section) => section.id === id) ?? null;
        if (before) {
          return { ...before, findings: mine, scores: scoreSection(id, mine, judge?.answer ?? null, before.text !== null), judge };
        }
        return {
          id,
          version: entry?.version ?? null,
          text: entry?.text ?? null,
          words: entry ? countWords(entry.text) : 0,
          paragraphs: entry ? splitParagraphs(entry.text).length : 0,
          markers: entry ? findMarkers(entry.text).map(({ kind, note }) => ({ kind, note })) : [],
          generation: detail?.generation ? { seconds: drafted.get(id)?.seconds ?? 0, usage: detail.generation.usage ?? null, servedModel: detail.generation.servedModel ?? null, rulesVersions: detail.generation.rulesVersions ?? {} } : null,
          consistency: detail?.consistency ? { status: detail.consistency.status, items: detail.consistency.items } : null,
          draftError: drafted.get(id)?.error ?? null,
          findings: mine,
          scores: scoreSection(id, mine, judge?.answer ?? null, entry !== null),
          judge,
        };
      });
      caseResults.push({ caseId: loaded.key.caseId, keyVersion: loaded.key.keyVersion, sourcesLoaded: [...loadedSources], sections });
      if (!rulesVersionsCache) rulesVersionsCache = prior ? fromRun!.drafting.rulesVersions : rulesVersionsOf(texts);
    }
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    if (rehearse) rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }

  const run: RunResult = {
    resultsVersion: RESULTS_VERSION,
    label,
    startedAt,
    finishedAt: new Date().toISOString(),
    rubricVersion: RUBRIC_VERSION,
    judgePromptVersion: JUDGE_PROMPT_VERSION,
    drafting: fromRun
      ? fromRun.drafting
      : { checkout: draftCheckout, commit: git(draftCheckout, "rev-parse", "HEAD"), branch: git(draftCheckout, "rev-parse", "--abbrev-ref", "HEAD"), dirty: git(draftCheckout, "status", "--porcelain", "--untracked-files=no") !== "", rulesVersions: rulesVersionsCache ?? {} },
    judging: { checkout: judgeCheckout, commit: git(judgeCheckout, "rev-parse", "HEAD") },
    provider: rehearse ? "rehearsal (fake provider)" : "openai (ChatGPT sign-in)",
    model,
    mode: fromRun ? fromRun.mode : mode,
    judgeFormat: judgeFormat ?? fromRun?.judgeFormat ?? null,
    requests: fromRun
      ? {
          drafts: fromRun.requests.drafts + requests.drafts,
          checks: fromRun.requests.checks + requests.checks,
          judges: fromRun.requests.judges + requests.judges,
          repairs: fromRun.requests.repairs + requests.repairs,
          total: fromRun.requests.total + requests.total,
        }
      : requests,
    launches: [...(fromRun?.launches ?? []), ...launches],
    ...(fromRun ? { fromRun: fromRun.label } : {}),
    cases: caseResults,
  };

  // Compare with the accepted baseline; a rehearsal is compared only with a rehearsal baseline.
  const baseline = findBaseline(args.baseline ?? null, rehearse);
  const comparison = baseline ? compareRuns(run, baseline.run) : null;
  mkdirSync(runDir, { recursive: true });
  writeFileSync(path.join(runDir, "results.json"), JSON.stringify(run, null, 2));
  writeFileSync(path.join(runDir, "summary.md"), summaryMarkdown(run, comparison, baseline?.name ?? null));
  if (comparison) writeFileSync(path.join(runDir, "comparison.json"), JSON.stringify({ baseline: baseline!.name, ...comparison }, null, 2));
  for (const c of caseResults) {
    mkdirSync(path.join(runDir, "drafts", c.caseId), { recursive: true });
    for (const s of c.sections) if (s.text !== null) writeFileSync(path.join(runDir, "drafts", c.caseId, `${s.id}.txt`), s.text);
  }
  if (args.accept) {
    const target = path.join(BASELINES_DIR, args.accept);
    mkdirSync(target, { recursive: true });
    cpSync(path.join(runDir, "results.json"), path.join(target, "results.json"));
    cpSync(path.join(runDir, "summary.md"), path.join(target, "summary.md"));
    console.log(`Accepted as the baseline ${path.relative(ROOT, target)} (commit it).`);
  }
  console.log(`\n${summaryMarkdown(run, comparison, baseline?.name ?? null).split("\n").slice(0, 7).join("\n")}`);
  if (fromRun) console.log(`This run made ${requests.total} new requests (${requests.judges} judge, ${requests.repairs} repairs).`);
  console.log(`\nResults: ${path.relative(ROOT, runDir)}/ (results.json, summary.md, drafts/).`);
  if (comparison?.regressed) process.exitCode = 2;
}

let rulesVersionsCache: Record<string, string> | null = null;

/** The baseline named, or the newest accepted one of the same kind (real or rehearsal). */
function findBaseline(name: string | null, rehearsal: boolean): { name: string; run: RunResult } | null {
  if (!existsSync(BASELINES_DIR)) return null;
  const read = (dir: string) => JSON.parse(readFileSync(path.join(BASELINES_DIR, dir, "results.json"), "utf8")) as RunResult;
  if (name) {
    if (!existsSync(path.join(BASELINES_DIR, name, "results.json"))) fail(`no baseline eval/baselines/${name}/results.json.`);
    return { name, run: read(name) };
  }
  const candidates = readdirSync(BASELINES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(BASELINES_DIR, entry.name, "results.json")))
    .map((entry) => ({ name: entry.name, run: read(entry.name), at: statSync(path.join(BASELINES_DIR, entry.name, "results.json")).mtimeMs }))
    .filter((candidate) => candidate.run.provider.startsWith("rehearsal") === rehearsal)
    .sort((a, b) => b.run.finishedAt.localeCompare(a.run.finishedAt) || b.at - a.at);
  return candidates[0] ? { name: candidates[0].name, run: candidates[0].run } : null;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
