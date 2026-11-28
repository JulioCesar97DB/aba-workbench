import type { ElectronApplication, Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { AbaApi, GenerationUpdateEvent } from "../src/shared/api.ts";

/*
 * pnpm eval --map <fixture>: each run's case gets an invented case map, approved part by part,
 * before its sections are drafted (the Plan step's PR 0: section requests carry the approved
 * map). The map arrives the way a map arrives in the app: "Draft the map" (startMapDraft),
 * whose requests are answered here, inside the app's main process (its fetch wrapped, as the
 * rehearsal does), with the fixture's two answers. The app's own code then reads them, checks
 * every quote against the case's sources and saves the parts; the harness approves each part
 * through window.aba, as she would. Nothing of it leaves the computer: only the case map's
 * requests and the definitions review (to api.anthropic.com, on a key only this fake accepts)
 * are answered here; every other request goes on as it would.
 *
 * It lives in the evaluation harness only: it is installed through Playwright into a
 * development build started with --hidden, never part of the app or of a packaged build.
 * The fixture holds invented data only (fixtures/cases/<case>/approved-map.json).
 */

/** A key only this fake accepts; saved for the map draft and removed right after it. */
export const MAP_FIXTURE_CLAUDE_KEY = "sk-ant-api03-map-fixture-not-a-real-key";

/** The parts the harness approves: every part the block of section requests carries (src/lib/case-map-block.ts). */
const APPROVED_PARTS = ["client", "caregivers", "settings", "deficits", "strengths", "behaviors", "risks", "facts"] as const;

export interface MapFixture {
  /** Its file, relative to the repository, and a hash of its bytes: what the results record. */
  label: string;
  answers: { "map-facts": unknown; "map-behaviors": unknown };
}

export function readMapFixture(root: string, file: string): MapFixture {
  const full = path.resolve(file);
  const raw = readFileSync(full);
  const parsed = JSON.parse(raw.toString("utf8")) as { answers?: MapFixture["answers"] };
  if (!parsed.answers?.["map-facts"] || !parsed.answers["map-behaviors"]) throw new Error("the map fixture has no answers for map-facts and map-behaviors.");
  const hash = createHash("sha256").update(raw).digest("hex").slice(0, 12);
  return { label: `${path.relative(root, full)} (${hash})`, answers: parsed.answers };
}

/**
 * Wraps the main process's fetch: a case map request or a definitions review on Claude is
 * answered from the fixture, with each ref's source id (the fixture names a source by its id
 * in case.json) turned into the case's own id, found by the source's title in the request.
 * `titles` maps each fixture source id to the title the app gives that source.
 */
export async function installMapFixtureProvider(app: ElectronApplication, fixture: MapFixture, titles: Record<string, string>, claudeKey: string): Promise<void> {
  await app.evaluate(
    (_electron, setup) => {
      const g = globalThis as unknown as { fetch: typeof fetch; mapFixture?: { answers: Record<string, unknown>; titles: Record<string, string> } };
      // A later run of the same app replaces the answers and titles; the wrapper is installed once.
      const first = !g.mapFixture;
      g.mapFixture = { answers: setup.answers as Record<string, unknown>, titles: setup.titles };
      if (!first) return;
      const state = g.mapFixture;
      const previous = g.fetch;
      const fixtureKey = setup.claudeKey;
      const refuseOthers = setup.refuseOthers;
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      const keyOf = (init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        return headers.get("x-api-key") ?? (headers.get("authorization") ?? "").replace(/^Bearer /, "");
      };
      const answerFor = (texts: string[], task: string): string | null => {
        if (task.includes("Review request:")) return JSON.stringify({ deadMan: [], overlaps: [] });
        const kind = task.includes("Map request: case facts") ? "map-facts" : task.includes("Map request: behaviors") ? "map-behaviors" : null;
        if (!kind) return null;
        // The case's ids, by the titles the sources are sent under.
        const byTitle = new Map<string, string>();
        for (const text of texts) for (const match of text.matchAll(/<source id="([^"]+)" title="([^"]*)"/g)) byTitle.set(match[2], match[1]);
        const idOf = (fixtureId: string) => {
          const title = state.titles[fixtureId];
          const id = title === undefined ? undefined : byTitle.get(title);
          if (!id) throw new Error(`The map fixture names a source the case does not send: ${fixtureId}.`);
          return id;
        };
        const walk = (value: unknown): unknown => {
          if (Array.isArray(value)) return value.map(walk);
          if (typeof value !== "object" || value === null) return value;
          const node = value as Record<string, unknown>;
          const out: Record<string, unknown> = {};
          for (const [key, entry] of Object.entries(node)) out[key] = walk(entry);
          if (node.kind === "source" && typeof node.id === "string" && typeof node.quote === "string") out.id = idOf(node.id);
          return out;
        };
        return JSON.stringify(walk(state.answers[kind]));
      };
      g.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (!url.startsWith("https://api.anthropic.com/")) return previous(input, init);
        const mine = keyOf(init) === fixtureKey;
        if (url.startsWith("https://api.anthropic.com/v1/models") && mine) {
          return json({ data: [{ type: "model", id: "claude-fable-5-2", display_name: "Claude Fable 5.2", created_at: "2026-01-01T00:00:00Z" }], has_more: false, first_id: null, last_id: null });
        }
        if (url.startsWith("https://api.anthropic.com/v1/messages")) {
          const body = typeof init?.body === "string" ? init.body : "";
          const request = JSON.parse(body || "{}") as { model?: string; messages?: Array<{ content: Array<{ type: string; text?: string }> }> };
          const blocks = (request.messages ?? []).flatMap((message) => message.content).map((block) => block.text ?? "");
          const task = blocks.at(-1) ?? "";
          const text = answerFor(blocks, task);
          if (text !== null) {
            const usage = { input_tokens: 1000, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
            const events: Array<[string, unknown]> = [
              ["message_start", { type: "message_start", message: { id: "msg_map_fixture", type: "message", role: "assistant", model: request.model ?? "claude-fable-5-2", content: [], stop_reason: null, stop_sequence: null, stop_details: null, usage } }],
              ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
              ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
              ["content_block_stop", { type: "content_block_stop", index: 0 }],
              ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null, stop_details: null }, usage: { output_tokens: 50 } }],
              ["message_stop", { type: "message_stop" }],
            ];
            const encoder = new TextEncoder();
            const stream = new ReadableStream<Uint8Array>({
              start(controller) {
                for (const [event, data] of events) controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
                controller.close();
              },
            });
            return new Response(stream, { headers: { "content-type": "text/event-stream" } });
          }
        }
        // Anything else on this fake key never reaches a real provider (a rehearsal's key goes on to the rehearsal's own fake).
        if (mine && refuseOthers) throw new Error("The map fixture's fake key answers only the case map's requests.");
        return previous(input, init);
      }) as typeof fetch;
    },
    { answers: fixture.answers, titles, claudeKey, refuseOthers: claudeKey === MAP_FIXTURE_CLAUDE_KEY },
  );
}

/** Runs one generation-like request through window.aba and waits for its "finished". */
async function untilFinished(page: Page, start: "draft" | "review", caseId: string): Promise<{ outcome: string; events: GenerationUpdateEvent[] }> {
  return (await page.evaluate(
    async ({ caseId: id, start: which }) => {
      const api = (globalThis as unknown as { aba: AbaApi }).aba;
      const generationId = crypto.randomUUID();
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
        setTimeout(() => void api.cancelGeneration(generationId), 5 * 60 * 1000);
      });
      const started = which === "draft" ? await api.startMapDraft(id, generationId, "anthropic") : await api.startMapReview(id, generationId, "anthropic");
      if (started.outcome === "started") await done;
      return { outcome: started.outcome, events };
    },
    { caseId, start },
  )) as { outcome: string; events: GenerationUpdateEvent[] };
}

/**
 * Drafts the case's map from the fixture and approves every part the section requests carry.
 * Refused, with the reason, unless both requests saved their parts with no problem left by
 * the app's checks: a fixture the checks do not pass is fixed, never sent as it is.
 * `saveKey`: the fake key is saved for the draft and removed after (a real run); a rehearsal
 * keeps its own fake key, which this fake answers too.
 */
export async function approveMapFromFixture(page: Page, caseId: string, saveKey: boolean): Promise<{ approved: Array<{ part: string; version: number }>; cleared: number }> {
  const aba = <T,>(call: (api: AbaApi, input: unknown) => Promise<T>, input?: unknown) => page.evaluate(`(${call.toString()})(globalThis.aba, ${JSON.stringify(input ?? null)})`) as Promise<T>;
  if (saveKey) {
    // The eval profile is kept between runs: a Claude key of the owner's in it is never written over.
    const connections = (await aba((api) => api.getConnections())) as { claude: { state: string } };
    if (connections.claude.state !== "not-connected") throw new Error("the eval profile has a Claude key: --map saves a fake one for the map draft and removes it after, so it refuses to write over yours.");
    const saved = (await aba((api, key) => api.saveClaudeKey(key as string), MAP_FIXTURE_CLAUDE_KEY)) as { outcome: string };
    if (saved.outcome !== "saved") throw new Error(`the map fixture's fake key could not be saved (${saved.outcome}).`);
  }
  try {
    const draft = await untilFinished(page, "draft", caseId);
    if (draft.outcome !== "started") throw new Error(`the map draft did not start (${draft.outcome}).`);
    const error = draft.events.find((event) => event.type === "error") as { code: string; message: string } | undefined;
    if (error) throw new Error(`the map draft failed (${error.code}: ${error.message}).`);
    const saved = draft.events.filter((event) => event.type === "map-saved") as Array<Extract<GenerationUpdateEvent, { type: "map-saved" }>>;
    const steps = saved.map((event) => event.step).sort().join(",");
    if (steps !== "map-behaviors,map-facts") throw new Error(`the map draft saved ${steps || "nothing"}, not both requests.`);
    const problems = saved.reduce((sum, event) => sum + event.problems, 0);
    if (problems > 0) throw new Error(`the app's checks left ${problems} problem(s) in the map fixture's answers: fix the fixture.`);
  } finally {
    if (saveKey) await aba((api) => api.removeClaudeKey());
  }
  type PartView = { currentVersion: number | null; items: Array<Record<string, unknown> & { id: string }> };
  const readMap = async () => {
    const read = (await aba((api, id) => api.getCaseMap(id as string), caseId)) as { outcome: string; map?: { parts: Record<string, PartView> } };
    if (read.outcome !== "read" || !read.map) throw new Error("the case map could not be read back.");
    return read.map;
  };
  // The app marks what it could not check (a number quoted from a PDF, D32) with a [CHECK]. She
  // resolves each before she approves: each item with one is saved again with its checks cleared.
  let cleared = 0;
  for (const part of APPROVED_PARTS) {
    for (const item of (await readMap()).parts[part]?.items ?? []) {
      if (!hasCheck(item)) continue;
      const result = (await aba((api, input) => {
        const { id, part: p, itemId, text, editing } = input as { id: string; part: never; itemId: string; text: string; editing: number | null };
        return api.saveMapItem(id, p, "items", itemId, text, editing);
      }, { id: caseId, part, itemId: item.id, text: JSON.stringify(withoutChecks(item)), editing: null })) as { outcome: string };
      if (result.outcome !== "saved") throw new Error(`could not clear the checks of ${part} ${item.id} (${result.outcome}).`);
      cleared++;
    }
  }
  const map = await readMap();
  const approved: Array<{ part: string; version: number }> = [];
  for (const part of APPROVED_PARTS) {
    const version = map.parts[part]?.currentVersion ?? null;
    if (version === null) throw new Error(`the map fixture gave no ${part}.`);
    const result = (await aba((api, input) => {
      const { id, part: p, version: v } = input as { id: string; part: never; version: number };
      return api.approveMapPart(id, p, v);
    }, { id: caseId, part, version })) as { outcome: string };
    if (result.outcome !== "saved") throw new Error(`could not approve ${part} v${version} (${result.outcome}).`);
    approved.push({ part, version });
  }
  return { approved, cleared };
}

function isClaim(value: unknown): value is { value: unknown; refs: unknown[]; check: string | null } {
  return typeof value === "object" && value !== null && "value" in value && "refs" in value;
}

function hasCheck(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasCheck);
  if (typeof value !== "object" || value === null) return false;
  if (isClaim(value) && typeof value.check === "string" && value.check.trim() !== "") return true;
  return Object.values(value).some(hasCheck);
}

/** An item as the interface sends it back (values and checks only), with every claim's check cleared; the app keeps each claim's refs and origin. */
function withoutChecks(value: unknown, top = true): unknown {
  if (Array.isArray(value)) return value.map((entry) => withoutChecks(entry, false));
  if (typeof value !== "object" || value === null) return value;
  if (isClaim(value)) return { value: value.value, check: null };
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "editedAt" || key === "origin" || key === "refs" || (top && key === "id")) continue;
    out[key] = withoutChecks(entry, false);
  }
  return out;
}
