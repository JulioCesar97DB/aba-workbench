/*
 * pnpm map-verify: one "Draft the map" through the real app, hidden, on an invented case
 * (step 1, pull request 2; the owner's decision D33). It starts the built app with
 * --hidden (no window shown, no Dock icon, never the focus; checked at launch, every few
 * seconds and at the end, as pnpm eval does), creates the case through window.aba as she
 * would, and asks for the draft. It writes what happened to eval-results/map-verify-<time>/:
 * the format the route took, the repairs, the problems the checks left, the tokens, and the
 * map itself (invented data only).
 *
 *   pnpm build && pnpm map-verify                 a real draft on the ChatGPT sign-in of the eval profile
 *   pnpm build && pnpm map-verify --rehearse      the same with a fake provider: nothing leaves the computer
 *   --case case-b-sofia                           the invented case (default; behaviors.md is left out: raw behaviors only)
 *
 * Requests on the real route: 2 (the facts, then the behaviors); at most 6 if both are
 * asked again as plain JSON and both need their one repair.
 */
import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import type { AbaApi, GenerationUpdateEvent } from "../src/shared/api.ts";
import { installRehearsalProvider, REHEARSAL_CLAUDE_KEY } from "../eval/rehearsal.ts";

const { values: args } = parseArgs({ options: { case: { type: "string", default: "case-b-sofia" }, rehearse: { type: "boolean", default: false } } });
const root = process.cwd();
const WINDOW_CHECK_MS = 5_000;
const DRAFT_TIMEOUT_MS = 20 * 60 * 1000;

function fail(message: string): never {
  console.error(`map-verify: ${message}`);
  process.exit(1);
}

let stoppedBecause: string | null = null;

async function windowState(app: ElectronApplication) {
  return app.evaluate(({ app: electronApp, BrowserWindow }) => ({
    visibleWindows: BrowserWindow.getAllWindows().filter((window) => window.isVisible()).length,
    focusedWindows: BrowserWindow.getAllWindows().filter((window) => window.isFocused()).length,
    dockVisible: electronApp.dock ? electronApp.dock.isVisible() : null,
    dialogs: [...((globalThis as unknown as { evalDialogs?: string[] }).evalDialogs ?? [])],
  }));
}
const showsSomething = (state: Awaited<ReturnType<typeof windowState>>) => state.visibleWindows > 0 || state.focusedWindows > 0 || state.dockVisible === true || state.dialogs.length > 0;

async function stubDialogs(app: ElectronApplication) {
  await app.evaluate(({ dialog }) => {
    const g = globalThis as unknown as { evalDialogs: string[] };
    g.evalDialogs = [];
    dialog.showMessageBox = (async () => {
      g.evalDialogs.push("a message box");
      return { response: 1, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
    dialog.showMessageBoxSync = (() => {
      g.evalDialogs.push("a message box");
      return 1;
    }) as typeof dialog.showMessageBoxSync;
    dialog.showErrorBox = (() => {
      g.evalDialogs.push("an error box");
    }) as typeof dialog.showErrorBox;
  });
}

/** A key's date ("07/30/2026") as the app's date field stores it ("2026-07-30"). */
function isoDate(date: string | undefined): string | undefined {
  const match = date ? /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(date) : null;
  return match ? `${match[3]}-${match[1]}-${match[2]}` : undefined;
}

function aba<T>(page: Page, call: (api: AbaApi, input: unknown) => Promise<T>, input?: unknown): Promise<T> {
  return page.evaluate(`(${call.toString()})(globalThis.aba, ${JSON.stringify(input ?? null)})`) as Promise<T>;
}

const caseFolder = path.join(root, "fixtures", "cases", args.case!);
const caseJson = JSON.parse(readFileSync(path.join(caseFolder, "case.json"), "utf8")) as { sources: Array<{ id: string; title: string; file: string }> };
const keyJson = JSON.parse(readFileSync(path.join(caseFolder, "key.json"), "utf8")) as { sources: Array<{ id: string; type: string; date?: string }>; inputs?: { notes?: string } };
try {
  readdirSync(path.join(root, "out", "main"));
} catch {
  fail("build the app first: pnpm build");
}

const profile = args.rehearse ? mkdtempSync(path.join(tmpdir(), "aba-map-verify-profile-")) : path.join(homedir(), ".aba-workbench-eval", "profile");
const home = mkdtempSync(path.join(tmpdir(), "aba-map-verify-home-"));
const env = Object.fromEntries(Object.entries(process.env).filter(([name, value]) => name !== "ELECTRON_RENDERER_URL" && value !== undefined)) as Record<string, string>;
const app = await electron.launch({ args: [root, `--user-data-dir=${profile}`, `--home-folder=${home}`, "--hidden"], cwd: root, env });
const cleanUp = async () => {
  clearInterval(watch);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((window) => window.close())).catch(() => undefined);
  await app.close().catch(() => undefined);
  rmSync(home, { recursive: true, force: true });
  if (args.rehearse) rmSync(profile, { recursive: true, force: true });
};
await stubDialogs(app);
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((window) => window.setIgnoreMouseEvents(true)));
const page = await app.firstWindow();
await page.waitForFunction(() => typeof (globalThis as unknown as { aba?: unknown }).aba === "object");
const atLaunch = await windowState(app);
console.log(`Started the app hidden: ${atLaunch.visibleWindows} visible windows, Dock ${atLaunch.dockVisible === null ? "n/a" : atLaunch.dockVisible ? "VISIBLE" : "hidden"}, ${atLaunch.focusedWindows} focused.`);
if (showsSomething(atLaunch)) {
  app.process().kill("SIGKILL");
  fail("the app showed something at launch; stopped at once.");
}
const watch = setInterval(() => {
  void windowState(app)
    .then((state) => {
      if (!showsSomething(state)) return;
      stoppedBecause = "the app showed a window, its Dock icon, took the focus or asked for a dialog";
      console.error(`STOPPED: ${stoppedBecause}.`);
      app.process().kill("SIGKILL");
    })
    .catch(() => undefined);
}, WINDOW_CHECK_MS);

let provider: "openai" | "anthropic" = "openai";
if (args.rehearse) {
  await installRehearsalProvider(app);
  const saved = await aba(page, (api, key) => api.saveClaudeKey(key as string), REHEARSAL_CLAUDE_KEY);
  if ((saved as { outcome: string }).outcome !== "saved") fail("the rehearsal could not connect its fake provider.");
  provider = "anthropic";
} else {
  const connections = await aba(page, (api) => api.getConnections());
  if (connections.chatgpt.state !== "connected") {
    await cleanUp();
    fail(`ChatGPT is not connected in the eval profile (${connections.chatgpt.state}). Sign in once with pnpm eval --sign-in.`);
  }
}

// The invented case, as she would make it; behaviors.md (ready-made definitions) is left out: raw behaviors only.
const created = await aba(page, (api, label) => api.createCase({ label: label as string, clientAge: null }), `Map verify, ${args.case} (invented)`);
if ((created as { outcome: string }).outcome !== "created") fail(`could not create the case (${JSON.stringify(created)}).`);
const caseId = (created as unknown as { case: { id: string } }).case.id;
for (const source of caseJson.sources) {
  if (source.file === "behaviors.md") continue;
  const load = keyJson.sources.find((entry) => entry.id === source.id);
  if (!load) continue;
  if (source.file.endsWith(".pdf")) {
    const bytes = [...readFileSync(path.join(caseFolder, source.file))];
    const added = await aba(page, (api, input) => {
      const { caseId: id, name, data } = input as { caseId: string; name: string; data: number[] };
      return api.addDroppedPdf(id, { name, data: new Uint8Array(data) });
    }, { caseId, name: source.file, data: bytes });
    const done = added as { outcome: string; added?: string[] };
    if (done.outcome !== "done" || done.added?.length !== 1) fail(`could not add ${source.file}.`);
    await aba(page, (api, input) => {
      const { caseId: id, sourceId, change } = input as { caseId: string; sourceId: string; change: never };
      return api.changeSource(id, sourceId, change);
    }, { caseId, sourceId: done.added[0], change: { type: load.type, title: source.title, ...(isoDate(load.date) ? { date: isoDate(load.date) } : {}) } });
  } else {
    const added = await aba(page, (api, input) => {
      const { caseId: id, source: s } = input as { caseId: string; source: never };
      return api.addTextSource(id, s);
    }, { caseId, source: { type: load.type, title: source.title, ...(isoDate(load.date) ? { date: isoDate(load.date) } : {}), text: readFileSync(path.join(caseFolder, source.file), "utf8") } });
    if ((added as { outcome: string }).outcome !== "saved") fail(`could not add ${source.file}.`);
  }
}
if (keyJson.inputs?.notes) await aba(page, (api, input) => api.saveSessionNotes((input as { caseId: string }).caseId, (input as { notes: string }).notes), { caseId, notes: keyJson.inputs.notes });

console.log(`Drafting the map with ${provider === "openai" ? "ChatGPT (eval profile)" : "the rehearsal's fake provider"}…`);
const outcome = (await page.evaluate(
  async ({ caseId: id, provider: chosen, timeoutMs }) => {
    const api = (globalThis as unknown as { aba: AbaApi }).aba;
    const generationId = crypto.randomUUID();
    const started = performance.now();
    const events: unknown[] = [];
    const done = new Promise<void>((resolve) => {
      const stop = api.onGenerationUpdate((update) => {
        if (update.generationId !== generationId) return;
        if (update.event.type !== "text") events.push(update.event);
        if (update.event.type === "finished") {
          stop();
          resolve();
        }
      });
      setTimeout(() => void api.cancelGeneration(generationId), timeoutMs);
    });
    const start = await api.startMapDraft(id, generationId, chosen);
    if (start.outcome === "started") await done;
    return { start, events, seconds: (performance.now() - started) / 1000 };
  },
  { caseId, provider, timeoutMs: DRAFT_TIMEOUT_MS },
)) as { start: { outcome: string }; events: GenerationUpdateEvent[]; seconds: number };

const atEnd = await windowState(app).catch(() => null);
const folders = readdirSync(path.join(home, "ABA Workbench"));
const data = JSON.parse(readFileSync(path.join(home, "ABA Workbench", folders[0], "aba-case.json"), "utf8"));
await cleanUp();

const map = data.caseMap ?? null;
const counts = { found: 0, "not-found": 0, "not-checked": 0 } as Record<string, number>;
const walk = (value: unknown) => {
  if (Array.isArray(value)) return value.forEach(walk);
  if (typeof value !== "object" || value === null) return;
  const node = value as Record<string, unknown>;
  if (typeof node.checked === "string") counts[node.checked] = (counts[node.checked] ?? 0) + 1;
  Object.values(node).forEach(walk);
};
walk(map?.parts);
const summary = {
  case: args.case,
  rehearse: args.rehearse,
  started: outcome.start.outcome,
  seconds: Math.round(outcome.seconds),
  errors: outcome.events.filter((event) => event.type === "error"),
  saved: outcome.events.filter((event) => event.type === "map-saved").map((event) => event.type === "map-saved" && { step: event.step, written: event.written, problems: event.problems }),
  requests: (map?.extractions ?? []).map((record: Record<string, unknown>) => ({
    kind: record.kind,
    format: record.format,
    repaired: record.repaired,
    problems: record.problems,
    servedModel: (record.generation as Record<string, unknown>).servedModel,
    usage: (record.generation as Record<string, unknown>).usage,
  })),
  parts: map ? Object.fromEntries(Object.entries(map.parts as Record<string, { versions: Array<{ content: { items: unknown[]; groups?: unknown[] } }> }>).map(([part, stored]) => [part, { items: stored.versions.at(-1)?.content.items.length ?? 0, groups: stored.versions.at(-1)?.content.groups?.length ?? 0 }])) : null,
  quotes: counts,
  windows: { launch: atLaunch, end: atEnd, stopped: stoppedBecause },
};
const outDir = path.join(root, "eval-results", `map-verify-${new Date().toISOString().replace(/[:.]/g, "-")}`);
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
writeFileSync(path.join(outDir, "case-map.json"), JSON.stringify(map, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.log(`Written to ${path.relative(root, outDir)}.`);
process.exit(stoppedBecause ? 1 : 0);
