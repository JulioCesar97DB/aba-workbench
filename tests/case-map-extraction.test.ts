import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { checkMapAnswer, mapAnswerSchema, mergeRepair, normalizeForQuote, numbersIn, parseMapAnswer, repairInput, type BehaviorsAnswer, type CheckContext, type CheckResult, type FactsAnswer } from "../src/lib/case-map-extraction.ts";
import { mockProvider } from "../src/lib/providers/mock.ts";
import { CHATGPT_MAP_TASK_PREAMBLE, CHATGPT_TASK_PREAMBLE, responsesRequest } from "../src/lib/providers/openai.ts";
import { ProviderError, type GenerateEvent, type GenerateOptions, type Provider } from "../src/lib/providers/types.ts";
import { buildSectionPrompt } from "../src/lib/rules.ts";
import { CASE_FILE_NAME } from "../src/main/case-file.ts";
import { applyMapAnswer, approveMapPart, definitionReviewView, saveMapItem } from "../src/main/case-map.ts";
import { refusedFormat, resetMapFormats, toAnswerParts } from "../src/main/case-map-draft.ts";
import { CaseMapService } from "../src/main/case-map-service.ts";
import { resetReviewFormats } from "../src/main/definition-review.ts";
import { saveOwnText } from "../src/main/case-sections.ts";
import { CaseLibrary } from "../src/main/cases.ts";
import type { GenerationUpdateEvent } from "../src/shared/api.ts";
import { minutesOfLength } from "../src/shared/case-map.ts";

/*
 * "Draft the map" with a fake provider (step 1, pull request 2): the two requests and
 * their prompts, the JSON schema, the code checks of quotes and numbers, the repair (only
 * the failed items, merged back by key; the first answer kept when the repair cannot be
 * used), the plain-JSON resend, an update that keeps her work, and her thresholds.
 * Invented case only.
 */

const folders: string[] = [];
after(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});
beforeEach(() => {
  resetMapFormats();
  resetReviewFormats();
});

const OBSERVATIONS = [
  "BCBA direct observation notes, invented case.",
  "11/04/2026, home, 2 hours: the child spat toward his mother's forearm twice when she set the reading worksheet on the table; she stopped the worksheet to clean up. A third spit came at 4:40 when she guided his hand to the page.",
  "11/06/2026, laundromat, 2 hours: he spat once on the floor next to his grandmother when she said it was time to fold.",
  "**Spitting counts:** 3 on 11/04, 1 on 11/06.",
].join("\n");
const INTERVIEW = "Mother interview, invented: he spits and then I have to stop the homework to clean. Grandmother can attend training on Tuesdays and Thursdays only. The family speaks Spanish at home.";

type Answer = Record<string, unknown>;
const ref = (id: string, quote: string) => ({ kind: "source", id, quote });
const claim = (value: string, refs: unknown[], origin = "extracted", check = "") => ({ value, refs, origin, check });
/** The wire form of "nothing": an empty claim (review round 1, B3). */
const none = () => claim("", []);

function absentClient(): Answer {
  const out: Answer = {};
  for (const key of ["age", "diagnosis", "severityLevel", "evaluator", "evaluationDate", "school", "grade", "schedule", "iep"]) out[key] = none();
  return { ...out, medications: [], otherServices: [], languages: [] };
}

function factsAnswer(ids: { obs: string; interview: string; pdf: string }, overrides: Answer = {}): Answer {
  return {
    client: absentClient(),
    caregivers: [
      { key: "new-1", role: claim("Mother", [ref(ids.interview, "Mother interview, invented")]), language: claim("Spanish", [ref(ids.interview, "The family speaks Spanish at home")]), availability: none(), participation: none(), limits: none(), mitigation: none() },
      { key: "new-2", role: claim("Grandmother", [ref(ids.interview, "Grandmother can attend training")]), language: none(), availability: claim("Tuesdays and Thursdays", [ref(ids.interview, "attend training on Tuesdays and Thursdays only")]), participation: none(), limits: none(), mitigation: none() },
    ],
    settings: [
      { key: "new-3", name: claim("Home", [ref(ids.obs, "11/04/2026, home, 2 hours")]), kind: claim("home", [ref(ids.obs, "11/04/2026, home, 2 hours")]), evidence: claim("observed", [ref(ids.obs, "BCBA direct observation notes")]), by: none(), dates: none() },
      { key: "new-4", name: claim("Laundromat", [ref(ids.obs, "11/06/2026, laundromat, 2 hours")]), kind: claim("community", [ref(ids.obs, "11/06/2026, laundromat, 2 hours")]), evidence: claim("observed", [ref(ids.obs, "BCBA direct observation notes")]), by: none(), dates: none() },
    ],
    deficits: [
      {
        key: "new-5",
        area: claim("Communication", [ref(ids.pdf, "Communication")]),
        // One claim per score row (case map speed): the row's fields under the quote of its line.
        scores: [{ instrument: "Vineland-3", scale: "Communication", score: "68", percentile: "", level: "", refs: [ref(ids.pdf, "Communication 68")], origin: "extracted", check: "" }],
        evidence: [],
        impact: none(),
      },
    ],
    strengths: [],
    facts: [],
    openItems: [{ kind: "missing", text: "No severity level in the evaluation.", homeSection: 4 }],
    report: [],
    ...overrides,
  };
}

function behaviorsAnswer(ids: { obs: string; interview: string }, settingIds: string[], overrides: Answer = {}): Answer {
  const behavior = (key: string, name: string) => ({
    key,
    name: claim(name, [ref(ids.obs, name === "Spitting" ? "spat toward his mother's forearm" : "he spat once on the floor")]),
    topographies: [claim("Spits toward the adult's forearm when a worksheet is set down", [ref(ids.obs, "spat toward his mother's forearm twice when she set the reading worksheet on the table")])],
    measure: claim("frequency", [], "ai-drafted"),
    definition: claim("Any instance in which the child forcefully expels saliva toward another person. Offset: [MISSING: your threshold for the end of an episode].", [ref(ids.obs, "spat toward his mother's forearm twice")], "ai-drafted"),
    onset: none(),
    offset: none(),
    examples: [],
    nonExamples: [],
    baseline: {
      observations: [{ date: claim("11/04/2026", [ref(ids.obs, "11/04/2026, home, 2 hours")]), setting: claim("Home", [ref(ids.obs, "11/04/2026, home, 2 hours")]), length: claim("2 hours", [ref(ids.obs, "11/04/2026, home, 2 hours")]), value: claim("3", [ref(ids.obs, "Spitting counts: 3 on 11/04")]) }],
      other: [],
    },
    settingIds: settingIds.slice(0, 1),
    antecedents: [],
    consequences: [claim("The worksheet stops while she cleans up", [ref(ids.obs, "she stopped the worksheet to clean up")])],
    function: { primary: ["escape"], secondary: [], evidence: [{ tool: "interview", respondent: "Mother", result: claim("Spitting stops the homework", [ref(ids.interview, "he spits and then I have to stop the homework to clean")]), supports: ["escape"] }], reasoning: "The observation and the interview point to escape.", check: "" },
    barriers: ["social-interaction"],
    risks: [],
  });
  return {
    behaviors: [behavior("new-1", "Spitting"), behavior("new-2", "Spitting on the floor")],
    groups: [{ key: "new-3", behaviorKeys: ["new-1", "new-2"], nature: "Spitting", function: "escape", measure: "frequency", reason: "Same response class, function and measure." }],
    risks: [{ key: "new-4", behaviorKeys: ["new-1"], what: claim("Spitting at adults during demands", [ref(ids.obs, "spat toward his mother's forearm")]), evidence: [], level: none() }],
    openItems: [],
    ...overrides,
  };
}

/** Parameters with a union (anyOf or a type array) across a schema: Claude takes at most 16 (review round 1, B3). */
function unionCount(schema: unknown): number {
  if (Array.isArray(schema)) return schema.reduce((sum: number, entry) => sum + unionCount(entry), 0);
  if (typeof schema !== "object" || schema === null) return 0;
  const node = schema as Record<string, unknown>;
  const here = "anyOf" in node || Array.isArray(node.type) ? 1 : 0;
  return here + Object.values(node).reduce((sum: number, value) => sum + unionCount(value), 0);
}

interface Turn {
  answer?: Answer | string;
  error?: ProviderError;
}

/** A provider that answers each request from a script, by kind, and records what it was sent. */
function scriptedModel(script: { facts: Turn[]; behaviors: Turn[]; review?: Turn[] }, limits: { claudeUnions?: boolean } = {}) {
  const sent: GenerateOptions[] = [];
  /** The definitions reviews (T3), kept apart from the map's requests; each answers with no findings unless scripted. */
  const reviews: GenerateOptions[] = [];
  const provider: Provider = {
    ...mockProvider,
    id: "anthropic",
    async *generate(options): AsyncIterable<GenerateEvent> {
      if (options.prompt.kind === "definition-review") {
        reviews.push(options);
        const turn: Turn = script.review?.shift() ?? { answer: { deadMan: [], overlaps: [] } };
        if (turn.error) throw turn.error;
        yield { type: "text", delta: typeof turn.answer === "string" ? turn.answer : JSON.stringify(turn.answer) };
        yield { type: "done", complete: true, stopReason: "end_turn", servedModel: options.model, usage: { uncachedInputTokens: 10, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 5, reasoningTokens: null }, attempts: null };
        return;
      }
      sent.push(options);
      // Claude refuses a request whose strict schemas hold more than 16 parameters with a union.
      if (limits.claudeUnions && options.outputFormat && unionCount(options.outputFormat.schema) > 16) {
        throw new ProviderError("bad_request", "Anthropic refused the request: output_config.format: schema has too many parameters with union types", 400);
      }
      const turn = (options.prompt.task.includes("Map request: case facts") ? script.facts : script.behaviors).shift();
      if (!turn) throw new ProviderError("internal_error", "no scripted turn");
      if (turn.error) throw turn.error;
      const text = typeof turn.answer === "string" ? turn.answer : JSON.stringify(turn.answer);
      yield { type: "status", phase: "writing" };
      for (const piece of text.match(/.{1,400}/gsu) ?? []) yield { type: "text", delta: piece };
      yield { type: "done", complete: true, stopReason: "end_turn", servedModel: options.model, usage: { uncachedInputTokens: 100, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 50, reasoningTokens: null }, attempts: null };
    },
  };
  return { provider, sent, reviews };
}

async function setup(script: { facts: Turn[]; behaviors: Turn[]; review?: Turn[] } | ((ids: { obs: string; interview: string; pdf: string }) => { facts: Turn[]; behaviors: Turn[]; review?: Turn[] }), options: { instructions?: string; herSection?: string; claudeUnions?: boolean } = {}) {
  const folder = mkdtempSync(path.join(tmpdir(), "aba-map-draft-test-"));
  folders.push(folder);
  let n = 0;
  const cases = new CaseLibrary({ location: async () => ({ folder, isDefault: false }), newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, log: () => undefined });
  const created = await cases.create({ label: "Invented draft case" });
  assert.ok(created.outcome === "created");
  const caseId = created.case.id;
  const obs = await cases.addTextSource(caseId, { type: "direct-observation", text: OBSERVATIONS });
  const interview = await cases.addTextSource(caseId, { type: "parent-interview", text: INTERVIEW });
  assert.ok(obs.outcome === "saved" && interview.outcome === "saved");
  const caseFolder = path.join(folder, "Invented draft case");
  // A PDF source: its quotes cannot be checked yet (D32).
  writeFileSync(path.join(caseFolder, "vineland.pdf"), "%PDF-1.4 invented");
  const pdfId = "11111111-2222-4333-8444-555555555555";
  await cases.changeCase(caseId, (data, _folder, now) => ({ save: { ...data, sources: [...data.sources, { id: pdfId, kind: "pdf" as const, type: "vineland-3", file: "vineland.pdf", bytes: 17, addedAt: now, updatedAt: now }] }, value: null }));
  if (options.herSection) {
    await cases.changeCase(caseId, (data, _folder, now) => ({ save: saveOwnText(data, "medical-necessity", options.herSection!, null, now)!.data, value: null }));
  }
  const ids = { obs: obs.sourceId, interview: interview.sourceId, pdf: pdfId };
  const model = scriptedModel(typeof script === "function" ? script(ids) : script, { claudeUnions: options.claudeUnions });
  const service = new CaseMapService({
    cases,
    ai: {
      instructions: { get: async (id) => (id === "case-map" ? (options.instructions ?? "") : "") },
      rulesDir: path.join(process.cwd(), "rules"),
      provider: () => model.provider,
      credential: async () => ({ kind: "api-key", apiKey: "test-key-not-real" }),
      chosenModel: async () => null,
      rememberProvider: async () => undefined,
      log: () => undefined,
    },
  });
  return { cases, caseId, service, ids, model, caseFile: path.join(caseFolder, CASE_FILE_NAME) };
}

async function draft(service: CaseMapService, caseId: string): Promise<Array<Exclude<GenerationUpdateEvent, { type: "finished" }>>> {
  const ready = await service.prepareDraft(caseId, "anthropic");
  assert.ok(ready.outcome === "ready");
  const events: Array<Exclude<GenerationUpdateEvent, { type: "finished" }>> = [];
  for await (const event of ready.run(new AbortController().signal)) events.push(event);
  return events;
}

const stored = (caseFile: string) => JSON.parse(readFileSync(caseFile, "utf8")).caseMap;
const checkContext = (extra: Partial<CheckContext> = {}): CheckContext => ({
  sources: [
    { id: "o", title: "Observations", text: OBSERVATIONS },
    { id: "i", title: "Interview", text: INTERVIEW },
  ],
  sections: [],
  notes: "",
  settingIds: new Set(),
  ...extra,
});
const parsedBehaviors = (answer: Answer) => {
  const parsed = parseMapAnswer("map-behaviors", JSON.stringify(answer));
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.problems.join("; "));
  return parsed.answer as BehaviorsAnswer;
};

test("a draft: two requests on the sections' cached prefix, then each request's parts saved as AI versions with code ids and checked quotes", async () => {
  let settingIds: string[] = [];
  const { service, caseId, caseFile, model, ids } = await setup((found) => ({
    facts: [{ answer: factsAnswer(found) }],
    behaviors: [{ answer: { get behaviors() { return (behaviorsAnswer(found, settingIds) as { behaviors: unknown }).behaviors; }, groups: (behaviorsAnswer(found, []) as { groups: unknown }).groups, risks: (behaviorsAnswer(found, []) as { risks: unknown }).risks, openItems: [] } }],
  }), { herSection: "Medical Necessity, hers: the child spits at adults during homework." });
  // The behaviors may name the settings the facts saved: set-1 and set-2.
  settingIds = ["set-1"];
  const events = await draft(service, caseId);

  assert.equal(model.sent.length, 2, "two requests");
  const [facts, behaviors] = model.sent;
  // The system prefix and the sources are the sections' own, so the cache is shared.
  const section = await buildSectionPrompt({ section: "medical-necessity", request: { kind: "draft" }, sources: facts.prompt.sources, herSections: [], instructions: null, notes: null });
  assert.equal(facts.prompt.system, section.prompt.system);
  assert.equal(facts.prompt.kind, "case-map");
  assert.equal(section.prompt.kind, undefined, "a section's prompt is unchanged");
  assert.match(facts.prompt.task, /# Drafting the case map/);
  assert.doesNotMatch(facts.prompt.task, /# Target behaviors/, "the behaviors rules go with the behaviors request only");
  assert.match(behaviors.prompt.task, /# Target behaviors/);
  assert.match(behaviors.prompt.task, /Climbing furniture/, "the definition example goes with the behaviors request");
  assert.doesNotMatch(facts.prompt.system, /Climbing furniture/, "and never into the cached prefix every section request shares");
  assert.ok(facts.prompt.task.indexOf("<her-sections>") < facts.prompt.task.indexOf("Map request"), "her sections come before the request");
  assert.match(facts.prompt.task, /<section id="medical-necessity"/);
  assert.match(behaviors.prompt.task, /<map-facts>[\s\S]*"id":"set-1"/);
  assert.equal(facts.outputFormat?.name, "case_map_facts");
  assert.equal(behaviors.outputFormat?.name, "case_map_behaviors");
  assert.equal(facts.maxOutputTokens, 64_000);
  assert.doesNotMatch(behaviors.prompt.task, /\n<standing-instructions>\n/, "no thresholds until she confirms them");

  const map = stored(caseFile);
  const behaviorsPart = map.parts.behaviors;
  assert.equal(behaviorsPart.versions.length, 1);
  assert.equal(behaviorsPart.versions[0].kind, "ai");
  const [spitting, floor] = behaviorsPart.versions[0].content.items;
  assert.deepEqual([spitting.id, floor.id], ["beh-1", "beh-2"], "ids made by code");
  assert.equal("key" in spitting, false);
  assert.equal(spitting.intensity, null, "intensity is hers only");
  assert.equal(spitting.onset, null, "an empty claim is stored as null");
  assert.equal(spitting.function.check, null, "an empty check is stored as null");
  assert.deepEqual(spitting.barriers, { value: ["social-interaction"], refs: [], origin: "proposed", check: null });
  assert.equal(spitting.function.origin, "hypothesis");
  assert.deepEqual(spitting.settingIds, ["set-1"]);
  assert.equal(spitting.name.refs[0].checked, "found");
  assert.equal(spitting.name.refs[0].sourceId, ids.obs);
  // The observation's length as the notes write it, and the app's minutes from it (review round 1, S7).
  const observation = spitting.baseline.observations[0];
  assert.equal(observation.length.value, "2 hours");
  assert.deepEqual(observation.minutes, { value: "120", refs: [{ kind: "app" }], origin: "app", check: null }, "the app's own, not a source's (review round 2, M5)");
  assert.equal(observation.value.refs[0].checked, "found", "a quote without the source's Markdown bold is found");
  assert.deepEqual(behaviorsPart.versions[0].content.groups[0].behaviorIds, ["beh-1", "beh-2"]);
  assert.deepEqual(map.parts.risks.versions[0].content.items[0].behaviorIds, ["beh-1"]);
  // The facts: no client (every value empty), caregivers and settings, a PDF quote not checked, open items from both requests.
  assert.equal(map.parts.client, undefined);
  assert.deepEqual(map.parts.caregivers.versions[0].content.items.map((item: { id: string }) => item.id), ["cg-1", "cg-2"]);
  assert.equal(map.parts.caregivers.versions[0].content.items[0].availability, null);
  const score = map.parts.deficits.versions[0].content.items[0].scores[0].score;
  assert.equal(score.refs[0].checked, "not-checked", "a PDF's quote is not checked yet");
  assert.equal(score.check, null);
  assert.equal(map.parts.openItems.versions.at(-1).content.items.length, 1);
  // The draft's two requests, then its one review of the definitions (T3), all of one run.
  assert.equal(map.extractions.length, 3);
  assert.deepEqual(
    map.extractions.map((record: { kind: string; format: string; repaired: boolean }) => [record.kind, record.format, record.repaired]),
    [
      ["map-facts", "json-schema", false],
      ["map-behaviors", "json-schema", false],
      ["map-review", "json-schema", false],
    ],
  );
  assert.equal(new Set(map.extractions.map((record: { run: string }) => record.run)).size, 1, "one run");
  assert.equal(model.reviews.length, 1, "one review per draft");
  assert.equal(map.extractions[0].problemsBeforeRepair, undefined, "no repair, no first-attempt problems");
  assert.equal(map.extractions[0].run, map.extractions[1].run, "one run");
  assert.equal(map.extractions[0].generation.provider, "anthropic");
  // What the screen hears: progress, then each request's saved parts.
  const saved = events.filter((event) => event.type === "map-saved");
  assert.deepEqual(
    saved.map((event) => event.type === "map-saved" && [event.step, event.result.outcome, event.problems]),
    [
      ["map-facts", "saved", 0],
      ["map-behaviors", "saved", 0],
    ],
  );
  assert.ok(events.some((event) => event.type === "map-progress"));
});

test("B3: the schemas hold no union, so Claude takes them as they are and never falls back to plain JSON", async () => {
  for (const kind of ["map-facts", "map-behaviors"] as const) assert.equal(unionCount(mapAnswerSchema(kind)), 0, kind);
  assert.ok(unionCount(mapAnswerSchema("map-facts")) + unionCount(mapAnswerSchema("map-behaviors")) <= 16, "Claude's limit across a request's strict schemas");
  // A fake Claude that enforces the limit: the draft runs on the schema, with no refusal to fall back from.
  const { service, caseId, caseFile, model } = await setup((found) => ({ facts: [{ answer: factsAnswer(found) }], behaviors: [{ answer: behaviorsAnswer(found, []) }] }), { claudeUnions: true });
  await draft(service, caseId);
  assert.equal(model.sent.length, 2);
  assert.ok(model.sent.every((options) => options.outputFormat !== null));
  assert.deepEqual(stored(caseFile).extractions.map((record: { format: string }) => record.format), ["json-schema", "json-schema", "json-schema"]);
  assert.equal(unionCount(model.reviews[0].outputFormat?.schema), 0, "the review's schema has no union either");
});

test("a quote not found word for word gets one repair request about that item only; the fixed item replaces it by key", async () => {
  const { service, caseId, caseFile, model } = await setup((found) => {
    const bad = factsAnswer(found);
    (bad.caregivers as Array<Record<string, unknown>>)[0].role = claim("Mother", [ref(found.interview, "the mother said she works nights")]);
    // The repair gives only the failed caregiver back, as asked.
    const fixed = factsAnswer(found, { caregivers: [(factsAnswer(found).caregivers as unknown[])[0]], settings: [], deficits: [], openItems: [] });
    return { facts: [{ answer: bad }, { answer: fixed }], behaviors: [{ answer: behaviorsAnswer(found, []) }] };
  });
  await draft(service, caseId);
  assert.equal(model.sent.length, 3);
  const repairTask = model.sent[1].prompt.task;
  assert.match(repairTask, /<previous-answer>/);
  assert.match(repairTask, /caregivers\[0\]\.role\.refs\[0\]: the quote "the mother said she works nights" is not found word for word/);
  const previous = repairTask.slice(repairTask.indexOf("<previous-answer>"), repairTask.indexOf("</previous-answer>"));
  assert.match(previous, /"new-1"/);
  assert.doesNotMatch(previous, /Grandmother|Laundromat/, "only the item that failed is quoted");
  assert.match(repairTask, /holding only these items/);
  const map = stored(caseFile);
  assert.equal(map.extractions[0].repaired, true);
  assert.equal(map.extractions[0].repairUsed, true);
  assert.equal(map.extractions[0].problemsBeforeRepair.length, 1, "why the repair was needed is recorded");
  assert.deepEqual(map.extractions[0].problems, []);
  const items = map.parts.caregivers.versions[0].content.items;
  assert.equal(items.length, 2, "the item the repair did not return is kept from the first answer");
  assert.equal(items[0].role.refs[0].checked, "found");
  assert.equal(map.parts.settings.versions[0].content.items.length, 2);
});

test("what still fails after the repair is saved and flagged, never dropped", async () => {
  const { service, caseId, caseFile } = await setup((found) => {
    const bad = factsAnswer(found);
    (bad.caregivers as Array<Record<string, unknown>>)[0].role = claim("Mother", [ref(found.interview, "words nobody ever wrote")]);
    return { facts: [{ answer: bad }, { answer: bad }], behaviors: [{ answer: behaviorsAnswer(found, []) }] };
  });
  const events = await draft(service, caseId);
  const role = stored(caseFile).parts.caregivers.versions[0].content.items[0].role;
  assert.equal(role.refs[0].checked, "not-found");
  assert.match(role.check, /not found word for word/);
  assert.equal(stored(caseFile).extractions[0].problems.length, 1);
  const facts = events.find((event) => event.type === "map-saved" && event.step === "map-facts");
  assert.ok(facts?.type === "map-saved" && facts.problems === 1);
});

test("B1: a repair that is unreadable, cut short or failed leaves the first answer saved with its flags", async () => {
  for (const repairTurn of [{ answer: "not json at all" }, { answer: '{"caregivers": [' }, { error: new ProviderError("rate_limited", "Too many requests", 429) }] as Turn[]) {
    resetMapFormats();
    const { service, caseId, caseFile } = await setup((found) => {
      const bad = factsAnswer(found);
      (bad.caregivers as Array<Record<string, unknown>>)[0].role = claim("Mother", [ref(found.interview, "words nobody ever wrote")]);
      return { facts: [{ answer: bad }, repairTurn], behaviors: [{ answer: behaviorsAnswer(found, []) }] };
    });
    const events = await draft(service, caseId);
    assert.equal(events.filter((event) => event.type === "error").length, 0, JSON.stringify(repairTurn).slice(0, 60));
    const map = stored(caseFile);
    const caregivers = map.parts.caregivers.versions[0].content.items;
    assert.equal(caregivers.length, 2, "the whole first answer is saved");
    assert.match(caregivers[0].role.check, /not found word for word/);
    assert.equal(map.parts.settings.versions[0].content.items.length, 2);
    assert.equal(map.extractions[0].repaired, true);
    assert.equal(map.extractions[0].repairUsed, false);
    assert.equal(map.extractions[0].problems.length, 1);
    assert.ok(map.parts.behaviors, "the draft goes on to the behaviors");
  }
});

test("B2: a setting id the map does not have, and a risk naming no behavior, cost nothing: the links are left out with an open item", async () => {
  const { service, caseId, caseFile } = await setup((found) => {
    const answer = behaviorsAnswer(found, ["home"]);
    (answer.risks as Array<Record<string, unknown>>)[0].behaviorKeys = ["new-1", "new-99"];
    return { facts: [{ answer: factsAnswer(found) }], behaviors: [{ answer }, { answer }] };
  });
  const events = await draft(service, caseId);
  assert.equal(events.filter((event) => event.type === "error").length, 0);
  const map = stored(caseFile);
  const behaviors = map.parts.behaviors.versions[0].content.items;
  assert.equal(behaviors.length, 2, "the behaviors are saved");
  assert.deepEqual(behaviors[0].settingIds, []);
  assert.deepEqual(map.parts.risks.versions[0].content.items[0].behaviorIds, ["beh-1"]);
  const open = map.parts.openItems.versions.at(-1).content.items.map((item: { text: string }) => item.text);
  assert.ok(open.some((text: string) => /settings that are not in the map \(home\)/.test(text)));
  assert.ok(open.some((text: string) => /behaviors that are not in the map \(new-99\)/.test(text)));
});

test("B2: applyMapAnswer never throws on the AI's content: a link to an unknown id is left out and recorded", async () => {
  const { cases, caseId } = await setup(() => ({ facts: [], behaviors: [] }));
  const record = { id: "x", kind: "map-behaviors", at: "", run: "r", generation: {}, format: "json-schema", repaired: false, problems: [] };
  const outcome = await cases.changeCase(caseId, (data, _folder, now) => {
    const applied = applyMapAnswer(data, { behaviors: { items: [{ key: "new-1", name: { value: "Spitting", refs: [], origin: "extracted", check: null }, settingIds: ["home", "set-1"] }], groups: [] } }, { ...record, at: now }, new Set(), now);
    return { save: applied.data, value: applied };
  });
  assert.ok(outcome.kind === "saved");
  const value = outcome.value as unknown as { written: string[]; problems: string[]; data: { caseMap: { parts: Record<string, { versions: Array<{ content: { items: Array<{ settingIds: string[] }> } }> }>; extractions: Array<{ problems: string[] }> } } };
  assert.deepEqual(value.written, ["behaviors"]);
  assert.ok(value.problems.some((problem) => /named settings the map does not have/.test(problem)), "what the save left out is returned, for the screen's count (review round 2, M4)");
  assert.deepEqual(value.data.caseMap.parts.behaviors.versions[0].content.items[0].settingIds, []);
  assert.ok(value.data.caseMap.extractions[0].problems.some((problem) => /named settings the map does not have/.test(problem)));
});

test("S1: a value with no ref, a quote too short to prove anything, a number in no quote, and a threshold nobody gave are problems", () => {
  const found = { obs: "o", interview: "i" };
  const answer = behaviorsAnswer(found, []);
  const [first] = answer.behaviors as Array<Record<string, unknown>>;
  first.name = claim("Spitting", []);
  first.antecedents = [claim("A worksheet set down in 6 of 8 episodes", [ref("o", "she set the reading worksheet on the table")])];
  (first.baseline as { observations: Array<Record<string, unknown>> }).observations[0].value = claim("3", [ref("o", "3")]);
  first.offset = claim("The child has not spat for 15 seconds.", [ref("o", "spat toward his mother's forearm")], "ai-drafted");
  const result = checkMapAnswer("map-behaviors", parsedBehaviors(answer), checkContext());
  const has = (pattern: RegExp) => assert.ok(result.problems.some((problem) => pattern.test(problem)), `${pattern} in ${result.problems.join(" | ")}`);
  has(/behaviors\[0\]\.name: a value a source or her text states needs a ref/);
  has(/behaviors\[0\]\.antecedents\[0\]: the number 6, 8 in/);
  has(/observations\[0\]\.value\.refs\[0\]: the quote "3" is too short/);
  has(/behaviors\[0\]\.offset: .*gives a threshold that no quote gives and that is not her default or her own for this place/);
  assert.deepEqual([...result.failing.get("behaviors")!], [0], "the problems point at the one behavior");
  // With her own thresholds, an AI-drafted offset may take its number from them (D16).
  const withThresholds = checkMapAnswer("map-behaviors", parsedBehaviors(answer), checkContext({ instructions: "End of an episode: the behavior has stopped for 15 seconds in a row." }));
  assert.ok(!withThresholds.problems.some((problem) => /offset/.test(problem)));
});

test("her default thresholds (owner's decision, 2026-11-28): an AI-drafted definition, onset or offset may state each one as the threshold it is, in its place", async () => {
  const passes = (key: "definition" | "onset" | "offset", value: string, name = "Spitting", instructions?: string) => {
    const answer = behaviorsAnswer({ obs: "o", interview: "i" }, []);
    const [first] = answer.behaviors as Array<Record<string, unknown>>;
    first.name = claim(name, [ref("o", "spat toward his mother's forearm")], "ai-drafted");
    first[key] = claim(value, [ref("o", "spat toward his mother's forearm")], "ai-drafted");
    const result = checkMapAnswer("map-behaviors", parsedBehaviors(answer), checkContext(instructions === undefined ? {} : { instructions }));
    return !result.problems.some((problem) => problem.startsWith(`behaviors[0].${key}`));
  };
  assert.ok(passes("onset", "The child does not start what was asked within 5 seconds."));
  assert.ok(passes("onset", "The child is more than 6 feet from the supervising adult."));
  assert.ok(passes("onset", "The child stops attending to the task for 3 seconds."));
  assert.ok(passes("offset", "The child has not spat for 10 seconds in a row."));
  assert.ok(passes("offset", "No crying or dropping for 30 seconds.", "Tantrum (duration)"));
  assert.ok(passes("definition", "Any instance in which the child spits. Onset: within 5 seconds of a demand. Offset: 10 seconds without spitting."));
  // Refused: a default number with another unit, in another place, or for another behavior.
  assert.ok(!passes("onset", "The child is more than 3 feet from the assigned spot."), "the 3 ft task area is not a default");
  assert.ok(!passes("onset", "The child is more than 10 feet from the supervising adult."), "her elopement default is 6 ft");
  assert.ok(!passes("definition", "Any instance in which the child does not start within 6 seconds."), "6 is feet, not seconds");
  assert.ok(!passes("offset", "The child has not spat for 30 seconds."), "30 s is only for a tantrum");
  assert.ok(!passes("offset", "The child has not spat for 5 minutes."));
  assert.ok(!passes("offset", "The child has not spat for 5 seconds."), "5 s belongs to the start of an instruction, not the offset");
  assert.ok(!passes("onset", "The child spits 3 times."), "a bare count is not a threshold");
  // Her own line takes the place of the default it changes, one threshold at a time (finding 3).
  const hers = "- Leaving the supervising adult (elopement): more than 10 feet away from the supervising adult.";
  assert.ok(passes("onset", "The child is more than 10 feet from the supervising adult.", "Elopement", hers));
  assert.ok(!passes("onset", "The child is more than 6 feet from the supervising adult.", "Elopement", hers), "her 10 ft replaces the default 6 ft");
  assert.ok(passes("offset", "The child has not left for 10 seconds in a row.", "Elopement", hers), "the defaults she did not change stay");
  // Review round 2, finding 1: once she saves the dialog, her end-of-episode line keeps 30 s (or her own number) for a tantrum only.
  const { THRESHOLDS_DRAFT } = await import("../src/shared/case-map-thresholds.ts");
  assert.ok(!passes("offset", "The child has not spat for 30 seconds.", "Spitting", THRESHOLDS_DRAFT), "the draft saved unchanged");
  const offTaskChanged = THRESHOLDS_DRAFT.replace("Off task: 3 seconds", "Off task: 5 seconds");
  assert.ok(!passes("offset", "The child has not spat for 30 seconds.", "Spitting", offTaskChanged), "only the Off task line changed");
  assert.ok(passes("offset", "No crying or dropping for 30 seconds.", "Tantrum", offTaskChanged));
  const sixty = "- End of an episode: the behavior has stopped for 10 seconds in a row; for a tantrum, 60 seconds.";
  assert.ok(!passes("offset", "The child has not spat for 60 seconds.", "Spitting", sixty));
  assert.ok(passes("offset", "No crying for 60 seconds.", "Tantrum", sixty));
  assert.ok(passes("offset", "The child has not spat for 10 seconds in a row.", "Spitting", sixty));
  // Check 3: in her own order, the clause that names a tantrum is for a tantrum only.
  const after = "- End of an episode: 10 seconds; 30 seconds for a tantrum.";
  assert.ok(!passes("offset", "The child has not spat for 30 seconds.", "Spitting", after), "30 s for a tantrum, written after the number");
  assert.ok(passes("offset", "The child has not spat for 10 seconds.", "Spitting", after));
  assert.ok(passes("offset", "No crying for 30 seconds.", "Tantrum", after));
  const first = "- End of an episode: for a tantrum, 60 seconds; otherwise 10 seconds in a row.";
  assert.ok(passes("offset", "The child has not spat for 10 seconds in a row.", "Spitting", first), "her tantrum clause first does not refuse the others' 10 s");
  assert.ok(!passes("offset", "The child has not spat for 60 seconds.", "Spitting", first));
  assert.ok(passes("offset", "No crying for 60 seconds.", "Tantrum", first));
  const sentences = "- End of an episode: 10 seconds in a row. For a tantrum, 45 seconds.";
  assert.ok(!passes("offset", "The child has not spat for 45 seconds.", "Spitting", sentences), "a sentence is a clause too");
  assert.ok(passes("offset", "No crying for 45 seconds.", "Tantrum", sentences));
  // Review round 2, finding 2: her 6 ft also ends an elopement.
  assert.ok(passes("offset", "The child is back within 6 feet of the supervising adult.", "Elopement"));
  // A line of hers that changes no default adds its thresholds in the three fields.
  assert.ok(passes("onset", "The child is more than 3 feet from the assigned spot.", "Leaving task area", "- Leaving the task area: more than 3 feet from the assigned spot."));
});

test("review of T2, finding 1: a default's number is never a count: invented counts in antecedents, examples and the baseline are refused; an extracted threshold needs its quote", () => {
  const problemsWith = (change: (behavior: Record<string, unknown>) => void) => {
    const answer = behaviorsAnswer({ obs: "o", interview: "i" }, []);
    change((answer.behaviors as Array<Record<string, unknown>>)[0]);
    return checkMapAnswer("map-behaviors", parsedBehaviors(answer), checkContext()).problems;
  };
  const cited = [ref("o", "spat toward his mother's forearm")];
  assert.ok(problemsWith((b) => (b.antecedents = [claim("A worksheet set down in 6 of 10 episodes", cited, "ai-drafted")])).some((p) => /antecedents\[0\]: the number 6, 10/.test(p)));
  assert.ok(problemsWith((b) => (b.examples = [claim("The child spat 5 times at his mother.", cited, "ai-drafted")])).some((p) => /examples\[0\]: the number 5/.test(p)));
  assert.ok(
    problemsWith((b) => ((b.baseline as { observations: Array<Record<string, unknown>> }).observations[0].value = claim("10", cited, "ai-drafted"))).some((p) => /observations\[0\]\.value: the number 10/.test(p)),
  );
  assert.ok(problemsWith((b) => ((b.baseline as { other: unknown[] }).other = [claim("About 30 a week", cited, "ai-drafted")])).some((p) => /baseline\.other\[0\]: the number 30/.test(p)));
  assert.ok(problemsWith((b) => (b.offset = claim("The child has not spat for 10 seconds in a row.", cited, "extracted"))).some((p) => /offset/.test(p)));
});

test("S2 and S3: 'her' needs a found quote of her section or notes; a mitigation no source states is a proposal", () => {
  const facts = factsAnswer({ obs: "o", interview: "i", pdf: "p" });
  const parsed = parseMapAnswer("map-facts", JSON.stringify(facts));
  assert.ok(parsed.ok);
  const answer = parsed.answer as unknown as { caregivers: Array<Record<string, unknown>> };
  answer.caregivers[0].role = { value: "Mother", refs: [{ kind: "section", id: "medical-necessity", quote: "his mother works nights" }], origin: "her", check: null };
  answer.caregivers[0].mitigation = { value: "Train on weekends", refs: [], origin: "extracted", check: null };
  const checks = checkMapAnswer("map-facts", parsed.answer, checkContext({ sections: [{ id: "medical-necessity", text: "Her section says nothing about work." }] }));
  const parts = toAnswerParts("map-facts", parsed.answer, checks, { notesSession: null, sectionVersions: new Map(), settingIds: new Set(), behaviorIds: new Set() });
  const mother = parts.caregivers!.items[0] as Record<string, { origin: string; check: string | null }>;
  assert.equal(mother.role.origin, "extracted");
  assert.ok(mother.role.check);
  assert.equal(mother.mitigation.origin, "proposed");
});

test("S4: an update keeps the risks' links to the behaviors she approved", async () => {
  const { service, caseId, caseFile, cases } = await setup((found) => ({
    facts: [{ answer: factsAnswer(found) }, { answer: factsAnswer(found) }],
    behaviors: [{ answer: behaviorsAnswer(found, []) }, { answer: behaviorsAnswer(found, [], { behaviors: [], groups: [], risks: [{ key: "new-9", behaviorKeys: ["beh-1", "beh-2"], what: claim("Spitting toward adults", [ref(found.obs, "spat toward his mother's forearm")]), evidence: [], level: none() }] }) }],
  }));
  await draft(service, caseId);
  await cases.changeCase(caseId, (data, _folder, now) => ({ save: approveMapPart(data, "behaviors", 1, now), value: null }));
  await draft(service, caseId);
  const map = stored(caseFile);
  assert.equal(map.parts.behaviors.versions.length, 1, "her approved behaviors are not changed");
  assert.deepEqual(map.parts.risks.versions.at(-1).content.items[0].behaviorIds, ["beh-1", "beh-2"]);
});

test("S8: the measure is a fixed list in the schema, and a group's function and measure must be every member's", () => {
  type Node = { properties: Record<string, Node>; items: Node; enum?: string[] };
  const behaviors = mapAnswerSchema("map-behaviors") as unknown as Node;
  assert.deepEqual(behaviors.properties.behaviors.items.properties.measure.properties.value.enum, ["", "frequency", "duration", "latency", "intensity"]);
  const answer = behaviorsAnswer({ obs: "o", interview: "i" }, []);
  (answer.groups as Array<Record<string, unknown>>)[0].function = "attention";
  (answer.groups as Array<Record<string, unknown>>)[0].measure = "duration";
  const result = checkMapAnswer("map-behaviors", parsedBehaviors(answer), checkContext());
  assert.ok(result.problems.some((problem) => /function attention is not a primary function of "new-1"/.test(problem)));
  assert.ok(result.problems.some((problem) => /measure duration is not the measure of "new-1"/.test(problem)));
});

test("a count that is in none of its quotes, a behavior in two groups, and an unknown setting are problems; quotes compare loosely but never by fragments", () => {
  const found = { obs: "o", interview: "i" };
  const answer = behaviorsAnswer(found, []);
  (answer.behaviors as Array<{ baseline: { observations: Array<Record<string, unknown>> } }>)[0].baseline.observations[0].value = claim("4", [ref("o", "Spitting counts: 3 on 11/04")]);
  const result = checkMapAnswer("map-behaviors", parsedBehaviors(answer), checkContext());
  assert.ok(result.problems.some((problem) => /the number 4 in "4" is not written in any of its quotes/.test(problem)));
  (answer.groups as unknown[]).push({ key: "new-9", behaviorKeys: ["new-1"], nature: "Again", function: "escape", measure: "frequency", reason: "" });
  (answer.behaviors as Array<Record<string, unknown>>)[0].settingIds = ["set-9"];
  const again = checkMapAnswer("map-behaviors", parsedBehaviors(answer), checkContext());
  assert.ok(again.problems.some((problem) => /is in two groups/.test(problem)));
  assert.ok(again.problems.some((problem) => /"set-9" is not the id of a setting/.test(problem)));
  // Quotes compare across quote marks, dashes, spaces, case and Markdown (review round 1, S6).
  const loose = behaviorsAnswer(found, []);
  (loose.behaviors as Array<Record<string, unknown>>)[0].consequences = [claim("x", [ref("i", "HE SPITS   and then I have to stop the homework")])];
  const parsed = parsedBehaviors(loose);
  const looseResult = checkMapAnswer("map-behaviors", parsed, checkContext());
  assert.equal(looseResult.quotes.get(parsed.behaviors[0].consequences[0].refs[0]), "found");
  assert.equal(normalizeForQuote("| **Socialization** | 66 | Low |"), normalizeForQuote("Socialization 66 Low"));
  assert.equal(normalizeForQuote("# Direct observation notes\n- she \\*stopped\\* the task"), "direct observation notes she stopped the task");
});

test("M7: numbers compare without leading zeros, and a date's parts are not counts", () => {
  assert.deepEqual(numbersIn("3 on 11/04, 03 more, 4.5 at 12/04/2026"), ["d:11/4", "d:12/4/2026", "3", "3", "4.5"]);
  assert.ok(!numbersIn("on 12/04").includes("12"));
  assert.deepEqual(numbersIn("[MISSING: your threshold for 10 seconds] 2"), ["2"]);
});

test("S7: the minutes of an observation come from its length as the notes write it", () => {
  assert.equal(minutesOfLength("3:30 to 5:30 p.m."), 120);
  assert.equal(minutesOfLength("10:00 a.m. to 12:00 p.m."), 120);
  assert.equal(minutesOfLength("a 2-hour observation"), 120);
  assert.equal(minutesOfLength("1 hour 30 minutes"), 90);
  assert.equal(minutesOfLength("home"), null);
  assert.equal(minutesOfLength("3 to 5"), null, "no guess without a clock time or a unit");
});

test("M5: only a refusal that names the schema or the format switches the route to plain JSON", () => {
  assert.equal(refusedFormat({ code: "bad_request", message: "Anthropic refused the request: output_config.format: schema is not supported" }), true);
  assert.equal(refusedFormat({ code: "bad_request", message: "OpenAI refused the request: Invalid schema for response_format" }), true);
  assert.equal(refusedFormat({ code: "bad_request", message: "Anthropic refused the request: the PDF has more than 100 pages" }), false);
  assert.equal(refusedFormat({ code: "rate_limited", message: "schema" }), false);
});

test("M6: a ref the checks never reached is stored as not found, never as a PDF's 'not checked'", () => {
  const parsed = parseMapAnswer("map-facts", JSON.stringify(factsAnswer({ obs: "o", interview: "i", pdf: "p" })));
  assert.ok(parsed.ok);
  const empty: CheckResult = { problems: [], quotes: new Map(), numbers: new Set(), pdfNumbers: new Set(), failedClaims: new Set(), failing: new Map(), whole: false, unquotedNumbers: new Map(), unquotedFields: new Map(), itemLevel: new Map(), causes: {}, failedValues: 0, failedFields: new Map() };
  const parts = toAnswerParts("map-facts", parsed.answer, empty, { notesSession: null, sectionVersions: new Map(), settingIds: new Set(), behaviorIds: new Set() });
  const role = (parts.caregivers!.items[0] as Record<string, { refs: Array<{ checked: string }> }>).role;
  assert.equal(role.refs[0].checked, "not-found");
});

test("M4: on ChatGPT, a map request has its own preamble and a section request keeps its own", () => {
  const options = (kind?: "case-map"): GenerateOptions => ({ signal: new AbortController().signal, model: "m", effort: "high" as const, maxOutputTokens: 10, credential: { kind: "chatgpt" as const, accessToken: "not-real" }, prompt: { system: "s", sources: [], task: "T", ...(kind ? { kind } : {}) }, cacheKey: null, outputFormat: null });
  assert.ok(String(responsesRequest(options("case-map")).instructions).startsWith(`${CHATGPT_MAP_TASK_PREAMBLE}\n\n`));
  assert.ok(String(responsesRequest(options()).instructions).startsWith(`${CHATGPT_TASK_PREAMBLE}\n\n`));
  assert.match(CHATGPT_MAP_TASK_PREAMBLE, /<her-map>[\s\S]*<map-facts>[\s\S]*<previous-answer>/);
});

test("a route that refuses the JSON schema is asked again for plain JSON, checked the same way", async () => {
  const { service, caseId, caseFile, model } = await setup((found) => ({
    facts: [{ error: new ProviderError("bad_request", "json_schema is not supported here", 400) }, { answer: `Here it is:\n${JSON.stringify(factsAnswer(found))}` }],
    behaviors: [{ answer: behaviorsAnswer(found, []) }],
  }));
  await draft(service, caseId);
  assert.equal(model.sent.length, 3);
  assert.ok(model.sent[0].outputFormat);
  assert.equal(model.sent[1].outputFormat, null);
  assert.match(model.sent[1].prompt.task, /Answer with one JSON object and nothing else/);
  assert.equal(model.sent[2].outputFormat, null, "the route's refusal is remembered");
  assert.equal(stored(caseFile).extractions[0].format, "plain-json");
});

test("an update keeps her items and her approved parts, reuses ids by key, and sends her map", async () => {
  const { service, caseId, caseFile, cases, model } = await setup((found) => ({
    facts: [{ answer: factsAnswer(found) }, { answer: factsAnswer(found) }],
    behaviors: [
      { answer: behaviorsAnswer(found, []) },
      {
        answer: (() => {
          const next = behaviorsAnswer(found, []) as { behaviors: Array<Record<string, unknown>>; groups: Array<Record<string, unknown>>; risks: Array<Record<string, unknown>> };
          next.behaviors[0].key = "beh-1";
          next.behaviors[0].name = claim("Spitting at people", [ref(found.obs, "spat toward his mother's forearm")]);
          next.behaviors[1].key = "new-7";
          next.groups[0].behaviorKeys = ["beh-1", "new-7"];
          next.risks[0].behaviorKeys = ["beh-1"];
          return next;
        })(),
      },
    ],
  }));
  await draft(service, caseId);
  // She corrects beh-1's name by hand and approves the caregivers.
  await cases.changeCase(caseId, (data, _folder, now) => {
    const typed = saveMapItem(data, "behaviors", "items", "beh-1", { name: { value: "Spitting (her name)", check: null } }, null, now);
    assert.ok(typed && typed !== "item-not-found");
    return { save: approveMapPart(typed.data, "caregivers", 1, now), value: null };
  });
  await draft(service, caseId);
  assert.match(model.sent[3].prompt.task, /<her-map>[\s\S]*"id":"beh-1"[\s\S]*Spitting \(her name\)/);
  assert.match(model.sent[2].prompt.task, /<her-map>[\s\S]*"approved":true/, "her approved caregivers go to the facts request");
  const map = stored(caseFile);
  const latest = map.parts.behaviors.versions.at(-1);
  assert.equal(latest.kind, "update");
  assert.deepEqual(
    latest.content.items.map((item: { id: string; name: { value: string } }) => [item.id, item.name.value]),
    [
      ["beh-1", "Spitting (her name)"],
      ["beh-3", "Spitting on the floor"],
    ],
    "her item is kept as hers; a new key gets a new id, never one used before",
  );
  assert.deepEqual(latest.content.groups[0].behaviorIds, ["beh-1", "beh-3"]);
  assert.equal(map.parts.caregivers.versions.length, 1, "her approved part is never changed by the AI");
  assert.equal(map.parts.caregivers.approvedVersion, 1);
});

test("her confirmed thresholds go with the behaviors request as her standing instructions (D16)", async () => {
  const { service, caseId, model } = await setup((found) => ({ facts: [{ answer: factsAnswer(found) }], behaviors: [{ answer: behaviorsAnswer(found, []) }] }), {
    instructions: "End of an episode: the behavior has stopped for 10 seconds in a row.",
  });
  await draft(service, caseId);
  assert.doesNotMatch(model.sent[0].prompt.task, /\n<standing-instructions>\n/);
  assert.match(model.sent[1].prompt.task, /\n<standing-instructions>\nEnd of an episode: the behavior has stopped for 10 seconds/);
});

test("an answer that is not JSON, even after the repair, saves nothing and says so", async () => {
  const { service, caseId, caseFile } = await setup(() => ({ facts: [{ answer: "not json" }, { answer: "still not json" }], behaviors: [] }));
  const events = await draft(service, caseId);
  const error = events.find((event) => event.type === "error");
  assert.ok(error?.type === "error" && error.code === "unreadable_answer");
  assert.equal(stored(caseFile), undefined, "no map written");
});

test("the answer schemas follow strict structured outputs: every object closed and fully required, no limits, no recursion, no union", () => {
  const walk = (schema: unknown, where: string) => {
    if (Array.isArray(schema)) return schema.forEach((entry, index) => walk(entry, `${where}[${index}]`));
    if (typeof schema !== "object" || schema === null) return;
    const node = schema as Record<string, unknown>;
    for (const banned of ["minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems", "pattern", "$ref", "format", "anyOf", "oneOf"]) assert.equal(banned in node, false, `${where} has ${banned}`);
    assert.equal(Array.isArray(node.type), false, `${where} has a type array`);
    if (node.type === "object") {
      assert.equal(node.additionalProperties, false, `${where} is not closed`);
      assert.deepEqual([...(node.required as string[])].sort(), Object.keys(node.properties as object).sort(), `${where} does not require every property`);
    }
    for (const [key, value] of Object.entries(node)) walk(value, `${where}.${key}`);
  };
  walk(mapAnswerSchema("map-facts"), "facts");
  walk(mapAnswerSchema("map-behaviors"), "behaviors");
});

test("a claim whose value is one of a fixed list carries that list in the schema (the real run's settings and strengths)", () => {
  type Node = { properties: Record<string, Node>; items: Node; enum?: string[] };
  const facts = mapAnswerSchema("map-facts") as unknown as Node;
  const valueOf = (claim: Node) => claim.properties.value.enum;
  const settings = facts.properties.settings.items.properties;
  assert.deepEqual(valueOf(settings.kind), ["", "home", "school", "community", "clinic", "other"]);
  assert.deepEqual(valueOf(settings.evidence), ["", "observed", "reported"]);
  assert.deepEqual(valueOf(facts.properties.strengths.items.properties.kind), ["", "strength", "interest", "preference", "reinforcer"]);
  assert.deepEqual(valueOf(facts.properties.client.properties.otherServices.items.properties.paid), ["", "paid", "not-paid"]);
});

/* Review round 2 */

const withPdf = (extra: Partial<CheckContext> = {}) => checkContext({ sources: [...checkContext().sources, { id: "p", title: "Vineland-3 report", text: null }], ...extra });

test("R2-S1: a PDF ref next to a found text quote does not turn off the number and threshold checks", () => {
  const answer = behaviorsAnswer({ obs: "o", interview: "i" }, []);
  const [first] = answer.behaviors as Array<Record<string, unknown>>;
  // The review's probe: a count in neither quote, one quote found in the notes, one a PDF's.
  first.antecedents = [claim("7 of 8 episodes followed a demand", [ref("o", "she set the reading worksheet on the table"), ref("p", "demands at home")])];
  // A threshold nobody gave, cited with a text quote and a PDF.
  first.offset = claim("The child has not spat for 15 seconds.", [ref("o", "spat toward his mother's forearm"), ref("p", "spitting episodes")], "ai-drafted");
  // A score only in the PDF's quote, next to a found text quote: passes, marked [CHECK].
  first.consequences = [claim("Communication standard score 68", [ref("o", "she stopped the worksheet to clean up"), ref("p", "Communication 68")])];
  const parsed = parsedBehaviors(answer);
  const result = checkMapAnswer("map-behaviors", parsed, withPdf());
  assert.ok(result.problems.some((problem) => /antecedents\[0\]: the number 7, 8 in/.test(problem)), result.problems.join(" | "));
  assert.ok(result.problems.some((problem) => /offset: .*gives a threshold that no quote gives and that is not her default or her own for this place/.test(problem)));
  assert.ok(!result.problems.some((problem) => /consequences\[0\]/.test(problem)));
  const score = parsed.behaviors[0].consequences[0];
  assert.ok(result.pdfNumbers.has(score));
  const parts = toAnswerParts("map-behaviors", parsed, result, { notesSession: null, sectionVersions: new Map(), settingIds: new Set(), behaviorIds: new Set() });
  const stored = (parts.behaviors!.items[0] as unknown as { consequences: Array<{ check: string | null }> }).consequences[0];
  assert.match(stored.check ?? "", /only in a PDF's quote/);
  // Only PDFs cited: nothing can be checked, as before (D32).
  first.antecedents = [claim("7 of 8 episodes followed a demand", [ref("p", "demands at home")])];
  assert.ok(!checkMapAnswer("map-behaviors", parsedBehaviors(answer), withPdf()).problems.some((problem) => /antecedents/.test(problem)));
});

test("R2-S2: a repair that leaves a field empty keeps the first answer's value; the client is merged field by field too", () => {
  const found = { obs: "o", interview: "i" };
  const first = behaviorsAnswer(found, []);
  (first.behaviors as Array<Record<string, unknown>>)[0].examples = [claim("He spat at the wall", [ref("o", "words that are nowhere")])];
  // The review's probe: the repair gives a good example and an empty definition.
  const repaired = behaviorsAnswer(found, [], { behaviors: [{ ...(behaviorsAnswer(found, []).behaviors as Array<Record<string, unknown>>)[0], examples: [claim("The child spat toward his mother's forearm", [ref("o", "spat toward his mother's forearm twice")])], definition: none(), onset: none() }], groups: [], risks: [] });
  const a = parsedBehaviors(first);
  const b = parsedBehaviors(repaired);
  const firstChecks = checkMapAnswer("map-behaviors", a, checkContext());
  const merged = mergeRepair("map-behaviors", a, b, firstChecks.failing, false, firstChecks.failedClaims) as BehaviorsAnswer;
  assert.equal(merged.behaviors.length, 2);
  assert.match(merged.behaviors[0].definition?.value ?? "", /forcefully expels saliva/, "the first answer's definition is kept");
  assert.equal(merged.behaviors[0].examples[0].value, "The child spat toward his mother's forearm", "the repair's example replaces the failed one");
  assert.equal(merged.groups.length, 1, "the groups the repair left out are kept");
  // The client: the first answer's age stays when the repair gives only the severity level.
  const ids = { obs: "o", interview: "i", pdf: "p" };
  const withAge = factsAnswer(ids, { client: { ...absentClient(), age: claim("7 years", [ref("i", "Mother interview, invented")]) } });
  const onlySeverity = factsAnswer(ids, { client: { ...absentClient(), severityLevel: claim("Level 2", [ref("i", "Mother interview, invented")]) }, caregivers: [], settings: [], deficits: [], openItems: [] });
  const pa = parseMapAnswer("map-facts", JSON.stringify(withAge));
  const pb = parseMapAnswer("map-facts", JSON.stringify(onlySeverity));
  assert.ok(pa.ok && pb.ok);
  const client = (mergeRepair("map-facts", pa.answer, pb.answer, new Map([["client", new Set([0])]])) as FactsAnswer).client;
  assert.equal(client?.age?.value, "7 years");
  assert.equal(client?.severityLevel?.value, "Level 2");
});

test("R2-M2: after a whole-answer repair, a key the first answer used twice is not doubled", () => {
  const found = { obs: "o", interview: "i" };
  const base = (behaviorsAnswer(found, []).behaviors as Array<Record<string, unknown>>)[0];
  const named = (key: string, name: string) => ({ ...base, key, name: claim(name, [ref("o", "spat toward his mother's forearm")]) });
  const first = parsedBehaviors(behaviorsAnswer(found, [], { behaviors: [named("new-1", "Hitting"), named("new-1", "Hitting"), named("new-2", "Kicking")], groups: [], risks: [] }));
  const repaired = parsedBehaviors(behaviorsAnswer(found, [], { behaviors: [named("new-1", "Hitting"), named("new-3", "Hitting again"), named("new-2", "Kicking")], groups: [], risks: [] }));
  const merged = mergeRepair("map-behaviors", first, repaired, new Map(), true) as BehaviorsAnswer;
  assert.deepEqual(
    merged.behaviors.map((item) => [item.key, item.name?.value]),
    [
      ["new-1", "Hitting"],
      ["new-3", "Hitting again"],
      ["new-2", "Kicking"],
    ],
  );
});

test("R2-M3: the [CHECK] written on an empty value becomes an open item", () => {
  const facts = factsAnswer({ obs: "o", interview: "i", pdf: "p" }, { client: { ...absentClient(), severityLevel: claim("", [], "extracted", "the evaluation gives no severity level") } });
  const parsed = parseMapAnswer("map-facts", JSON.stringify(facts));
  assert.ok(parsed.ok);
  const answer = parsed.answer as FactsAnswer;
  assert.equal(answer.client, null, "the empty value itself is still left out");
  assert.ok(answer.openItems.some((item) => item.kind === "check" && item.text === "the evaluation gives no severity level"), "no code path in the text (R3-M2)");
});

test("R2-M1: a length written twice is counted once, a range or a disagreement gives nothing", () => {
  assert.equal(minutesOfLength("a 2-hour observation (120 minutes)"), 120);
  assert.equal(minutesOfLength("2 hours (90 minutes)"), null);
  assert.equal(minutesOfLength("1-2 hours"), null);
  assert.equal(minutesOfLength("30 to 45 minutes"), null);
  assert.equal(minutesOfLength("1 hour and 30 minutes"), 90);
  assert.equal(minutesOfLength("1.5 hrs"), 90);
});

test("R2-M6: a date written another way is the same date: two-digit years, month names, a date without its year", () => {
  assert.deepEqual(numbersIn("5/14/26"), ["d:5/14/2026"]);
  assert.deepEqual(numbersIn("May 14, 2026"), ["d:5/14/2026"]);
  assert.deepEqual(numbersIn("on Nov. 4"), ["d:11/4"]);
  const answer = behaviorsAnswer({ obs: "o", interview: "i" }, []);
  const observation = (answer.behaviors as Array<{ baseline: { observations: Array<Record<string, unknown>> } }>)[0].baseline.observations[0];
  observation.date = claim("11/04/26", [ref("o", "11/04/2026, home, 2 hours")]);
  observation.value = claim("3 on November 4, 2026", [ref("o", "Spitting counts: 3 on 11/04")]);
  const result = checkMapAnswer("map-behaviors", parsedBehaviors(answer), checkContext());
  assert.deepEqual(result.problems.filter((problem) => /observations/.test(problem)), []);
});

/* Review scoped check of f9ee1c6 */

test("R3-M1: a repair that returns a shorter claim list keeps the first answer's claims that passed", () => {
  const found = { obs: "o", interview: "i" };
  const first = behaviorsAnswer(found, []);
  // The probe: two examples, only the first one fails.
  (first.behaviors as Array<Record<string, unknown>>)[0].examples = [claim("bad", [ref("o", "words that are nowhere at all")]), claim("The child spat toward his mother's forearm", [ref("o", "spat toward his mother's forearm twice")])];
  const a = parsedBehaviors(first);
  const checks = checkMapAnswer("map-behaviors", a, checkContext());
  assert.ok(checks.failedClaims.has(a.behaviors[0].examples[0]));
  assert.ok(!checks.failedClaims.has(a.behaviors[0].examples[1]));
  const repaired = behaviorsAnswer(found, [], { behaviors: [{ ...(behaviorsAnswer(found, []).behaviors as Array<Record<string, unknown>>)[0], examples: [claim("He spat once on the floor", [ref("o", "he spat once on the floor")])] }], groups: [], risks: [] });
  const merged = mergeRepair("map-behaviors", a, parsedBehaviors(repaired), checks.failing, false, checks.failedClaims) as BehaviorsAnswer;
  assert.deepEqual(
    merged.behaviors[0].examples.map((example) => example.value),
    ["The child spat toward his mother's forearm", "He spat once on the floor"],
    "the example that passed stays; the failed one is replaced",
  );
  // The repair giving the same value again does not double it.
  const again = behaviorsAnswer(found, [], { behaviors: [{ ...(behaviorsAnswer(found, []).behaviors as Array<Record<string, unknown>>)[0], examples: [claim("the child spat toward his mother's forearm", [ref("o", "spat toward his mother's forearm twice")])] }], groups: [], risks: [] });
  const mergedAgain = mergeRepair("map-behaviors", a, parsedBehaviors(again), checks.failing, false, checks.failedClaims) as BehaviorsAnswer;
  assert.equal(mergedAgain.behaviors[0].examples.length, 1);
});

test("R3-M2: the note of an empty value names its item in words, never by a code path", () => {
  const answer = behaviorsAnswer({ obs: "o", interview: "i" }, []);
  (answer.behaviors as Array<Record<string, unknown>>)[1].offset = claim("", [], "ai-drafted", "no threshold for the end of an episode was given");
  const parsed = parseMapAnswer("map-behaviors", JSON.stringify(answer));
  assert.ok(parsed.ok);
  const texts = parsed.answer.openItems.map((item) => item.text);
  assert.ok(texts.includes("Spitting on the floor: no threshold for the end of an episode was given"), texts.join(" | "));
  assert.ok(!texts.some((text) => /behaviors\[|\.offset/.test(text)));
});

/* Review check of 039ce31 */

test("R4-M1: a repair that returns only the fixed observation keeps the observations that passed", () => {
  const found = { obs: "o", interview: "i" };
  const counts = "11/05/2026, home, 2 hours. 11/06/2026, home, 2 hours. Spitting counts: 3 on 11/04, 1 on 11/05, 2 on 11/06.";
  const context = checkContext({ sources: [...checkContext().sources, { id: "q", title: "More observations", text: counts }] });
  const observation = (date: string, value: string, quote: string) => ({ date: claim(date, [ref("q", `${date}, home, 2 hours`)]), setting: claim("Home", [ref("q", `${date}, home, 2 hours`)]), length: claim("2 hours", [ref("q", `${date}, home, 2 hours`)]), value: claim(value, [ref("q", quote)]) });
  const withObservations = (observations: unknown[]) => {
    const answer = behaviorsAnswer(found, []);
    const behavior = (answer.behaviors as Array<{ baseline: { observations: unknown[] } }>)[0];
    behavior.baseline.observations = observations;
    return answer;
  };
  const fixture = (behaviorsAnswer(found, []).behaviors as Array<{ baseline: { observations: unknown[] } }>)[0].baseline.observations[0];
  // The probe: 11/04=3, 11/05=9 and 11/06=2; only the 11/05 value fails ("9" is not in its quote).
  const a = parsedBehaviors(withObservations([fixture, observation("11/05/2026", "9", "1 on 11/05"), observation("11/06/2026", "2", "2 on 11/06")]));
  const checks = checkMapAnswer("map-behaviors", a, context);
  const failedValues = a.behaviors[0].baseline.observations.map((entry) => checks.failedClaims.has(entry.value!));
  assert.deepEqual(failedValues, [false, true, false], checks.problems.join(" | "));
  // The repair returns only the fixed 11/05 observation.
  const repaired = parsedBehaviors(withObservations([observation("11/05/2026", "1", "1 on 11/05")]));
  const merged = mergeRepair("map-behaviors", a, repaired, checks.failing, false, checks.failedClaims) as BehaviorsAnswer;
  const rows = (answer: BehaviorsAnswer) => answer.behaviors[0].baseline.observations.map((entry) => `${entry.date?.value}=${entry.value?.value}`);
  assert.deepEqual(rows(merged), ["11/04/2026=3", "11/05/2026=1", "11/06/2026=2"], "the counts that passed stay; the failed one is replaced in place");
  assert.ok(!checkMapAnswer("map-behaviors", merged, context).problems.some((problem) => /observations/.test(problem)));
  // A repair that leaves the failed observation out drops it, as the repair was asked to fix it; the passed ones stay.
  const other = parsedBehaviors(withObservations([observation("11/06/2026", "2", "2 on 11/06")]));
  assert.deepEqual(rows(mergeRepair("map-behaviors", a, other, checks.failing, false, checks.failedClaims) as BehaviorsAnswer), ["11/04/2026=3", "11/06/2026=2"]);
  // A function's evidence is merged by tool and respondent the same way: the mother's interview stays next to a new entry.
  const teacher = parsedBehaviors(behaviorsAnswer(found, []));
  teacher.behaviors[0].function.evidence = [{ ...teacher.behaviors[0].function.evidence[0], respondent: "Teacher" }];
  const evidence = (mergeRepair("map-behaviors", a, teacher, checks.failing, false, checks.failedClaims) as BehaviorsAnswer).behaviors[0].function.evidence;
  assert.deepEqual(evidence.map((entry) => entry.respondent), ["Mother", "Teacher"]);
});

/* Case map speed (2026-11-23): one claim per score row, repairs of only what failed, and the items shown as they arrive. */

/** A behavior in the wire's form with every value empty but its key: what a repair about a few values answers around them. */
function emptyBehavior(key: string, overrides: Answer = {}): Answer {
  return {
    key,
    name: none(),
    topographies: [],
    measure: none(),
    definition: none(),
    onset: none(),
    offset: none(),
    examples: [],
    nonExamples: [],
    baseline: { observations: [], other: [] },
    settingIds: [],
    antecedents: [],
    consequences: [],
    function: { primary: [], secondary: [], evidence: [], reasoning: "", check: "" },
    barriers: [],
    risks: [],
    ...overrides,
  };
}

test("speed: a score row is one claim on the wire, every number of the row is checked against its quotes, and it is stored as five claims", () => {
  const scores = (mapAnswerSchema("map-facts") as { properties: { deficits: { items: { properties: { scores: { items: { required: string[] } } } } } } }).properties.deficits.items.properties.scores.items;
  assert.deepEqual(scores.required, ["instrument", "scale", "score", "percentile", "level", "refs", "origin", "check"], "one claim per row");
  const report = "Score report, invented.\nVineland-3 Adaptive Behavior Scales\n| Communication | 68 | 2 | Low |\n| Socialization | 74 | 4 | Moderately low |";
  const context = checkContext({ sources: [{ id: "v", title: "Vineland", text: report }] });
  const row = (fields: Answer, refs: unknown[]) => ({ instrument: "Vineland-3", scale: "Communication", score: "68", percentile: "2", level: "Low", refs, origin: "extracted", check: "", ...fields });
  const withRows = (rows: unknown[]) => {
    const answer = factsAnswer({ obs: "o", interview: "i", pdf: "p" }, { caregivers: [], settings: [], deficits: [{ key: "new-1", area: claim("Communication", [ref("v", "Communication | 68 | 2")]), scores: rows, evidence: [], impact: none() }] });
    const parsed = parseMapAnswer("map-facts", JSON.stringify(answer));
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.problems.join("; "));
    return parsed.answer as FactsAnswer;
  };
  // The row's line and the report's title: every number found, the instrument's "3" too.
  const good = withRows([row({}, [ref("v", "Communication | 68 | 2 | Low"), ref("v", "Vineland-3 Adaptive Behavior Scales")])]);
  assert.deepEqual(checkMapAnswer("map-facts", good, context).problems, []);
  // Without the title, the instrument's number is in no quote: still checked, as when it was its own claim.
  const noTitle = checkMapAnswer("map-facts", withRows([row({}, [ref("v", "Communication | 68 | 2 | Low")])]), context);
  assert.match(noTitle.problems.join("\n"), /deficits\[0\]\.scores\[0\]: the number 3 in "Vineland-3 · Communication · 68 · 2 · Low" is not written/);
  // A score the line does not give: a problem of the row, flagged on the score when stored.
  const wrong = withRows([row({ score: "86" }, [ref("v", "Communication | 68 | 2 | Low"), ref("v", "Vineland-3 Adaptive Behavior Scales")])]);
  const checks = checkMapAnswer("map-facts", wrong, context);
  assert.equal(checks.problems.length, 1);
  assert.equal(checks.causes["number-not-quoted"], 1);
  const parts = toAnswerParts("map-facts", wrong, checks, { notesSession: null, sectionVersions: new Map(), settingIds: new Set(), behaviorIds: new Set() });
  const stored = (parts.deficits!.items[0] as unknown as { scores: Array<Record<string, { value: string; refs: Array<{ quote: string; checked: string }>; check: string | null } | null>> }).scores[0];
  assert.deepEqual(Object.keys(stored), ["instrument", "scale", "score", "percentile", "level"], "the stored shape is today's five claims");
  assert.equal(stored.score!.value, "86");
  assert.match(stored.score!.check ?? "", /not written in the quote/);
  assert.equal(stored.percentile!.check, null, "the other fields carry no check");
  assert.equal(stored.instrument!.check, null);
  for (const field of ["instrument", "scale", "score", "percentile", "level"]) assert.deepEqual(stored[field]!.refs.map((item) => item.quote), ["Communication | 68 | 2 | Low", "Vineland-3 Adaptive Behavior Scales"], `${field} keeps the row's refs`);
  // A blank field of the report is an empty field of the row, stored as no claim; a row with no field at all is no row.
  const blank = withRows([row({ percentile: "", level: "" }, [ref("v", "Communication | 68 | 2 | Low"), ref("v", "Vineland-3 Adaptive Behavior Scales")]), row({ instrument: "", scale: "", score: "", percentile: "", level: "" }, [])]);
  assert.equal(blank.deficits[0].scores.length, 1);
  const blankStored = toAnswerParts("map-facts", blank, checkMapAnswer("map-facts", blank, context), { notesSession: null, sectionVersions: new Map(), settingIds: new Set(), behaviorIds: new Set() });
  assert.equal((blankStored.deficits!.items[0] as unknown as { scores: Array<Record<string, unknown>> }).scores[0].percentile, null);
});

test("speed: a repair quotes only the values that failed, under their item's key; the answer around them is merged back and why is recorded", async () => {
  const { service, caseId, caseFile, model } = await setup((found) => {
    const first = behaviorsAnswer(found, []);
    const behaviors = first.behaviors as Array<Record<string, unknown>>;
    behaviors[0].examples = [claim("He spat at his mother's arm during homework", [ref(found.obs, "spat toward his mother's forearm twice")]), claim("He spat at his brother at dinner", [ref(found.obs, "spat at his brother during dinner")])];
    // The repair answers the one example that failed, every other value empty.
    const repair = { behaviors: [emptyBehavior("new-1", { examples: [claim("He spat once on the floor next to his grandmother", [ref(found.obs, "he spat once on the floor next to his grandmother")])] })], groups: [], risks: [], openItems: [] };
    return { facts: [{ answer: factsAnswer(found) }], behaviors: [{ answer: first }, { answer: repair }] };
  });
  const events = await draft(service, caseId);
  assert.equal(model.sent.length, 3);
  const task = model.sent[2].prompt.task;
  const previous = JSON.parse(task.slice(task.indexOf("<previous-answer>") + "<previous-answer>".length, task.indexOf("</previous-answer>")).trim()) as { behaviors: Array<Record<string, unknown>> };
  assert.deepEqual(Object.keys(previous), ["behaviors"], "lists with nothing to fix are left out");
  assert.deepEqual(previous.behaviors.length, 1, "only the item that failed");
  assert.deepEqual(Object.keys(previous.behaviors[0]), ["key", "examples"], "and of it, only its key and the value that failed");
  assert.deepEqual((previous.behaviors[0].examples as Array<{ value: string }>).map((example) => example.value), ["He spat at his brother at dinner"]);
  assert.match(task, /behaviors\[0\]\.examples\[1\]\.refs\[0\]: the quote "spat at his brother during dinner" is not found word for word in the source "[^"]+"\. \(item "new-1"\)/);
  assert.match(task, /Leave empty every value and every list that <previous-answer> does not show/);
  const map = stored(caseFile);
  const spitting = map.parts.behaviors.versions[0].content.items[0];
  assert.deepEqual(
    spitting.examples.map((example: { value: string }) => example.value),
    ["He spat at his mother's arm during homework", "He spat once on the floor next to his grandmother"],
    "the example that passed stays; the failed one is replaced",
  );
  assert.match(spitting.definition.value, /^Any instance/, "what the repair left empty stays as it was");
  assert.equal(spitting.name.value, "Spitting");
  assert.equal(spitting.baseline.observations.length, 1);
  assert.equal(map.parts.behaviors.versions[0].content.items.length, 2);
  const record = map.extractions[1];
  assert.equal(record.repairScope, "values");
  assert.deepEqual(record.repairCauses, { "quote-not-found": 1 }, "why the repair happened");
  assert.equal(record.repairValues, 1);
  assert.deepEqual(record.problems, []);
  assert.equal(typeof record.seconds.answer, "number");
  assert.equal(typeof record.seconds.repair, "number");
  assert.equal(map.extractions[0].seconds.repair, undefined, "no repair, no repair time");
  // The screen hears how many values the repair fixes.
  assert.ok(events.some((event) => event.type === "map-progress" && event.step === "map-behaviors" && event.phase === "repairing" && event.values === 1));
  // And what the repair asks for again, so the line says "those values only" only then (review round 1 of case map speed, S5).
  assert.ok(events.filter((event) => event.type === "map-progress" && event.phase === "repairing").every((event) => event.type === "map-progress" && event.scope === "values"));
});

test("speed: an item with a problem of its own (a link, a function twice) is quoted whole; the scope says so", async () => {
  const { service, caseId, caseFile, model } = await setup((found) => {
    const first = behaviorsAnswer(found, []);
    const behaviors = first.behaviors as Array<Record<string, unknown>>;
    behaviors[0].examples = [claim("He spat at his brother at dinner", [ref(found.obs, "spat at his brother during dinner")])];
    behaviors[1].function = { primary: ["escape"], secondary: ["escape"], evidence: [], reasoning: "", check: "" };
    return { facts: [{ answer: factsAnswer(found) }], behaviors: [{ answer: first }, { answer: { behaviors: [], groups: [], risks: [], openItems: [] } }] };
  });
  const events = await draft(service, caseId);
  assert.ok(events.some((event) => event.type === "map-progress" && event.phase === "repairing" && event.scope === "items" && event.values === 2), "the screen hears that items are rewritten");
  const task = model.sent[2].prompt.task;
  const previous = JSON.parse(task.slice(task.indexOf("<previous-answer>") + "<previous-answer>".length, task.indexOf("</previous-answer>")).trim()) as { behaviors: Array<Record<string, unknown>> };
  assert.deepEqual(Object.keys(previous.behaviors[0]), ["key", "examples"], "new-1: only its failed value");
  assert.equal(previous.behaviors[1].key, "new-2");
  assert.ok("definition" in previous.behaviors[1] && "baseline" in previous.behaviors[1], "new-2: whole, as the AI wrote it");
  const record = stored(caseFile).extractions[1];
  assert.equal(record.repairScope, "items");
  assert.deepEqual(record.repairCauses, { "quote-not-found": 1, "function-both": 1 });
  assert.equal(record.repairValues, 2);
  assert.equal(record.repairUsed, true);
  // The repair answered nothing: the first answer is kept whole, its problems flagged.
  assert.equal(record.problems.length, 2);
});

test("speed: each item that passes its own checks is shown as it arrives, before its request saves; one that fails is not", async () => {
  const { service, caseId, caseFile } = await setup((found) => {
    const facts = factsAnswer(found);
    (facts.caregivers as Array<Record<string, unknown>>)[0].role = claim("Mother", [ref(found.interview, "the mother said she works nights")]);
    const fixed = factsAnswer(found, { caregivers: [(factsAnswer(found).caregivers as unknown[])[0]], settings: [], deficits: [], openItems: [] });
    return { facts: [{ answer: facts }, { answer: fixed }], behaviors: [{ answer: behaviorsAnswer(found, []) }] };
  });
  const events = await draft(service, caseId);
  const previews = events.filter((event) => event.type === "map-preview");
  const factsSaved = events.findIndex((event) => event.type === "map-saved" && event.step === "map-facts");
  const factsPreviews = previews.filter((event) => event.type === "map-preview" && event.step === "map-facts");
  assert.deepEqual(
    factsPreviews.map((event) => event.type === "map-preview" && event.id),
    ["preview:map-facts:caregivers:1", "preview:map-facts:settings:0", "preview:map-facts:settings:1", "preview:map-facts:deficits:0", "preview:map-facts:openItems:0"],
    "the caregiver whose quote fails is not shown; the empty client is nothing to show",
  );
  assert.ok(factsPreviews.every((event) => events.indexOf(event) < factsSaved), "shown before the request saves");
  const setting = factsPreviews[1];
  assert.ok(setting.type === "map-preview" && setting.part === "settings");
  const item = setting.item as { key: string; name: { value: string; refs: Array<{ checked: string }> } };
  assert.equal(item.name.value, "Home");
  assert.equal(item.name.refs[0].checked, "found", "in the map's stored shape, with its checks");
  // The progress counts what arrived and what was shown, for the writing answer only.
  const writing = events.filter((event) => event.type === "map-progress" && event.step === "map-facts" && event.phase === "writing");
  const last = writing.at(-1);
  assert.ok(last?.type === "map-progress");
  assert.deepEqual([last.arrived, last.shown], [7, 5]);
  // The behaviors: a risk that names a behavior that arrived before it is shown too; groups wait for the save.
  const behaviorsPreviews = previews.filter((event) => event.type === "map-preview" && event.step === "map-behaviors").map((event) => event.type === "map-preview" && event.part);
  assert.deepEqual(behaviorsPreviews, ["behaviors", "behaviors", "risks"]);
  // Nothing is saved by a preview: the saved map is the request's, after its checks and repair.
  assert.equal(stored(caseFile).parts.caregivers.versions[0].content.items[0].role.refs[0].checked, "found");
});

/* A value over a length limit is that value's own problem (owner's decision, 2026-11-23): repaired alone, never the whole answer. */

/** The observation notes' first three lines, one passage over the 300 characters a quote may hold. */
const LONG_QUOTE = OBSERVATIONS.split("\n").slice(0, 3).join(" ");
const LONG_DATE = "11/04/2026, in the afternoon, at home, after school and homework";

test("limits: a value or a quote over its limit no longer makes the answer unreadable; it is the value's own problem", () => {
  assert.ok(LONG_QUOTE.length > 300 && LONG_DATE.length > 40);
  const answer = factsAnswer({ obs: "o", interview: "i", pdf: "p" }, {
    client: { ...absentClient(), evaluationDate: claim(LONG_DATE, [ref("o", "11/04/2026, home, 2 hours")]) },
    deficits: [],
    facts: [{ key: "new-9", text: claim("The first home observation was on 11/04/2026.", [ref("o", LONG_QUOTE)]), homeSection: 3 }],
    openItems: [{ kind: "missing", text: "x".repeat(2000), homeSection: 0 }],
  });
  const parsed = parseMapAnswer("map-facts", JSON.stringify(answer));
  assert.ok(parsed.ok, "readable: the lengths are the code checks' now");
  const checks = checkMapAnswer("map-facts", parsed.answer, checkContext());
  const long = checks.problems.filter((text) => /characters long/.test(text));
  assert.equal(long.length, 2, checks.problems.join("\n"));
  assert.match(long.join("\n"), /client\.evaluationDate\.value: it is 64 characters long, and this field takes at most 40/);
  assert.match(long.join("\n"), /facts\[0\]\.text\.refs\[0\]: the quote .* is \d+ characters long, and a quote takes at most 300/);
  assert.equal(checks.causes["too-long"], 2);
  assert.equal(checks.whole, false);
  // The long quote is found word for word all the same.
  assert.equal(checks.quotes.get((parsed.answer as FactsAnswer).facts[0].text!.refs[0]), "found");
  // The repair quotes those two values only.
  const input = repairInput("map-facts", parsed.raw, parsed.answer, checks);
  assert.equal(input.scope, "values");
  assert.deepEqual(Object.keys(input.previousAnswer).sort(), ["client", "facts"]);
  assert.deepEqual(Object.keys(input.previousAnswer.client as object), ["evaluationDate"]);
  assert.deepEqual(Object.keys((input.previousAnswer.facts as Array<object>)[0]), ["key", "text"]);
  // An open item (never repaired: the AI's note to her) over its limit is cut to fit.
  const note = (parsed.answer as FactsAnswer).openItems[0].text;
  assert.equal(note.length, 1500);
  assert.ok(note.endsWith("…"));
});

test("limits: a draft whose values are too long is repaired value by value; what is still too long is cut to fit, flagged, and saved", async () => {
  for (const fixes of [true, false]) {
    const { service, caseId, caseFile, model } = await setup((found) => {
      const first = factsAnswer(found, {
        client: { ...absentClient(), evaluationDate: claim(LONG_DATE, [ref(found.obs, "11/04/2026, home, 2 hours")]) },
        facts: [{ key: "new-9", text: claim("The first home observation was on 11/04/2026.", [ref(found.obs, LONG_QUOTE)]), homeSection: 3 }],
      });
      const repair = fixes
        ? factsAnswer(found, {
            client: { ...absentClient(), evaluationDate: claim("11/04/2026", [ref(found.obs, "11/04/2026, home, 2 hours")]) },
            caregivers: [],
            settings: [],
            deficits: [],
            facts: [{ key: "new-9", text: claim("The first home observation was on 11/04/2026.", [ref(found.obs, "11/04/2026, home, 2 hours")]), homeSection: 0 }],
            openItems: [],
          })
        : first;
      return { facts: [{ answer: first }, { answer: repair }], behaviors: [{ answer: behaviorsAnswer(found, []) }] };
    });
    const events = await draft(service, caseId);
    assert.equal(model.sent.length, 3, "one repair, then the behaviors");
    const previous = model.sent[1].prompt.task.slice(model.sent[1].prompt.task.indexOf("<previous-answer>"), model.sent[1].prompt.task.indexOf("</previous-answer>"));
    assert.doesNotMatch(previous, /Grandmother|Laundromat|Vineland/, "never the whole answer");
    const map = stored(caseFile);
    const record = map.extractions[0];
    assert.equal(record.repairScope, "values");
    assert.deepEqual(record.repairCauses, { "too-long": 2 });
    assert.equal(record.repairValues, 2);
    assert.ok(events.some((event) => event.type === "map-saved" && event.step === "map-facts" && event.result.outcome === "saved"), "saved");
    const client = map.parts.client.versions[0].content.items[0];
    const fact = map.parts.facts.versions[0].content.items[0];
    assert.equal(map.parts.caregivers.versions[0].content.items.length, 2, "the rest of the first answer is kept");
    if (fixes) {
      assert.equal(client.evaluationDate.value, "11/04/2026");
      assert.equal(fact.text.refs[0].quote, "11/04/2026, home, 2 hours");
      assert.equal(fact.homeSection, 3, "what the repair left empty stays as it was");
      assert.deepEqual(record.problems, []);
    } else {
      assert.ok(client.evaluationDate.value.length <= 40 && client.evaluationDate.value.endsWith("…"), client.evaluationDate.value);
      assert.match(client.evaluationDate.check, /longer than the map allows/);
      const quote = fact.text.refs[0].quote as string;
      assert.ok(quote.length <= 300 && LONG_QUOTE.startsWith(quote), "the first words that fit, still word for word");
      assert.equal(fact.text.refs[0].checked, "found");
      assert.equal(record.problems.length, 2);
    }
  }
});

test("limits: a reasoning, a group's reason or a respondent too long is quoted alone and merged back alone", () => {
  const found = { obs: "o", interview: "i" };
  const first = behaviorsAnswer(found, []);
  const behavior = (first.behaviors as Array<Record<string, unknown>>)[0];
  behavior.function = { ...(behavior.function as Record<string, unknown>), reasoning: "r".repeat(1600), evidence: [{ tool: "interview", respondent: "M".repeat(130), result: claim("Spitting stops the homework", [ref("i", "he spits and then I have to stop the homework to clean")]), supports: ["escape"] }] };
  (first.groups as Array<Record<string, unknown>>)[0].reason = "g".repeat(1600);
  const a = parsedBehaviors(first);
  const checks = checkMapAnswer("map-behaviors", a, checkContext());
  assert.equal(checks.causes["too-long"], 3, checks.problems.join("\n"));
  const input = repairInput("map-behaviors", first, a, checks);
  assert.equal(input.scope, "values");
  const quoted = input.previousAnswer as { behaviors: Array<Record<string, unknown>>; groups: Array<Record<string, unknown>> };
  assert.deepEqual(Object.keys(quoted.behaviors[0]), ["key", "function"]);
  assert.deepEqual(Object.keys(quoted.behaviors[0].function as object).sort(), ["evidence", "reasoning"]);
  assert.deepEqual(Object.keys(quoted.groups[0]), ["key", "reason"]);
  // The repair gives the three texts shorter, every other value empty.
  const repaired = parsedBehaviors({
    behaviors: [emptyBehavior("new-1", { function: { primary: [], secondary: [], evidence: [{ tool: "interview", respondent: "Mother", result: none(), supports: [] }], reasoning: "The observation and the interview point to escape.", check: "" } })],
    groups: [{ key: "new-3", behaviorKeys: [], nature: "", function: "none", measure: "none", reason: "Same response class, function and measure." }],
    risks: [],
    openItems: [],
  });
  const failed = new Set<unknown>([...checks.failedClaims, ...checks.failedFields.keys()]);
  const merged = mergeRepair("map-behaviors", a, repaired, checks.failing, false, failed) as BehaviorsAnswer;
  const fn = merged.behaviors[0].function;
  assert.equal(fn.reasoning, "The observation and the interview point to escape.");
  assert.deepEqual(fn.primary, ["escape"], "the rest of the function stays");
  assert.equal(fn.evidence.length, 1, "the evidence is merged into its entry, not added");
  assert.equal(fn.evidence[0].respondent, "Mother");
  assert.equal(fn.evidence[0].result?.value, "Spitting stops the homework", "its result, which passed, stays");
  assert.equal(merged.groups[0].reason, "Same response class, function and measure.");
  assert.deepEqual(merged.groups[0].behaviorKeys, ["new-1", "new-2"]);
  assert.deepEqual(checkMapAnswer("map-behaviors", merged, checkContext()).problems, []);
});

/* Review round 1 of case map speed (2026-11-23): the reviewer's probes. */

const parsedFacts = (answer: Answer) => {
  const parsed = parseMapAnswer("map-facts", JSON.stringify(answer));
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.problems.join("; "));
  return parsed.answer as FactsAnswer;
};
/** The first answer's failed values and the objects holding a failed text, as the draft passes them to the merge. */
const failedOf = (checks: CheckResult) => new Set<unknown>([...checks.failedClaims, ...checks.failedFields.keys()]);

test("review B1: a repair that rewrites the value naming an entry (an observation's date, a service's name), or an entry with no name, keeps the entry's passed values", () => {
  const found = { obs: "o", interview: "i" };
  const withObservation = (observation: unknown) => {
    const answer = behaviorsAnswer(found, []);
    (answer.behaviors as Array<{ baseline: { observations: unknown[] } }>)[0].baseline.observations = [observation];
    return answer;
  };
  const passed = { setting: claim("Home", [ref("o", "11/04/2026, home, 2 hours")]), length: claim("2 hours", [ref("o", "11/04/2026, home, 2 hours")]), value: claim("3", [ref("o", "Spitting counts: 3 on 11/04")]) };
  const row = (answer: BehaviorsAnswer) => {
    const entry = answer.behaviors[0].baseline.observations;
    return entry.map((item) => ({ date: item.date?.value ?? null, setting: item.setting?.value ?? null, length: item.length?.value ?? null, value: item.value?.value ?? null }));
  };
  // Probe 1: the date's quote is not found; the repair writes the date another way, with a found quote.
  const a = parsedBehaviors(withObservation({ date: claim("11/04/2026", [ref("o", "on 11/04/2026 at home")]), ...passed }));
  const checks = checkMapAnswer("map-behaviors", a, checkContext());
  assert.ok(checks.problems.length > 0 && checks.problems.every((problem) => /observations\[0\]\.date/.test(problem)), checks.problems.join("\n"));
  const quoted = repairInput("map-behaviors", {}, a, checks).previousAnswer as { behaviors: Array<{ baseline: { observations: Array<Record<string, unknown>> } }> };
  assert.deepEqual(Object.keys(quoted.behaviors[0].baseline.observations[0]), ["date"], "only the failed date is quoted");
  const fix = parsedBehaviors({ behaviors: [emptyBehavior("new-1", { baseline: { observations: [{ date: claim("November 4, 2026", [ref("o", "11/04/2026, home, 2 hours")]), setting: none(), length: none(), value: none() }], other: [] } })], groups: [], risks: [], openItems: [] });
  const merged = mergeRepair("map-behaviors", a, fix, checks.failing, false, failedOf(checks)) as BehaviorsAnswer;
  assert.deepEqual(row(merged), [{ date: "November 4, 2026", setting: "Home", length: "2 hours", value: "3" }], "the count that passed stays");
  assert.deepEqual(checkMapAnswer("map-behaviors", merged, checkContext()).problems, []);
  // Probe 2: an observation with no date, whose value of 9 failed; the repair gives 3.
  const noDate = parsedBehaviors(withObservation({ date: none(), setting: passed.setting, length: passed.length, value: claim("9", [ref("o", "Spitting counts: 3 on 11/04")]) }));
  const noDateChecks = checkMapAnswer("map-behaviors", noDate, checkContext());
  const three = parsedBehaviors({ behaviors: [emptyBehavior("new-1", { baseline: { observations: [{ date: none(), setting: none(), length: none(), value: passed.value }], other: [] } })], groups: [], risks: [], openItems: [] });
  assert.deepEqual(row(mergeRepair("map-behaviors", noDate, three, noDateChecks.failing, false, failedOf(noDateChecks)) as BehaviorsAnswer), [{ date: null, setting: "Home", length: "2 hours", value: "3" }]);
  // Probe 3: a service's name failed; the repair names it another way.
  const services = "Other services, invented: speech-language therapy at school with Ms. Rivera, paid by the family.";
  const context = checkContext({ sources: [...checkContext().sources, { id: "s", title: "Services", text: services }] });
  const withService = (service: Answer) => factsAnswer({ obs: "o", interview: "i", pdf: "p" }, { client: { ...absentClient(), otherServices: [service] }, deficits: [] });
  const first = parsedFacts(withService({ name: claim("Speech therapy", [ref("s", "speech therapy at school")]), provider: claim("Ms. Rivera", [ref("s", "at school with Ms. Rivera")]), paid: claim("not-paid", [ref("s", "paid by the family")]) }));
  const firstChecks = checkMapAnswer("map-facts", first, context);
  assert.equal(firstChecks.problems.length, 1, firstChecks.problems.join("\n"));
  const renamed = parsedFacts(withService({ name: claim("Speech-language therapy", [ref("s", "speech-language therapy at school")]), provider: none(), paid: none() }));
  const service = (mergeRepair("map-facts", first, renamed, firstChecks.failing, false, failedOf(firstChecks)) as FactsAnswer).client!.otherServices;
  assert.deepEqual(service.map((item) => [item.name?.value, item.provider?.value, item.paid?.value]), [["Speech-language therapy", "Ms. Rivera", "not-paid"]], "the provider and 'paid' that passed stay");
});

test("review S1: the report's title vouches for the instrument's number only, never for a wrong percentile", () => {
  const report = "Score report, invented.\nVineland-3 Adaptive Behavior Scales\n| Communication | 68 | 2 | Low |";
  const context = checkContext({ sources: [{ id: "v", title: "Vineland", text: report }] });
  const rows = (percentile: string) =>
    parsedFacts(
      factsAnswer({ obs: "o", interview: "i", pdf: "p" }, {
        caregivers: [],
        settings: [],
        deficits: [{ key: "new-1", area: claim("Communication", [ref("v", "Communication | 68 | 2")]), scores: [{ instrument: "Vineland-3", scale: "Communication", score: "68", percentile, level: "Low", refs: [ref("v", "| Communication | 68 | 2 | Low |"), ref("v", "Vineland-3 Adaptive Behavior Scales")], origin: "extracted", check: "" }], evidence: [], impact: none() }],
      }),
    );
  assert.deepEqual(checkMapAnswer("map-facts", rows("2"), context).problems, [], "the right row passes, the instrument's 3 from the title");
  const wrong = rows("3");
  const checks = checkMapAnswer("map-facts", wrong, context);
  assert.equal(checks.problems.length, 1);
  assert.match(checks.problems[0], /deficits\[0\]\.scores\[0\]: the number 3 in .* is not written in any of its quotes/);
  // Stored, the [CHECK] is on the percentile, not on the instrument whose 3 the title gives.
  const parts = toAnswerParts("map-facts", wrong, checks, { notesSession: null, sectionVersions: new Map(), settingIds: new Set(), behaviorIds: new Set() });
  const row = (parts.deficits!.items[0] as unknown as { scores: Array<Record<string, { check: string | null }>> }).scores[0];
  assert.match(row.percentile.check ?? "", /not written in the quote/);
  assert.equal(row.instrument.check, null);
});

test("review S2: a repaired score row is merged into the failed row field by field, in its place", () => {
  const report = "Score report, invented.\nVineland-3 Adaptive Behavior Scales\n| Communication | 68 | 2 | Low |\n| Socialization | 74 | 4 | Moderately low |";
  const context = checkContext({ sources: [{ id: "v", title: "Vineland", text: report }] });
  const title = ref("v", "Vineland-3 Adaptive Behavior Scales");
  const row = (fields: Answer, line: string) => ({ instrument: "Vineland-3", scale: "Communication", score: "68", percentile: "2", level: "Low", refs: [ref("v", line), title], origin: "extracted", check: "", ...fields });
  const deficit = (scores: unknown[]) => factsAnswer({ obs: "o", interview: "i", pdf: "p" }, { caregivers: [], settings: [], deficits: [{ key: "new-1", area: claim("Communication", [ref("v", "Communication | 68 | 2")]), scores, evidence: [], impact: none() }] });
  // Only the Communication score fails (86 for 68); Socialization passes.
  const first = parsedFacts(deficit([row({ score: "86" }, "| Communication | 68 | 2 | Low |"), row({ scale: "Socialization", score: "74", percentile: "4", level: "Moderately low" }, "| Socialization | 74 | 4 | Moderately low |")]));
  const checks = checkMapAnswer("map-facts", first, context);
  assert.equal(checks.problems.length, 1, checks.problems.join("\n"));
  // The repair writes back only the corrected score.
  const repaired = parsedFacts(deficit([{ instrument: "", scale: "", score: "68", percentile: "", level: "", refs: [ref("v", "| Communication | 68 | 2 | Low |")], origin: "extracted", check: "" }]));
  const merged = mergeRepair("map-facts", first, repaired, checks.failing, false, failedOf(checks)) as FactsAnswer;
  assert.deepEqual(
    merged.deficits[0].scores.map((item) => item.value),
    ["Vineland-3 · Communication · 68 · 2 · Low", "Vineland-3 · Socialization · 74 · 4 · Moderately low"],
    "the repaired row keeps its instrument, scale, percentile and level, in the report's order",
  );
  assert.deepEqual(merged.deficits[0].scores[0].refs.map((item) => item.quote), ["| Communication | 68 | 2 | Low |"]);
  // A repair that names the row is matched by its instrument and scale.
  const named = parsedFacts(deficit([{ instrument: "Vineland-3", scale: "Communication", score: "68", percentile: "", level: "", refs: [ref("v", "| Communication | 68 | 2 | Low |"), title], origin: "extracted", check: "" }]));
  const byName = mergeRepair("map-facts", first, named, checks.failing, false, failedOf(checks)) as FactsAnswer;
  assert.equal(byName.deficits[0].scores[0].value, "Vineland-3 · Communication · 68 · 2 · Low");
  assert.equal(byName.deficits[0].scores.length, 2);
  assert.deepEqual(checkMapAnswer("map-facts", byName, context).problems, []);
});

test("review S3, M1, M2: a cut quote keeps the passage with the value's number, or the value is flagged; cut texts that are not claims are flagged; a cut note joins an earlier check", () => {
  const convert = { notesSession: null, sectionVersions: new Map(), settingIds: new Set<string>(), behaviorIds: new Set<string>() };
  // S3: a found quote of 385 characters whose "30" is near its end.
  const story = `${"The mother said the child talks a lot at home but it is hard to follow, and then: ".repeat(4)}the child goes to Speech therapy 30 minutes twice a week at school.`;
  assert.ok(story.length > 300 && story.indexOf("30") > 300);
  const context = checkContext({ sources: [{ id: "n", title: "Notes", text: story }] });
  const answer = parsedFacts(factsAnswer({ obs: "o", interview: "i", pdf: "p" }, { caregivers: [], settings: [], deficits: [], facts: [{ key: "new-1", text: claim("Speech therapy 30 minutes twice a week", [ref("n", story)]), homeSection: 3 }] }));
  const checks = checkMapAnswer("map-facts", answer, context);
  assert.equal(checks.quotes.get(answer.facts[0].text!.refs[0]), "found");
  const fact = (toAnswerParts("map-facts", answer, checks, convert).facts!.items[0] as unknown as { text: { refs: Array<{ quote: string; checked: string }>; check: string | null } }).text;
  const quote = fact.refs[0].quote;
  assert.ok(quote.length <= 300 && story.includes(quote), "still word for word");
  assert.match(quote, /\b30 minutes/, "the passage that holds the value's number");
  assert.equal(fact.refs[0].checked, "found");
  // A value whose numbers no passage of the limit holds together: flagged.
  const far = `There were 12 sessions. ${"x ".repeat(160)}and 30 minutes each.`;
  const farContext = checkContext({ sources: [{ id: "n", title: "Notes", text: far }] });
  const farAnswer = parsedFacts(factsAnswer({ obs: "o", interview: "i", pdf: "p" }, { caregivers: [], settings: [], deficits: [], facts: [{ key: "new-1", text: claim("12 sessions of 30 minutes", [ref("n", far)]), homeSection: 3 }] }));
  const farFact = (toAnswerParts("map-facts", farAnswer, checkMapAnswer("map-facts", farAnswer, farContext), convert).facts!.items[0] as unknown as { text: { check: string | null } }).text;
  assert.match(farFact.check ?? "", /This quote was cut to fit: check the value against the source\./);
  // M2: a value too long that already has a check is told both.
  const long = parsedFacts(factsAnswer({ obs: "o", interview: "i", pdf: "p" }, { caregivers: [], settings: [], deficits: [], facts: [{ key: "new-1", text: claim(`Spitting at home. ${"y".repeat(1600)}`, [ref("o", "the child spat toward his mother's forearm")], "extracted", "The AI was unsure of this."), homeSection: 3 }] }));
  const longFact = (toAnswerParts("map-facts", long, checkMapAnswer("map-facts", long, checkContext()), convert).facts!.items[0] as unknown as { text: { check: string } }).text;
  assert.match(longFact.check, /^The AI was unsure of this\. This value was longer than the map allows/);
  // M1: a reasoning cut to fit says so in the function's check; a group's reason in an open item; a report item's text too.
  const first = behaviorsAnswer({ obs: "o", interview: "i" }, []);
  const behavior = (first.behaviors as Array<Record<string, unknown>>)[0];
  behavior.function = { ...(behavior.function as Record<string, unknown>), reasoning: "r ".repeat(900) };
  (first.groups as Array<Record<string, unknown>>)[0].reason = "g ".repeat(900);
  const a = parsedBehaviors(first);
  const parts = toAnswerParts("map-behaviors", a, checkMapAnswer("map-behaviors", a, checkContext()), convert);
  const fn = (parts.behaviors!.items[0] as unknown as { function: { reasoning: string; check: string } }).function;
  assert.ok(fn.reasoning.endsWith("…"));
  assert.match(fn.check, /The reasoning was longer than the map allows/);
  assert.ok(parts.openItems!.items.some((item) => /The group "Spitting": its reason was longer than the map allows/.test(String(item.text))));
  const report = parsedFacts(factsAnswer({ obs: "o", interview: "i", pdf: "p" }, { report: [{ kind: "thread-gap", text: `Section 3 lacks dates. ${"z ".repeat(900)}`, sections: [], refs: [] }] }));
  const reportParts = toAnswerParts("map-facts", report, checkMapAnswer("map-facts", report, checkContext()), convert);
  assert.ok(reportParts.openItems!.items.some((item) => /^The report item "Section 3 lacks dates\..*was longer than the map allows/.test(String(item.text))));
});

test("review S4: an update shows nothing of a part she approved or of an item she changed, and marks the AI's new version of a saved item", async () => {
  let caregiverIds: string[] = [];
  const { service, caseId, caseFile, cases } = await setup((found) => {
    const base = factsAnswer(found);
    return {
      facts: [
        { answer: factsAnswer(found) },
        {
          answer: {
            ...base,
            get caregivers() {
              return (factsAnswer(found).caregivers as Array<Record<string, unknown>>).map((item, index) => ({ ...item, key: caregiverIds[index] }));
            },
          },
        },
      ],
      behaviors: [{ answer: behaviorsAnswer(found, []) }, { answer: behaviorsAnswer(found, []) }],
    };
  });
  await draft(service, caseId);
  const first = stored(caseFile);
  caregiverIds = first.parts.caregivers.versions[0].content.items.map((item: { id: string }) => item.id);
  assert.equal(caregiverIds.length, 2);
  // She changes the first caregiver by hand and approves the behaviors.
  await cases.changeCase(caseId, (data, _folder, now) => {
    const typed = saveMapItem(data, "caregivers", "items", caregiverIds[0], { role: { value: "Mother (her words)", check: null } }, null, now);
    assert.ok(typed && typed !== "item-not-found");
    return { save: approveMapPart(typed.data, "behaviors", 1, now), value: null };
  });
  const events = await draft(service, caseId);
  const previews = events.filter((event) => event.type === "map-preview");
  assert.ok(!previews.some((event) => event.part === "behaviors"), "nothing of the approved behaviors");
  const caregivers = previews.filter((event) => event.part === "caregivers");
  assert.deepEqual(
    caregivers.map((event) => event.replaces),
    [caregiverIds[1]],
    "her changed caregiver is not shown; the other is the AI's new version of the saved one",
  );
  assert.ok(previews.filter((event) => event.part === "settings").every((event) => event.replaces === null), "a new key is a new item");
  // The progress counts only what is shown.
  const writing = events.filter((event) => event.type === "map-progress" && event.step === "map-behaviors" && event.phase === "writing").at(-1);
  assert.ok(writing?.type === "map-progress");
  assert.equal(writing.shown, previews.filter((event) => event.step === "map-behaviors").length);
  assert.equal(stored(caseFile).parts.behaviors.versions.length, 1, "the approved part is left as it is");
});

/* The review of the definitions (T3, owner's decisions of 2026-11-28; 1A and 2A) */

test("T3: each draft ends with one review of the definitions, stored as a map-review record that the map's view reads", async () => {
  const { service, caseId, caseFile, model } = await setup((found) => ({
    facts: [{ answer: factsAnswer(found) }],
    behaviors: [{ answer: behaviorsAnswer(found, []) }],
    review: [
      {
        answer: {
          deadMan: [{ behavior: "beh-9", why: "A behavior the review was not sent." }],
          overlaps: [{ first: "beh-1", second: "beh-2", response: "The child spits on the floor next to his mother.", exclusion: "Decide which behavior spitting toward the floor belongs to, and have each definition name the other." }],
        },
      },
    ],
  }));
  const events = await draft(service, caseId);
  assert.equal(model.reviews.length, 1);
  const review = model.reviews[0];
  assert.equal(review.prompt.kind, "definition-review");
  assert.deepEqual(review.prompt.sources, [], "no sources: the definitions alone");
  assert.match(review.prompt.system, /# Reviewing the behaviors' definitions before QA/);
  assert.match(review.prompt.task, /<behaviors>[\s\S]*"id": "beh-1"[\s\S]*"name": "Spitting"/);
  assert.doesNotMatch(review.prompt.task, /refs|quote|origin/, "values only: no refs, quotes or origins");
  assert.equal(review.outputFormat?.name, "definition_review");
  assert.ok(events.some((event) => event.type === "map-review"));
  const saved = events.find((event) => event.type === "map-review-saved");
  assert.ok(saved?.type === "map-review-saved" && saved.status === "done" && saved.findings === 1);
  assert.ok(!events.some((event) => event.type === "error"));

  const map = stored(caseFile);
  const record = map.extractions.at(-1);
  assert.equal(record.kind, "map-review");
  assert.equal(record.run, map.extractions[0].run, "the draft's run");
  assert.equal(record.review.status, "done");
  assert.equal(record.review.behaviorsVersion, 1);
  assert.deepEqual(Object.keys(record.review.fingerprints), ["beh-1", "beh-2"]);
  assert.equal(record.problems.length, 1, "the finding about an unknown behavior was left out and recorded");
  assert.equal(record.generation.costUsd !== undefined && record.generation.usage.outputTokens, 5);
  const view = definitionReviewView({ caseMap: map } as never);
  assert.ok(view);
  assert.deepEqual(view.findings, [{ kind: "overlap", behaviorIds: ["beh-1", "beh-2"], response: "The child spits on the floor next to his mother.", exclusion: "Decide which behavior spitting toward the floor belongs to, and have each definition name the other." }]);
  assert.equal(map.parts.behaviors.versions.length, 1, "the review never touches the map");
});

test("T3: a review that cannot run is recorded as failed; the draft's parts stay saved and the draft does not fail", async () => {
  for (const turn of [{ error: new ProviderError("rate_limited", "Too many requests", 429) }, { answer: "not JSON at all" }, { answer: { deadMan: [{ behavior: "beh-1" }], overlaps: [] } }]) {
    const { service, caseId, caseFile } = await setup((found) => ({ facts: [{ answer: factsAnswer(found) }], behaviors: [{ answer: behaviorsAnswer(found, []) }], review: [turn] }));
    const events = await draft(service, caseId);
    assert.ok(!events.some((event) => event.type === "error"), "no error for the draft");
    assert.equal(events.filter((event) => event.type === "map-saved").length, 2);
    const saved = events.find((event) => event.type === "map-review-saved");
    assert.ok(saved?.type === "map-review-saved" && saved.status === "failed");
    const map = stored(caseFile);
    assert.equal(map.parts.behaviors.versions.length, 1);
    const view = definitionReviewView({ caseMap: map } as never);
    assert.equal(view?.status, "failed");
    assert.equal(view?.failure, "error" in turn ? "rate_limited" : "unreadable_answer");
  }
});

test("T3: a route that refuses the review's schema is asked once more for plain JSON", async () => {
  const { service, caseId, caseFile, model } = await setup((found) => ({
    facts: [{ answer: factsAnswer(found) }],
    behaviors: [{ answer: behaviorsAnswer(found, []) }],
    review: [{ error: new ProviderError("bad_request", "output_config.format: this schema is not supported", 400) }, { answer: { deadMan: [], overlaps: [] } }],
  }));
  await draft(service, caseId);
  assert.equal(model.reviews.length, 2);
  assert.equal(model.reviews[1].outputFormat, null);
  assert.match(model.reviews[1].prompt.task, /following this JSON schema exactly/);
  const record = stored(caseFile).extractions.at(-1);
  assert.equal(record.format, "plain-json");
  assert.equal(record.review.status, "done");
});

test("T3 (2A): Review the definitions again runs the review on its own, one request, on the behaviors as they are now", async () => {
  const { service, caseId, caseFile, model, cases } = await setup((found) => ({
    facts: [{ answer: factsAnswer(found) }],
    behaviors: [{ answer: behaviorsAnswer(found, []) }],
    review: [{ answer: { deadMan: [], overlaps: [] } }, { answer: { deadMan: [{ behavior: "beh-1", why: "Spitting now names only that the child does not stop." }], overlaps: [] } }],
  }));
  await draft(service, caseId);
  // She edits a definition by hand: the review's fingerprint of it no longer matches.
  await cases.changeCase(caseId, (data, _folder, now) => {
    const changed = saveMapItem(data, "behaviors", "items", "beh-1", { definition: { value: "Any instance in which the child does not stop when told.", check: null } }, null, now);
    assert.ok(changed && changed !== "item-not-found");
    return { save: changed.data, value: null };
  });
  const before = definitionReviewView({ caseMap: stored(caseFile) } as never);
  const ready = await service.prepareReview(caseId, "anthropic");
  assert.ok(ready.outcome === "ready");
  const events = [];
  for await (const event of ready.run(new AbortController().signal)) events.push(event);
  assert.equal(model.sent.length, 2, "no map request");
  assert.equal(model.reviews.length, 2);
  assert.match(model.reviews[1].prompt.task, /does not stop when told/);
  const after = definitionReviewView({ caseMap: stored(caseFile) } as never);
  assert.ok(before && after);
  assert.notEqual(after.fingerprints["beh-1"], before.fingerprints["beh-1"]);
  assert.equal(after.fingerprints["beh-2"], before.fingerprints["beh-2"]);
  assert.deepEqual(after.findings, [{ kind: "dead-man", behaviorId: "beh-1", why: "Spitting now names only that the child does not stop." }]);
  assert.equal(stored(caseFile).extractions.filter((record: { kind: string }) => record.kind === "map-review").length, 2);
  assert.equal((await service.prepareReview(caseId, "openai")).outcome, "ready");
});

test("T3: no review runs on a map with no behaviors, and the view leaves out a finding in a shape it does not know", async () => {
  assert.equal(definitionReviewView({} as never), null);
  const view = definitionReviewView({
    caseMap: {
      parts: {},
      extractions: [
        { id: "a", kind: "map-review", at: "2026-11-28T10:00:00.000Z", review: { status: "done", failure: null, behaviorsVersion: 1, fingerprints: { "beh-1": "0000aaaa" }, findings: [{ kind: "dead-man", behaviorId: "beh-1", why: "Only an absence." }, { kind: "newer-kind", text: "?" }] } },
        { id: "b", kind: "map-behaviors" },
      ],
    },
  } as never);
  assert.deepEqual(view?.findings, [{ kind: "dead-man", behaviorId: "beh-1", why: "Only an absence." }]);
});
