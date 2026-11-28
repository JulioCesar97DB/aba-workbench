/*
 * pnpm eval: the evaluation set, run through the real app (docs/evaluation.md).
 *
 * For each invented case with a key (fixtures/cases/<case>/key.json) it starts the built
 * app hidden (--hidden: no window shown, no Dock icon, never the focus) and runs the case
 * several times (3 by default, the owner's decision of 2026-11-23). Each run loads the
 * case through window.aba as she would, drafts the nine narrative sections in report
 * order, runs the automatic checks and asks the judge to score each section. The run
 * writes results.json and summary.md to eval-results/<run>/ and compares the medians of
 * its runs with those of the last accepted run (eval/baselines/<name>/).
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
 *   pnpm eval --baseline-run <run folder>  compare with the baseline as that run compared it (its baseline-as-compared.json): checked again, and judged again only where its judge differs
 *   pnpm eval --accept <name>           also save this run as eval/baselines/<name>/ (paths stripped; refused if dirty or invalid)
 *   pnpm eval --label <text>            names the run's folder
 *   pnpm eval --no-build                use the apps as they are built (default: pnpm build in each checkout first)
 *   pnpm eval --from-run <run folder>   take that run's drafts: check them again, and judge only where there is no answer from this judge
 *   pnpm eval --rejudge <run folder>    take that run's drafts: check them again, and judge every section again
 *   pnpm eval --runs <n>                run each case n times (1, 3 or 5; default 3) and compare the medians
 *   pnpm eval --judge-samples <n>       judge each section n times in each run (default 1: the runs are the samples)
 */
import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { JUDGE_PROMPT_VERSION, parseJudgeAnswer, type JudgeAnswer, type JudgeFormat, type JudgeInput } from "../src/lib/judge.ts";
import { MAX_CASE_LABEL_LENGTH, type AbaApi, type GenerationUpdateEvent } from "../src/shared/api.ts";
import { REPORT_SECTIONS, type ReportSectionId } from "../src/shared/report-sections.ts";
import { countWords, findMarkers, splitParagraphs } from "../src/shared/section-text.ts";
import { CHECKS_VERSION, extractExamples, numberIndex, runChecks, type Finding } from "./checks/checks.ts";
import { loadCase, type LoadedCase } from "./key.ts";
import {
  addUsage,
  adoptRubricWhenRescored,
  baselineCaseLabel,
  baselineCopy,
  compareRuns,
  caseMedians,
  exitCodeFor,
  incompleteParts,
  keepsEarlierJudge,
  normalizeRun,
  RESULTS_VERSION,
  RUN_COUNTS,
  rejudgedBaselineName,
  rescoreRun,
  reusableBaselineJudge,
  scoreSection,
  summaryMarkdown,
  type CaseResult,
  type CaseRun,
  type CheckoutRecord,
  type JudgeRecord,
  type LaunchCheck,
  type RunResult,
  type SavedBaselineJudge,
  type SectionResult,
  type Usage,
} from "./results.ts";
import { NUMBERED_LISTS_ALLOWED, RUBRIC, RUBRIC_VERSION, SECTION_EXPECTATIONS, SECTION_PAYER_FACTS, SECTION_SHAPES, STYLE_EXPECTATIONS } from "./rubric.ts";
import { installRehearsalProvider, REHEARSAL_CLAUDE_KEY } from "./rehearsal.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const CASES_DIR = path.join(ROOT, "fixtures", "cases");
const RESULTS_DIR = path.join(ROOT, "eval-results");
const BASELINES_DIR = path.join(ROOT, "eval", "baselines");
/** The owner's choice (2026-11-23): one throwaway profile, kept signed in, outside the repository, ~/ABA Workbench and Documents. */
const EVAL_PROFILE = path.join(homedir(), ".aba-workbench-eval", "profile");
/** How long one request may take before the run gives up on it. */
const REQUEST_TIMEOUT_MS = 6 * 60_000;
/** How often the windows are checked while the app runs (review S9). */
const WINDOW_CHECK_MS = 5_000;
/**
 * Errors on the provider's side that a second try may get past (an overloaded server, a
 * dropped connection, no answer in time). A failed request saves nothing, so it is sent
 * once more after a pause; anything else is not retried.
 */
const TRANSIENT = /server_is_overloaded|provider_unavailable|chatgpt_unavailable|timeout|connection_failed|overloaded/;
const RETRY_PAUSE_MS = 30_000;
const STOPPING = /usage_limit|chatgpt_signed_out|chatgpt_not_eligible/;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A run that cannot go on: main cleans up (the temporary home, a rehearsal profile, the apps) and exits with 1 (review M4). */
class EvalFailure extends Error {}
function fail(message: string): never {
  throw new EvalFailure(message);
}

const { values: args } = parseArgs({
  options: {
    "sign-in": { type: "boolean", default: false },
    rehearse: { type: "boolean", default: false },
    "draft-app": { type: "string" },
    cases: { type: "string" },
    mode: { type: "string", default: "chained" },
    baseline: { type: "string" },
    "baseline-run": { type: "string" },
    accept: { type: "string" },
    label: { type: "string" },
    "no-build": { type: "boolean", default: false },
    "from-run": { type: "string" },
    rejudge: { type: "string" },
    runs: { type: "string" },
    "judge-samples": { type: "string", default: "1" },
  },
});

/* ---------------------------------------------------------------------------------- */
/* Options                                                                             */

interface Options {
  mode: "chained" | "independent";
  rehearse: boolean;
  provider: "openai" | "anthropic";
  draftCheckout: string;
  /** --from-run or --rejudge: an earlier run whose drafts are taken instead of drafting. */
  prior: RunResult | null;
  /** That run's folder (its baseline-judged.json is reused with --from-run). */
  priorDir: string | null;
  rejudgeAll: boolean;
  /** How many times each case is run (with --from-run or --rejudge: that run's count). */
  runs: number;
  samples: number;
  label: string;
  runDir: string;
}

function readOptions(): Options {
  if (args.mode !== "chained" && args.mode !== "independent") fail('--mode is "chained" or "independent".');
  const samples = Number(args["judge-samples"]);
  if (!Number.isInteger(samples) || samples < 1 || samples > 5) fail("--judge-samples takes a whole number from 1 to 5.");
  if (args["from-run"] && args.rejudge) fail("--from-run and --rejudge are two ways of taking a run's drafts: give one.");
  const priorDir = args.rejudge ?? args["from-run"];
  const prior = priorDir ? normalizeRun(JSON.parse(readFileSync(path.join(path.resolve(priorDir), "results.json"), "utf8"))) : null;
  const runs = args.runs === undefined ? (prior ? prior.runs : 3) : Number(args.runs);
  if (!(RUN_COUNTS as readonly number[]).includes(runs)) fail("--runs takes 1, 3 or 5: an odd count, so a median and a majority never tie.");
  if (prior && runs !== prior.runs) fail(`--from-run and --rejudge take every run of that run (${prior.runs}); --runs cannot change it.`);
  if (prior && args["draft-app"]) fail("--from-run and --rejudge draft nothing, so they take no --draft-app.");
  const rehearse = args.rehearse === true;
  if (prior && rehearse !== prior.provider.startsWith("rehearsal")) fail("--from-run and --rejudge take a run of the same kind (real or rehearsal).");
  const draftCheckout = args["draft-app"] ? path.resolve(args["draft-app"]) : ROOT;
  if (!existsSync(path.join(draftCheckout, "package.json"))) fail("--draft-app is not a checkout of the app.");
  // Review S9: a checkout from before hidden mode would show its window before any check could stop it.
  const paths = path.join(draftCheckout, "src", "main", "paths.ts");
  if (!existsSync(paths) || !readFileSync(paths, "utf8").includes("resolveHiddenMode")) fail("--draft-app is a checkout without hidden mode (--hidden): it would show a window. Refused.");
  if (args.accept !== undefined && !/^[a-z0-9][a-z0-9._-]{0,60}$/i.test(args.accept)) fail("--accept takes a short name (letters, digits, dot, dash, underscore).");
  if (args.accept !== undefined && rehearse) fail("a rehearsal is never accepted as a baseline (eval/baselines/README.md).");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const label = `${stamp}${args.label ? `-${args.label.replace(/[^a-z0-9._-]+/gi, "-").slice(0, 40)}` : ""}${rehearse ? "-rehearsal" : ""}`;
  return {
    mode: prior ? prior.mode : (args.mode as "chained" | "independent"),
    rehearse,
    provider: rehearse ? "anthropic" : "openai",
    draftCheckout,
    prior,
    priorDir: priorDir ? path.resolve(priorDir) : null,
    rejudgeAll: args.rejudge !== undefined,
    runs,
    samples,
    label,
    runDir: path.join(RESULTS_DIR, label),
  };
}

/* ---------------------------------------------------------------------------------- */
/* The cases                                                                           */

function selectedCases(prior: RunResult | null): LoadedCase[] {
  const all = readdirSync(CASES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(CASES_DIR, entry.name, "key.json")))
    .map((entry) => entry.name)
    .sort();
  // --from-run and --rejudge take that run's cases unless --cases names some.
  const wanted = args.cases ? args.cases.split(",").map((name) => name.trim()) : prior ? prior.cases.map((c) => c.caseId) : all;
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

/** Her standing instructions for every section, as the run gives them: the key's text, or empty (review S3). */
function instructionsFor(loaded: LoadedCase): Record<ReportSectionId, string> {
  return Object.fromEntries(REPORT_SECTIONS.map(({ id }) => [id, loaded.key.inputs.instructions?.[id] ?? ""])) as Record<ReportSectionId, string>;
}

/* ---------------------------------------------------------------------------------- */
/* The checkouts and the apps                                                          */

function git(checkout: string, ...gitArgs: string[]): string {
  try {
    return execFileSync("git", ["-C", checkout, ...gitArgs], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

/** A checkout as the results record it: a label, never a path (review B4); dirty counts untracked files in rules/, src/ and eval/ (review S10). */
function checkoutRecord(checkout: string): CheckoutRecord {
  return {
    label: checkout === ROOT ? "this checkout" : path.basename(checkout),
    commit: git(checkout, "rev-parse", "HEAD"),
    branch: git(checkout, "rev-parse", "--abbrev-ref", "HEAD"),
    dirty: git(checkout, "status", "--porcelain", "--untracked-files=all", "--", "rules", "src", "eval") !== "",
  };
}

function build(checkout: string): void {
  if (args["no-build"]) {
    if (!existsSync(path.join(checkout, "out", "main", "index.js"))) fail(`the ${checkout === ROOT ? "judging" : "drafting"} checkout is not built; run without --no-build.`);
    return;
  }
  console.log(`Building ${checkout === ROOT ? "this checkout" : path.basename(checkout)} ...`);
  execFileSync("pnpm", ["build"], { cwd: checkout, stdio: ["ignore", "ignore", "inherit"] });
}

/** Owner-only folders: the profile holds the ChatGPT sign-in. */
function ownerOnlyFolder(folder: string): void {
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  chmodSync(folder, 0o700);
}

const launches: LaunchCheck[] = [];
let windowChecksDuring = 0;
let invalidReason: string | null = null;
const running = new Set<ElectronApplication>();

/**
 * The app's message boxes never show during a run (review round 2, N1): the harness, not
 * the app, replaces them right after launch, the way the window tests stub them. A box the
 * app asks for is recorded and answered with its second button ("Close anyway" for the
 * unsaved-changes question), and the run is then invalid: something needed a person.
 */
async function stubDialogs(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ dialog }) => {
    const g = globalThis as unknown as { evalDialogs: string[] };
    g.evalDialogs = [];
    const record = (args: unknown[]) => {
      const options = args.find((arg): arg is { message?: unknown; title?: unknown } => typeof arg === "object" && arg !== null && "message" in arg);
      g.evalDialogs.push(String(options?.message ?? options?.title ?? "a message box").slice(0, 200));
    };
    dialog.showMessageBox = (async (...args: unknown[]) => {
      record(args);
      return { response: 1, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
    dialog.showMessageBoxSync = ((...args: unknown[]) => {
      record(args);
      return 1;
    }) as typeof dialog.showMessageBoxSync;
    dialog.showErrorBox = ((title: string) => {
      g.evalDialogs.push(String(title).slice(0, 200));
    }) as typeof dialog.showErrorBox;
  });
}

/** Visible windows, the Dock icon, focused windows and message boxes asked for, as the app's main process sees them. */
async function windowState(app: ElectronApplication, role: LaunchCheck["role"], at: LaunchCheck["at"]): Promise<LaunchCheck> {
  const state = await app.evaluate(({ app: electronApp, BrowserWindow }) => ({
    visibleWindows: BrowserWindow.getAllWindows().filter((window) => window.isVisible()).length,
    focusedWindows: BrowserWindow.getAllWindows().filter((window) => window.isFocused()).length,
    dockVisible: electronApp.dock ? electronApp.dock.isVisible() : null,
    dialogs: [...((globalThis as unknown as { evalDialogs?: string[] }).evalDialogs ?? [])],
  }));
  return { role, at, ...state };
}

const showsSomething = (state: LaunchCheck) => state.visibleWindows > 0 || state.focusedWindows > 0 || state.dockVisible === true || (state.dialogs?.length ?? 0) > 0;
const describe = (state: LaunchCheck) =>
  `${state.visibleWindows} visible, ${state.focusedWindows} focused, Dock ${state.dockVisible}${state.dialogs && state.dialogs.length > 0 ? `, a dialog was asked for: ${state.dialogs.join(" / ")}` : ""}`;

/**
 * Checks the windows every few seconds while the app runs (review S9). Anything shown or
 * focused stops the run at once: the app is killed and the run is invalid.
 */
function watchWindows(app: ElectronApplication, role: LaunchCheck["role"]): () => void {
  const timer = setInterval(() => {
    void windowState(app, role, "during")
      .then((state) => {
        windowChecksDuring++;
        if (!showsSomething(state)) return;
        launches.push(state);
        invalidReason = `the ${role} app showed a window, its Dock icon, took the focus or asked for a dialog during the run (${describe(state)})`;
        console.error(`STOPPED: ${invalidReason}.`);
        app.process().kill("SIGKILL");
      })
      .catch(() => undefined);
  }, WINDOW_CHECK_MS);
  return () => clearInterval(timer);
}

async function launch(checkout: string, role: LaunchCheck["role"], profile: string, home: string): Promise<{ app: ElectronApplication; page: Page; stopWatching: () => void }> {
  // Never point the window at a dev server.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name, value]) => name !== "ELECTRON_RENDERER_URL" && value !== undefined)) as Record<string, string>;
  const app = await electron.launch({ args: [checkout, `--user-data-dir=${profile}`, `--home-folder=${home}`, "--hidden"], cwd: checkout, env });
  running.add(app);
  await stubDialogs(app);
  // The computer's real pointer never reaches the window, as in the window tests.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((window) => window.setIgnoreMouseEvents(true)));
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof (globalThis as unknown as { aba?: unknown }).aba === "object");
  const state = await windowState(app, role, "launch");
  launches.push(state);
  console.log(`Started the ${role} app hidden: ${state.visibleWindows} visible windows, Dock icon ${state.dockVisible === null ? "n/a" : state.dockVisible ? "VISIBLE" : "hidden"}, ${state.focusedWindows} focused.`);
  if (showsSomething(state)) {
    invalidReason = `the ${role} app showed a window, its Dock icon or took the focus at launch`;
    app.process().kill("SIGKILL");
    fail(`${invalidReason}; stopped at once.`);
  }
  return { app, page, stopWatching: watchWindows(app, role) };
}

async function closeApp(app: ElectronApplication, role: LaunchCheck["role"], stopWatching: () => void): Promise<void> {
  stopWatching();
  const state = await windowState(app, role, "end").catch(() => null);
  // The window is closed first, while the dialogs are still stubbed: its close guard may ask
  // about unsaved changes, and that question must be recorded before the app quits.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((window) => window.close())).catch(() => undefined);
  // On Linux and Windows the app quits when its last window closes, so the dialogs are read on
  // every pass and the last successful read is kept (review round 2, m3).
  let dialogs: string[] = [];
  for (let waited = 0; waited < 10_000; waited += 200) {
    const seen = await app
      .evaluate(({ BrowserWindow }) => ({ open: BrowserWindow.getAllWindows().length, dialogs: [...((globalThis as unknown as { evalDialogs?: string[] }).evalDialogs ?? [])] }))
      .catch(() => null);
    if (seen === null) break;
    dialogs = seen.dialogs;
    if (seen.open === 0) break;
    await pause(200);
  }
  if (state) {
    const end = { ...state, dialogs };
    launches.push(end);
    // Review S9: a window, the focus or a dialog at the end fails the run; it is never compared or accepted.
    if (showsSomething(end)) invalidReason ??= `at the end the ${role} app had ${describe(end)}`;
  }
  await app.close().catch(() => undefined);
  running.delete(app);
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
  start: unknown;
}

/**
 * Starts one generation through window.aba (a draft, or a judge request) and waits in the
 * page for its "finished": the streamed text, every other event, and the time it took.
 */
function runGeneration(page: Page, kind: "draft" | "judge", input: { caseId: string; sectionId: ReportSectionId; provider: "openai" | "anthropic"; request: unknown }): Promise<RunOutcome> {
  return page.evaluate(
    async ({ kind, input, timeoutMs }) => {
      const api = (globalThis as unknown as { aba: AbaApi }).aba;
      const generationId = crypto.randomUUID();
      const started = performance.now();
      let text = "";
      const events: unknown[] = [];
      const done = new Promise<void>((resolve) => {
        const stop = api.onGenerationUpdate((update) => {
          if (update.generationId !== generationId) return;
          if (update.event.type === "text") text += update.event.delta;
          else events.push(update.event);
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
      return { text, events, seconds: (performance.now() - started) / 1000, start };
    },
    { kind, input, timeoutMs: REQUEST_TIMEOUT_MS },
  ) as Promise<RunOutcome>;
}

/* ---------------------------------------------------------------------------------- */
/* Connecting                                                                          */

async function connect(page: Page, app: ElectronApplication, options: Options): Promise<string | null> {
  if (options.rehearse) {
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
  if (connections.chatgpt.state !== "connected") fail(`ChatGPT is not connected in the eval profile (${connections.chatgpt.state}). Run pnpm eval --sign-in once.`);
  // A free call (the account's model list) proves the sign-in still works before any request is spent.
  const check = await aba(page, (api) => api.checkChatGpt());
  if (check.outcome !== "working") fail(`the ChatGPT sign-in does not work just now (${check.outcome}).`);
  return (await aba(page, (api) => api.getAiPreferences())).models.openai;
}

/* ---------------------------------------------------------------------------------- */
/* One case                                                                            */

const requests = { drafts: 0, checks: 0, judges: 0, repairs: 0, baselineJudges: 0, total: 0 };
let judgeFormat: JudgeFormat | null = null;

/** Makes the case in the app: its sources, her session notes, and her standing instructions for every section (the key's, or cleared). */
async function loadIntoApp(page: Page, loaded: LoadedCase, plan: LoadPlan[], name: string): Promise<string> {
  const created = await aba(page, (api, input) => api.createCase(input as { label: string }), { label: name });
  if (created.outcome !== "created") fail(`could not create the case (${created.outcome}).`);
  const caseId = created.case.id;
  for (const source of plan) {
    if (source.file.endsWith(".pdf")) {
      const bytes = [...readFileSync(path.join(loaded.folder, source.file))];
      const added = await aba(page, (api, input) => {
        const { caseId: id, name: file, data } = input as { caseId: string; name: string; data: number[] };
        return api.addDroppedPdf(id, { name: file, data: new Uint8Array(data) });
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
  // Review S3: the eval profile is kept between runs, so every section's instructions are set (or cleared) for each case.
  for (const [section, text] of Object.entries(instructionsFor(loaded))) {
    const saved = await aba(page, (api, input) => {
      const { caseId: id, section: s, text: t } = input as { caseId: string; section: ReportSectionId; text: string };
      return api.saveSectionInstructions(id, s, t);
    }, { caseId, section, text });
    if (saved.outcome !== "saved") fail(`could not set the standing instructions of ${section}.`);
  }
  return caseId;
}

interface Drafted {
  version: number | null;
  error: string | null;
  seconds: number;
}

async function draftSections(page: Page, caseId: string, options: Options): Promise<Map<ReportSectionId, Drafted>> {
  const drafted = new Map<ReportSectionId, Drafted>();
  for (const { id } of REPORT_SECTIONS) {
    process.stdout.write(`  draft ${id} ... `);
    requests.drafts++;
    requests.total++;
    let outcome = await runGeneration(page, "draft", { caseId, sectionId: id, provider: options.provider, request: { kind: "draft" } });
    const firstError = outcome.events.find((event) => event.type === "error") as { code: string; message: string } | undefined;
    if (firstError && TRANSIENT.test(`${firstError.code} ${firstError.message}`)) {
      process.stdout.write(`(${firstError.code}; trying once more in ${RETRY_PAUSE_MS / 1000} s) `);
      await pause(RETRY_PAUSE_MS);
      requests.drafts++;
      requests.total++;
      outcome = await runGeneration(page, "draft", { caseId, sectionId: id, provider: options.provider, request: { kind: "draft" } });
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
    drafted.set(id, { version, error: why, seconds: outcome.seconds });
    console.log(why ? `FAILED (${why})` : `v${version} in ${outcome.seconds.toFixed(1)} s${sentCheck ? ", checked" : ""}`);
    if (error && STOPPING.test(error.code)) fail(`stopped: ${error.message}`);
    if (options.mode === "chained" && version !== null) {
      const approved = await aba(page, (api, input) => {
        const { caseId: c, id: s, version: v } = input as { caseId: string; id: ReportSectionId; version: number };
        return api.approveSection(c, s, v);
      }, { caseId, id, version });
      if (approved.outcome !== "saved") fail(`could not approve ${id} v${version}.`);
    }
  }
  return drafted;
}

/** Puts a run's drafts in place in the case as her text, so the judge reads them as the current versions. */
async function putDrafts(page: Page, caseId: string, sections: readonly SectionResult[]): Promise<void> {
  for (const section of sections) {
    if (section.text === null) continue;
    const saved = await aba(page, (api, input) => {
      const { caseId: c, id, text } = input as { caseId: string; id: ReportSectionId; text: string };
      return api.saveSectionText(c, id, text, null);
    }, { caseId, id: section.id, text: section.text });
    if (saved.outcome !== "saved") fail(`could not put back the draft of ${section.id}.`);
  }
}

/** The judge's input for one section. Facts that rest on a rule pending her answer are left out: never counted (review S2). */
function judgeInputFor(loaded: LoadedCase, section: ReportSectionId, loadedSources: ReadonlySet<string>, format: JudgeFormat): JudgeInput {
  const key = loaded.key;
  const items = RUBRIC.filter((item) => item.scoredBy === "judge" && item.stage === "body" && item.id !== "key-facts").map((item) => ({ id: item.id, title: item.title, anchors: item.anchors }));
  const caseNotes = [
    ...key.behaviors.map((b) => `Behavior "${b.name}": hypothesized function ${b.functions.primary.join(", ")}${b.functions.secondary.length > 0 ? `; secondary ${b.functions.secondary.join(", ")}` : ""}.`),
    ...key.plantedGaps.map((gap) => `Planted gap: ${gap.gap}`),
    ...key.incidents.filter((incident) => incident.from.every((id) => loadedSources.has(id))).map((incident) => `"${incident.description}" belongs to ${incident.home}; up to ${incident.references} other section(s) may refer to it.`),
  ];
  if (caseNotes.length > 30) console.warn(`    Warning: ${caseNotes.length - 30} case notes left out of the judge's input for ${section} (at most 30).`);
  return {
    rubricVersion: RUBRIC_VERSION,
    items,
    expectations: [...SECTION_EXPECTATIONS[section], ...STYLE_EXPECTATIONS.map((habit) => `Habit: ${habit}`)],
    keyFacts: (key.sectionFacts[section] ?? []).filter((fact) => !fact.provisional && fact.from.every((id) => loadedSources.has(id))).map(({ id, fact }) => ({ id, fact })),
    caseNotes: caseNotes.slice(0, 30),
    payerFacts: [...SECTION_PAYER_FACTS[section]],
    format,
    repair: null,
  };
}

/** The judge's own code, for the fingerprint: a change to its prompt builder is another judge. */
const JUDGE_CODE_HASH = createHash("sha256").update(readFileSync(path.join(ROOT, "src", "lib", "judge.ts"))).digest("hex");

/** What the judge was for one section (see JudgeRecord.fingerprint). The drafts are what it judges, so they are not part of it. */
function judgeFingerprint(input: JudgeInput, loaded: LoadedCase, section: ReportSectionId, model: string | null, samples: number): string {
  const { format: _format, repair: _repair, ...judged } = input;
  void _format;
  void _repair;
  const her = { notes: loaded.key.inputs.notes ?? "", instructions: instructionsFor(loaded)[section] };
  return createHash("sha256").update(JSON.stringify({ JUDGE_PROMPT_VERSION, JUDGE_CODE_HASH, judged, her, model, samples })).digest("hex").slice(0, 32);
}

async function judgeSection(page: Page, caseId: string, loaded: LoadedCase, section: ReportSectionId, loadedSources: ReadonlySet<string>, options: Options, model: string | null, forBaseline: boolean): Promise<JudgeRecord> {
  let input = judgeInputFor(loaded, section, loadedSources, judgeFormat ?? "json-schema");
  const record: JudgeRecord = { format: input.format, repaired: false, answers: [], error: null, requests: 0, seconds: 0, usage: null, fingerprint: judgeFingerprint(input, loaded, section, model, options.samples) };
  const itemIds = input.items.map((item) => item.id);
  const factIds = input.keyFacts.map((fact) => fact.id);
  const count = (repair: boolean) => {
    record.requests++;
    requests.total++;
    if (forBaseline) requests.baselineJudges++;
    else if (repair) requests.repairs++;
    else requests.judges++;
  };
  /** One request; a transient error is retried once after a pause, and both requests' tokens are kept (review M2). */
  const send = async (request: JudgeInput, retried = false): Promise<{ text: string; error: { code: string; message: string } | null }> => {
    count(request.repair !== null);
    const outcome = await runGeneration(page, "judge", { caseId, sectionId: section, provider: options.provider, request });
    record.seconds += outcome.seconds;
    const done = outcome.events.find((event) => event.type === "done") as { usage: Usage; complete: boolean } | undefined;
    if (done) record.usage = addUsage(record.usage, done.usage);
    const error = outcome.events.find((event) => event.type === "error") as { code: string; message: string } | undefined;
    const start = outcome.start as { outcome: string };
    if (error && TRANSIENT.test(`${error.code} ${error.message}`) && !retried) {
      process.stdout.write(`(${error.code}; trying once more in ${RETRY_PAUSE_MS / 1000} s) `);
      await pause(RETRY_PAUSE_MS);
      return send(request, true);
    }
    return { text: outcome.text, error: start.outcome !== "started" ? { code: start.outcome, message: `not started: ${start.outcome}` } : (error ?? (done?.complete ? null : { code: "incomplete", message: "the answer was cut short" })) };
  };
  for (let sample = 0; sample < options.samples; sample++) {
    let answer = await send(input);
    // Until one judge answer has come back, the route's support of the JSON schema is unverified.
    // A refusal (a 400, "unsupported", or an error the stream reports that is not transient and
    // survived its retry; review M3) switches the run to plain JSON.
    const refused = answer.error && (/bad_request|chatgpt_unsupported/.test(answer.error.code) || (judgeFormat === null && /provider_error|stream_error/.test(answer.error.code) && !TRANSIENT.test(answer.error.message)));
    if (refused && input.format === "json-schema") {
      console.log(`    the route refused the JSON-schema format (${answer.error!.message.slice(0, 160)}); using plain JSON with validation from now on.`);
      judgeFormat = "plain-json";
      record.format = "plain-json";
      input = { ...input, format: "plain-json" };
      answer = await send(input);
    }
    if (answer.error) {
      record.error = `${answer.error.code}: ${answer.error.message}`;
      if (STOPPING.test(answer.error.code)) fail(`stopped: ${answer.error.message}`);
      continue;
    }
    if (judgeFormat === null) judgeFormat = record.format;
    let parsed = parseJudgeAnswer(answer.text, section, itemIds, factIds);
    if (!parsed.ok) {
      record.repaired = true;
      const repaired = await send({ ...input, repair: { previousAnswer: answer.text.slice(0, 60_000), problems: parsed.problems.slice(0, 30) } });
      if (repaired.error) {
        record.error = `repair failed: ${repaired.error.code}: ${repaired.error.message}`;
        continue;
      }
      parsed = parseJudgeAnswer(repaired.text, section, itemIds, factIds);
    }
    if (parsed.ok) record.answers.push(parsed.answer as JudgeAnswer);
    else record.error = `no valid answer after one repair: ${parsed.problems.slice(0, 3).join(" ")}`;
  }
  if (record.answers.length === options.samples) record.error = null;
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

/** Every check on a case's section texts, with that case's sources and her inputs as the number index. */
function checkCase(loaded: LoadedCase, plan: LoadPlan[], loadedSources: ReadonlySet<string>, texts: Partial<Record<ReportSectionId, string>>, examples: readonly string[]): Finding[] {
  const shapes = Object.fromEntries(REPORT_SECTIONS.map(({ id }) => [id, SECTION_SHAPES[id] ?? { paragraphs: null, words: null }]));
  // The model also sees each source's title and date (src/main/outgoing.ts, outgoingSourceTitle).
  const index = numberIndex([...plan.map((source) => `${source.title} ${source.date ?? ""}\n${source.text}`), loaded.key.inputs.notes ?? "", ...Object.values(instructionsFor(loaded))]);
  return runChecks(texts, { key: loaded.key, numbers: index, shapes, examples, loadedSources, numberedListsAllowed: NUMBERED_LISTS_ALLOWED });
}

/* ---------------------------------------------------------------------------------- */
/* The run                                                                             */

/**
 * The baseline as an earlier run compared it (its baseline-as-compared.json): the accepted
 * baseline's stored drafts with that run's checks and judge records. Its judge records are
 * reused only where their fingerprint is this judge's; every other section is judged again and
 * every draft is checked again, as for any baseline. It is named after the accepted baseline
 * and the run, so the summary says which drafts the baseline arm is.
 */
function baselineAsCompared(runDir: string, rehearsal: boolean): { name: string; run: RunResult } {
  const dir = path.resolve(runDir);
  const file = path.join(dir, "baseline-as-compared.json");
  if (!existsSync(file)) fail(`no ${file}: --baseline-run takes a run folder that was compared with a baseline.`);
  const comparison = JSON.parse(readFileSync(path.join(dir, "comparison.json"), "utf8")) as { baseline?: string };
  const run = normalizeRun(JSON.parse(readFileSync(file, "utf8")));
  if (run.provider.startsWith("rehearsal") !== rehearsal) fail("--baseline-run takes a run of the same kind (real or rehearsal).");
  // Short: the name goes into a case label in the judge app, which takes a limited length.
  return { name: rejudgedBaselineName(comparison.baseline), run };
}

/** The baseline named, or the newest accepted one of the same kind (real or rehearsal), read as this version reads results. */
function findBaseline(name: string | null, rehearsal: boolean): { name: string; run: RunResult } | null {
  if (!existsSync(BASELINES_DIR)) return null;
  const read = (dir: string) => normalizeRun(JSON.parse(readFileSync(path.join(BASELINES_DIR, dir, "results.json"), "utf8")));
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

async function main(options: Options, home: string, profile: string): Promise<number> {
  const { prior } = options;
  const cases = selectedCases(prior);
  const startedAt = new Date().toISOString();
  if (args.baseline && args["baseline-run"]) fail("--baseline and --baseline-run name two baselines: give one.");
  const baseline = args["baseline-run"] ? baselineAsCompared(args["baseline-run"], options.rehearse) : findBaseline(args.baseline ?? null, options.rehearse);
  console.log(
    `Evaluation run ${options.label}: ${cases.map((c) => c.key.caseId).join(", ")}; ${options.runs} run(s) per case; ${options.mode} drafting; ${options.samples} judge sample(s) per run; ${options.rehearse ? "REHEARSAL with a fake provider (no request leaves the computer)" : "ChatGPT sign-in of the eval profile"}${prior ? `; drafts from run ${prior.label} (${options.rejudgeAll ? "every section judged again" : "judged where this judge has no answer"})` : ""}${baseline ? `; baseline ${baseline.name}` : ""}.`,
  );

  if (!prior) build(options.draftCheckout);
  if (prior || options.draftCheckout !== ROOT) build(ROOT);
  const examples = examplesOf(prior ? ROOT : options.draftCheckout);

  const caseResults: CaseResult[] = [];
  /** The baseline's judge records, run by run, judged again in this run where its judge differs (review B3). */
  const baselineJudged = new Map<string, Array<Map<ReportSectionId, JudgeRecord>>>();
  /** The current checks' findings on every stored run of the baseline. */
  const baselineFindings = new Map<string, Finding[][]>();
  let model: string | null = prior?.model ?? null;
  let judgeModel: string | null = null;
  let rulesVersions: Record<string, string> | null = prior?.drafting.rulesVersions ?? null;

  /** The run as recorded: the final one, or a partial one saved as the run goes (results.json, resumable with --from-run). */
  const buildRun = (caseList: CaseResult[], versions: Record<string, string> | null, partial = false): RunResult => {
    const judging = checkoutRecord(ROOT);
    return {
    resultsVersion: RESULTS_VERSION,
    label: options.label,
    startedAt,
    finishedAt: new Date().toISOString(),
    rubricVersion: RUBRIC_VERSION,
    judgePromptVersion: JUDGE_PROMPT_VERSION,
    checksVersion: CHECKS_VERSION,
    runs: options.runs,
    judgeSamples: options.samples,
    drafting: prior ? prior.drafting : { ...checkoutRecord(options.draftCheckout), rulesVersions: versions ?? {} },
    judging: { ...judging, model: judgeModel },
    provider: prior ? prior.provider : options.rehearse ? "rehearsal (fake provider)" : "openai (ChatGPT sign-in)",
    model,
    mode: options.mode,
    judgeFormat: judgeFormat ?? prior?.judgeFormat ?? null,
    requests: prior
      ? {
          drafts: prior.requests.drafts + requests.drafts,
          checks: prior.requests.checks + requests.checks,
          judges: prior.requests.judges + requests.judges,
          repairs: prior.requests.repairs + requests.repairs,
          baselineJudges: prior.requests.baselineJudges + requests.baselineJudges,
          total: prior.requests.total + requests.total,
        }
      : requests,
    launches: [...(prior?.launches ?? []), ...launches],
    windowChecksDuring,
    valid: invalidReason === null && (prior?.valid ?? true),
    invalidReason: invalidReason ?? prior?.invalidReason ?? null,
    ...(prior ? { fromRun: prior.label, rejudged: options.rejudgeAll } : {}),
    ...(partial ? { partial: true } : {}),
    cases: caseList,
    };
  };
  /** Writes results.json as the run goes, so a run that fails late keeps every draft and judge answer already paid for. */
  const savePartialRun = (caseList: CaseResult[], madeNow: ReadonlyArray<{ texts: Map<ReportSectionId, { detail: unknown }> }>) => {
    let versions = rulesVersions;
    if (!versions) {
      versions = {};
      for (const { texts } of madeNow) for (const { detail } of texts.values()) Object.assign(versions, (detail as { generation?: { rulesVersions?: Record<string, string> } } | undefined)?.generation?.rulesVersions ?? {});
    }
    mkdirSync(options.runDir, { recursive: true });
    writeFileSync(path.join(options.runDir, "results.json"), JSON.stringify(buildRun(caseList, versions, true), null, 2));
  };
  /** Every judge answer on the baseline's drafts so far, saved as each one comes (baseline-judged.json), for a resumed run to reuse. */
  const savedBaselineJudges: SavedBaselineJudge[] = [];
  const priorBaselineJudges: SavedBaselineJudge[] =
    options.priorDir && !options.rejudgeAll && existsSync(path.join(options.priorDir, "baseline-judged.json"))
      ? (JSON.parse(readFileSync(path.join(options.priorDir, "baseline-judged.json"), "utf8")) as SavedBaselineJudge[])
      : [];
  const saveBaselineJudge = (entry: SavedBaselineJudge) => {
    savedBaselineJudges.push(entry);
    mkdirSync(options.runDir, { recursive: true });
    writeFileSync(path.join(options.runDir, "baseline-judged.json"), JSON.stringify(savedBaselineJudges, null, 2));
  };
  const textHash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 32);

  for (const loaded of cases) {
    console.log(`\n${loaded.key.caseId}`);
    const plan = sourcePlan(loaded);
    const loadedSources = new Set([...plan.map((source) => source.id), ...(loaded.key.inputs.notes ? ["notes"] : [])]);
    const priorCase = prior ? (prior.cases.find((c) => c.caseId === loaded.key.caseId) ?? fail(`the run ${prior.label} has no case ${loaded.key.caseId}.`)) : null;
    const baseCase = baseline?.run.cases.find((c) => c.caseId === loaded.key.caseId) ?? null;
    const runCount = priorCase ? priorCase.runs.length : options.runs;
    const runName = (r: number) => (runCount > 1 ? `run ${r + 1} ` : "");

    // Every run drafts the case fully, chained, as a case of its own in the app under test.
    // With --from-run or --rejudge, each of the earlier run's runs has its drafts put in place instead.
    let current = await launch(priorCase ? ROOT : options.draftCheckout, priorCase ? "judge" : "draft", profile, home);
    const made: Array<{ caseId: string; drafted: Map<ReportSectionId, Drafted>; texts: Map<ReportSectionId, { version: number; text: string; detail: unknown }> }> = [];
    try {
      const connected = await connect(current.page, current.app, options);
      if (!priorCase) model = connected;
      judgeModel = connected;
      for (let r = 0; r < runCount; r++) {
        if (runCount > 1) console.log(`  run ${r + 1} of ${runCount}`);
        const caseId = await loadIntoApp(current.page, loaded, plan, `${loaded.key.child.fullName} (evaluation ${options.label.slice(0, 19)}, run ${r + 1})`);
        let drafted = new Map<ReportSectionId, Drafted>();
        if (priorCase) await putDrafts(current.page, caseId, priorCase.runs[r].sections);
        else drafted = await draftSections(current.page, caseId, options);
        const texts = await currentTexts(current.page, caseId);
        const recorded = recordedVersions(home, caseId);
        for (const [id, entry] of texts) {
          const stored = recorded.get(id)?.get(entry.version);
          if (stored) entry.detail = stored;
        }
        made.push({ caseId, drafted, texts });
      }
    } finally {
      if (!priorCase && options.draftCheckout !== ROOT) await closeApp(current.app, "draft", current.stopWatching);
    }

    /** This case's record from what is drafted and judged so far (the final one, or a partial one saved as it goes). */
    const recordCase = (madeNow: typeof made, judgedNow: ReadonlyArray<Map<ReportSectionId, JudgeRecord>>): CaseResult => {
      const caseRuns: CaseRun[] = madeNow.map(({ texts, drafted }, r): CaseRun => {
        const sectionTexts = Object.fromEntries([...texts].map(([id, entry]) => [id, entry.text])) as Partial<Record<ReportSectionId, string>>;
        const findings = checkCase(loaded, plan, loadedSources, sectionTexts, examples);
        const sections: SectionResult[] = REPORT_SECTIONS.map(({ id }): SectionResult => {
          const entry = texts.get(id) ?? null;
          const detail = entry?.detail as { generation?: { usage?: Usage; servedModel?: string; rulesVersions?: Record<string, string> }; consistency?: { status: string; items: string[] } | null } | undefined;
          const mine = findings.filter((finding) => finding.section === id);
          const judge = judgedNow[r]?.get(id) ?? null;
          const before = priorCase?.runs[r].sections.find((section) => section.id === id) ?? null;
          if (before) return { ...before, findings: mine, scores: scoreSection(id, mine, judge?.answers ?? [], before.text !== null), judge };
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
            scores: scoreSection(id, mine, judge?.answers ?? [], entry !== null),
            judge,
          };
        });
        return { run: r + 1, sections };
      });
      const keyNotes = [
        ...loaded.key.incidents.filter((incident) => incident.provisional && incident.from.every((id) => loadedSources.has(id))).map((incident) => `"${incident.description}" belongs to ${incident.home} (step 0's section map)`),
        ...Object.entries(loaded.key.sectionFacts).flatMap(([section, facts]) => (facts ?? []).filter((fact) => fact.provisional).map((fact) => `fact ${fact.id} (${section}) is not scored: it rests on her standard practice`)),
      ];
      return { caseId: loaded.key.caseId, keyVersion: loaded.key.keyVersion, sourcesLoaded: [...loadedSources], inputs: { notes: loaded.key.inputs.notes ?? "", instructions: instructionsFor(loaded) }, keyNotes, runs: caseRuns, medians: caseMedians(caseRuns) };
    };
    /** Saves results.json with every case so far, so a failure later in the run loses no request already spent (resume with --from-run). */
    const savePartial = (judgedNow: ReadonlyArray<Map<ReportSectionId, JudgeRecord>>) => savePartialRun([...caseResults, recordCase(made, judgedNow)], made);
    savePartial([]);

    // Judge with this branch's app (the same one when no --draft-app was given).
    if (!priorCase && options.draftCheckout !== ROOT) {
      current = await launch(ROOT, "judge", profile, home);
      if (options.rehearse) await installRehearsalProvider(current.app);
      else judgeModel = (await aba(current.page, (api) => api.getAiPreferences())).models.openai;
      for (const { caseId } of made) {
        const opened = await aba(current.page, (api, id) => api.openCase(id as string), caseId);
        if (opened.outcome !== "opened") fail(`the judge app could not open the case (${opened.outcome}).`);
      }
    }
    const judgedRuns: Array<Map<ReportSectionId, JudgeRecord>> = [];
    try {
      for (const [r, { caseId, texts }] of made.entries()) {
        const judged = new Map<ReportSectionId, JudgeRecord>();
        for (const { id } of REPORT_SECTIONS) {
          if (!texts.has(id)) continue;
          const earlier = priorCase?.runs[r].sections.find((section) => section.id === id)?.judge ?? null;
          const fingerprint = judgeFingerprint(judgeInputFor(loaded, id, loadedSources, "json-schema"), loaded, id, judgeModel, options.samples);
          // --from-run keeps an answer of this same judge; --rejudge always judges again.
          if (keepsEarlierJudge(earlier, fingerprint, options.samples, options.rejudgeAll)) {
            judged.set(id, earlier);
            continue;
          }
          process.stdout.write(`  ${runName(r)}judge ${id} ... `);
          const record = await judgeSection(current.page, caseId, loaded, id, loadedSources, options, judgeModel, false);
          judged.set(id, record);
          console.log(record.error ? `FAILED (${record.error})` : `${record.format}${record.repaired ? ", repaired" : ""}, ${record.seconds.toFixed(1)} s`);
        }
        judgedRuns.push(judged);
        savePartial(judgedRuns);
      }

      // Review B3: every run of the baseline is checked again with the current checks, and its
      // drafts are judged again by this same judge where its judgement came from another one.
      if (baseCase) {
        const records: Array<Map<ReportSectionId, JudgeRecord>> = [];
        const findings: Finding[][] = [];
        for (const baseRun of baseCase.runs) {
          const stale = baseRun.sections.filter((section) => {
            if (section.text === null) return false;
            const fingerprint = judgeFingerprint(judgeInputFor(loaded, section.id, loadedSources, "json-schema"), loaded, section.id, judgeModel, options.samples);
            return section.judge?.fingerprint !== fingerprint || (section.judge?.answers.length ?? 0) < options.samples;
          });
          const rejudged = new Map<ReportSectionId, JudgeRecord>();
          // A resumed run (--from-run) reuses what the run it resumes already paid for on these same drafts (finding 11).
          const toJudge = stale.filter((section) => {
            const wanted = { baseline: baseline!.name, caseId: loaded.key.caseId, run: baseRun.run, section: section.id, textHash: textHash(section.text as string) };
            const fingerprint = judgeFingerprint(judgeInputFor(loaded, section.id, loadedSources, "json-schema"), loaded, section.id, judgeModel, options.samples);
            const reused = reusableBaselineJudge(priorBaselineJudges, { ...wanted, fingerprint, samples: options.samples });
            if (!reused) return true;
            rejudged.set(section.id, reused);
            saveBaselineJudge({ ...wanted, record: reused });
            return false;
          });
          if (stale.length > toJudge.length) console.log(`  the baseline's run ${baseRun.run}: ${stale.length - toJudge.length} answer(s) reused from run ${prior?.label ?? "unknown"}`);
          if (toJudge.length > 0) {
            console.log(`  the baseline's run ${baseRun.run} was judged by another judge: judging ${toJudge.length} of its drafts again with this one`);
            const baseCaseId = await loadIntoApp(current.page, loaded, plan, baselineCaseLabel(loaded.key.child.fullName, baseline!.name, baseRun.run, MAX_CASE_LABEL_LENGTH));
            await putDrafts(current.page, baseCaseId, baseRun.sections);
            for (const section of toJudge) {
              process.stdout.write(`  judge baseline run ${baseRun.run} ${section.id} ... `);
              const record = await judgeSection(current.page, baseCaseId, loaded, section.id, loadedSources, options, judgeModel, true);
              rejudged.set(section.id, record);
              if (record.error === null) saveBaselineJudge({ baseline: baseline!.name, caseId: loaded.key.caseId, run: baseRun.run, section: section.id, textHash: textHash(section.text as string), record });
              console.log(record.error ? `FAILED (${record.error})` : `${record.format}, ${record.seconds.toFixed(1)} s`);
            }
          }
          records.push(rejudged);
          const baseTexts = Object.fromEntries(baseRun.sections.filter((s) => s.text !== null).map((s) => [s.id, s.text as string])) as Partial<Record<ReportSectionId, string>>;
          findings.push(checkCase(loaded, plan, loadedSources, baseTexts, examples));
        }
        baselineJudged.set(loaded.key.caseId, records);
        baselineFindings.set(loaded.key.caseId, findings);
      }
    } finally {
      await closeApp(current.app, priorCase || options.draftCheckout !== ROOT ? "judge" : "draft", current.stopWatching);
    }

    // The checks, the scores, the record of every run.
    caseResults.push(recordCase(made, judgedRuns));
    if (!rulesVersions) {
      rulesVersions = {};
      for (const { texts } of made) for (const { detail } of texts.values()) Object.assign(rulesVersions, (detail as { generation?: { rulesVersions?: Record<string, string> } }).generation?.rulesVersions ?? {});
    }
  }

  const run = buildRun(caseResults, rulesVersions);

  // The baseline as this run's checks and judge see it (review B3), then the comparison.
  let comparedBaseline: RunResult | null = null;
  if (baseline) {
    comparedBaseline = rescoreRun(baseline.run, baselineFindings);
    for (const c of comparedBaseline.cases) {
      const records = baselineJudged.get(c.caseId);
      if (!records) continue;
      c.runs.forEach((r, index) => {
        for (const s of r.sections) {
          const record = records[index]?.get(s.id);
          if (!record) continue;
          s.judge = record;
          s.scores = scoreSection(s.id, s.findings, record.answers, s.text !== null);
        }
      });
      c.medians = caseMedians(c.runs);
    }
    // A baseline of another rubric version is compared only when this run checked and judged every one of its drafts again.
    comparedBaseline = adoptRubricWhenRescored(comparedBaseline, run, baselineJudged);
  }
  const comparison = comparedBaseline ? compareRuns(run, comparedBaseline) : null;
  const summary = summaryMarkdown(run, comparison, baseline?.name ?? null, comparedBaseline);
  mkdirSync(options.runDir, { recursive: true });
  writeFileSync(path.join(options.runDir, "results.json"), JSON.stringify(run, null, 2));
  writeFileSync(path.join(options.runDir, "summary.md"), summary);
  if (comparison) {
    writeFileSync(path.join(options.runDir, "comparison.json"), JSON.stringify({ baseline: baseline!.name, ...comparison }, null, 2));
    writeFileSync(path.join(options.runDir, "baseline-as-compared.json"), JSON.stringify(comparedBaseline, null, 2));
  }
  for (const c of caseResults) {
    for (const r of c.runs) {
      const folder = path.join(options.runDir, "drafts", c.caseId, `run-${r.run}`);
      mkdirSync(folder, { recursive: true });
      for (const s of r.sections) if (s.text !== null) writeFileSync(path.join(folder, `${s.id}.txt`), s.text);
    }
  }
  if (args.accept) accept(run, args.accept, summary);
  console.log(`\n${summary.split("\n").slice(0, 3).join("\n")}`);
  if (prior) console.log(`This run made ${requests.total} new requests (${requests.judges} judge, ${requests.repairs} repairs, ${requests.baselineJudges} on the baseline's drafts).`);
  console.log(`\nResults: ${path.relative(ROOT, options.runDir)}/ (results.json, summary.md, drafts/<case>/run-<n>/).`);
  return exitCodeFor(comparison, run);
}

/** Saves a run as an accepted baseline: never an invalid or incomplete run or one from a dirty checkout, and never with a local path (review B4, S9, S10; 3-run review S1). */
function accept(run: RunResult, name: string, summary: string): void {
  if (!run.valid) fail(`an invalid run is never accepted (${run.invalidReason}).`);
  if (run.partial) fail("a partial run (saved while it was still going) is never accepted.");
  if (run.drafting.dirty || run.judging.dirty) fail("a run from a checkout with uncommitted changes in rules/, src/ or eval/ is never accepted: commit them and run again.");
  // Review S1 (3-run evaluation): a run with a failed draft, a judge error or an unscored item never becomes the bar.
  const incomplete = incompleteParts(run);
  if (incomplete.length > 0) fail(`a run with a failed draft, a judge error or an unscored item is never accepted; fill it with --from-run (a missing judge answer) or run again (a failed draft) before accepting: ${incomplete.slice(0, 5).join("; ")}${incomplete.length > 5 ? `; and ${incomplete.length - 5} more` : ""}.`);
  const copy = baselineCopy(run, { home: homedir(), user: userInfo().username });
  const target = path.join(BASELINES_DIR, name);
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, "results.json"), `${JSON.stringify(copy, null, 2)}\n`);
  writeFileSync(path.join(target, "summary.md"), summary);
  console.log(`Accepted as the baseline eval/baselines/${name} (commit it).`);
}

/* Start, and always clean up. */
let options: Options;
try {
  options = readOptions();
} catch (error) {
  console.error(`pnpm eval: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
const profile = options.rehearse ? mkdtempSync(path.join(tmpdir(), "aba-eval-rehearsal-profile-")) : EVAL_PROFILE;
ownerOnlyFolder(profile);
if (!existsSync(path.join(profile, "settings.json"))) writeFileSync(path.join(profile, "settings.json"), JSON.stringify({ version: 1, language: "en" }), { mode: 0o600 });
const home = mkdtempSync(path.join(tmpdir(), "aba-eval-home-"));
ownerOnlyFolder(home);
let code = 1;
try {
  code = await main(options, home, profile);
} catch (error) {
  // code stays 1.
  console.error(error instanceof EvalFailure ? `pnpm eval: ${error.message}` : error instanceof Error ? (error.stack ?? error.message) : error);
} finally {
  for (const app of running) await app.close().catch(() => app.process().kill("SIGKILL"));
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  if (options.rehearse) rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
process.exitCode = code;
