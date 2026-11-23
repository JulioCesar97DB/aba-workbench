import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { checkMapAnswer, mapAnswerSchema, parseMapAnswer, type BehaviorsAnswer } from "../src/lib/case-map-extraction.ts";
import { mockProvider } from "../src/lib/providers/mock.ts";
import { ProviderError, type GenerateEvent, type GenerateOptions, type Provider } from "../src/lib/providers/types.ts";
import { buildSectionPrompt } from "../src/lib/rules.ts";
import { CASE_FILE_NAME } from "../src/main/case-file.ts";
import { approveMapPart, saveMapItem } from "../src/main/case-map.ts";
import { resetMapFormats } from "../src/main/case-map-draft.ts";
import { CaseMapService } from "../src/main/case-map-service.ts";
import { saveOwnText } from "../src/main/case-sections.ts";
import { CaseLibrary } from "../src/main/cases.ts";
import type { GenerationUpdateEvent } from "../src/shared/api.ts";

/*
 * "Draft the map" with a fake provider (step 1, pull request 2): the two requests and
 * their prompts, the JSON schema, the code checks of quotes and numbers, the repair, the
 * plain-JSON resend, an update that keeps her work, and her thresholds. Invented case only.
 */

const folders: string[] = [];
after(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});
beforeEach(() => resetMapFormats());

const OBSERVATIONS = [
  "BCBA direct observation notes, invented case.",
  "11/04/2026, home, 2 hours: the child spat toward his mother's forearm twice when she set the reading worksheet on the table; she stopped the worksheet to clean up. A third spit came at 4:40 when she guided his hand to the page.",
  "11/06/2026, laundromat, 2 hours: he spat once on the floor next to his grandmother when she said it was time to fold.",
  "Spitting counts: 3 on 11/04, 1 on 11/06.",
].join("\n");
const INTERVIEW = "Mother interview, invented: he spits and then I have to stop the homework to clean. Grandmother can attend training on Tuesdays and Thursdays only. The family speaks Spanish at home.";

type Answer = Record<string, unknown>;
const ref = (id: string, quote: string) => ({ kind: "source", id, quote });
const claim = (value: string, refs: unknown[], origin = "extracted", check: string | null = null) => ({ value, refs, origin, check });

function factsAnswer(ids: { obs: string; interview: string; pdf: string }, overrides: Answer = {}): Answer {
  return {
    client: null,
    caregivers: [
      { key: "new-1", role: claim("Mother", [ref(ids.interview, "Mother interview")]), language: claim("Spanish", [ref(ids.interview, "The family speaks Spanish at home")]), availability: null, participation: null, limits: null, mitigation: null },
      { key: "new-2", role: claim("Grandmother", [ref(ids.interview, "Grandmother can attend training")]), language: null, availability: claim("Tuesdays and Thursdays", [ref(ids.interview, "Tuesdays and Thursdays only")]), participation: null, limits: null, mitigation: null },
    ],
    settings: [
      { key: "new-3", name: claim("Home", [ref(ids.obs, "11/04/2026, home, 2 hours")]), kind: claim("home", [ref(ids.obs, "home")]), evidence: claim("observed", [ref(ids.obs, "BCBA direct observation")]), by: null, dates: null },
      { key: "new-4", name: claim("Laundromat", [ref(ids.obs, "laundromat")]), kind: claim("community", [ref(ids.obs, "laundromat")]), evidence: claim("observed", [ref(ids.obs, "BCBA direct observation")]), by: null, dates: null },
    ],
    deficits: [
      {
        key: "new-5",
        area: claim("Communication", [ref(ids.pdf, "Communication")]),
        scores: [{ instrument: claim("Vineland-3", [ref(ids.pdf, "Vineland-3")]), scale: claim("Communication", [ref(ids.pdf, "Communication")]), score: claim("68", [ref(ids.pdf, "Communication 68")]), percentile: null, level: null }],
        evidence: [],
        impact: null,
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
    onset: null,
    offset: null,
    examples: [],
    nonExamples: [],
    baseline: {
      observations: [
        { date: claim("11/04/2026", [ref(ids.obs, "11/04/2026")]), setting: claim("Home", [ref(ids.obs, "home")]), minutes: null, value: claim("3", [ref(ids.obs, "3 on 11/04")]) },
      ],
      other: [],
    },
    settingIds: settingIds.slice(0, 1),
    antecedents: [],
    consequences: [claim("The worksheet stops while she cleans up", [ref(ids.obs, "she stopped the worksheet to clean up")])],
    function: { primary: ["escape"], secondary: [], evidence: [{ tool: "interview", respondent: "Mother", result: claim("Spitting stops the homework", [ref(ids.interview, "he spits and then I have to stop the homework to clean")]), supports: ["escape"] }], reasoning: "The observation and the interview point to escape.", check: null },
    barriers: ["social-interaction"],
    risks: [],
  });
  return {
    behaviors: [behavior("new-1", "Spitting"), behavior("new-2", "Spitting on the floor")],
    groups: [{ key: "new-3", behaviorKeys: ["new-1", "new-2"], nature: "Spitting", function: "escape", measure: "frequency", reason: "Same response class, function and measure." }],
    risks: [{ key: "new-4", behaviorKeys: ["new-1"], what: claim("Spitting at adults during demands", [ref(ids.obs, "spat toward his mother's forearm")]), evidence: [], level: null }],
    openItems: [],
    ...overrides,
  };
}

interface Turn {
  answer?: Answer | string;
  error?: ProviderError;
}

/** A provider that answers each request from a script, by kind, and records what it was sent. */
function scriptedModel(script: { facts: Turn[]; behaviors: Turn[] }) {
  const sent: GenerateOptions[] = [];
  const provider: Provider = {
    ...mockProvider,
    id: "anthropic",
    async *generate(options): AsyncIterable<GenerateEvent> {
      sent.push(options);
      const turn = (options.prompt.task.includes("Map request: case facts") ? script.facts : script.behaviors).shift();
      if (!turn) throw new ProviderError("internal_error", "no scripted turn");
      if (turn.error) throw turn.error;
      const text = typeof turn.answer === "string" ? turn.answer : JSON.stringify(turn.answer);
      yield { type: "status", phase: "writing" };
      for (const piece of text.match(/.{1,400}/gsu) ?? []) yield { type: "text", delta: piece };
      yield { type: "done", complete: true, stopReason: "end_turn", servedModel: options.model, usage: { uncachedInputTokens: 100, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 50, reasoningTokens: null }, attempts: null };
    },
  };
  return { provider, sent };
}

async function setup(script: { facts: Turn[]; behaviors: Turn[] } | ((ids: { obs: string; interview: string; pdf: string }) => { facts: Turn[]; behaviors: Turn[] }), options: { instructions?: string; herSection?: string } = {}) {
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
  const model = scriptedModel(typeof script === "function" ? script(ids) : script);
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
  assert.match(facts.prompt.task, /# Drafting the case map/);
  assert.doesNotMatch(facts.prompt.task, /# Target behaviors/, "the behaviors rules go with the behaviors request only");
  assert.match(behaviors.prompt.task, /# Target behaviors/);
  assert.ok(facts.prompt.task.indexOf("<her-sections>") < facts.prompt.task.indexOf("Map request"), "her sections come before the request");
  assert.match(facts.prompt.task, /<section id="medical-necessity"/);
  assert.match(behaviors.prompt.task, /<map-facts>[\s\S]*"id":"set-1"/);
  assert.equal(facts.outputFormat?.name, "case_map_facts");
  assert.equal(behaviors.outputFormat?.name, "case_map_behaviors");
  assert.doesNotMatch(behaviors.prompt.task, /\n<standing-instructions>\n/, "no thresholds until she confirms them");

  const map = stored(caseFile);
  const behaviorsPart = map.parts.behaviors;
  assert.equal(behaviorsPart.versions.length, 1);
  assert.equal(behaviorsPart.versions[0].kind, "ai");
  const [spitting, floor] = behaviorsPart.versions[0].content.items;
  assert.deepEqual([spitting.id, floor.id], ["beh-1", "beh-2"], "ids made by code");
  assert.equal("key" in spitting, false);
  assert.equal(spitting.intensity, null, "intensity is hers only");
  assert.deepEqual(spitting.barriers, { value: ["social-interaction"], refs: [], origin: "proposed", check: null });
  assert.equal(spitting.function.origin, "hypothesis");
  assert.deepEqual(spitting.settingIds, ["set-1"]);
  assert.equal(spitting.name.refs[0].checked, "found");
  assert.equal(spitting.name.refs[0].sourceId, ids.obs);
  assert.deepEqual(behaviorsPart.versions[0].content.groups[0].behaviorIds, ["beh-1", "beh-2"]);
  assert.deepEqual(map.parts.risks.versions[0].content.items[0].behaviorIds, ["beh-1"]);
  // The facts: caregivers and settings, a PDF quote not checked, open items from both requests.
  assert.deepEqual(map.parts.caregivers.versions[0].content.items.map((item: { id: string }) => item.id), ["cg-1", "cg-2"]);
  const score = map.parts.deficits.versions[0].content.items[0].scores[0].score;
  assert.equal(score.refs[0].checked, "not-checked", "a PDF's quote is not checked yet");
  assert.equal(score.check, null);
  assert.equal(map.parts.openItems.versions.at(-1).content.items.length, 1);
  assert.equal(map.extractions.length, 2);
  assert.deepEqual(
    map.extractions.map((record: { kind: string; format: string; repaired: boolean }) => [record.kind, record.format, record.repaired]),
    [
      ["map-facts", "json-schema", false],
      ["map-behaviors", "json-schema", false],
    ],
  );
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

test("a quote not found word for word gets one repair request that names it; the fixed answer is saved", async () => {
  const { service, caseId, caseFile, model } = await setup((found) => {
    const bad = factsAnswer(found);
    (bad.caregivers as Array<Record<string, unknown>>)[0].role = claim("Mother", [ref(found.interview, "the mother said she works nights")]);
    return { facts: [{ answer: bad }, { answer: factsAnswer(found) }], behaviors: [{ answer: behaviorsAnswer(found, []) }] };
  });
  await draft(service, caseId);
  assert.equal(model.sent.length, 3);
  assert.match(model.sent[1].prompt.task, /<previous-answer>/);
  assert.match(model.sent[1].prompt.task, /caregivers\[0\]\.role\.refs\[0\]: the quote "the mother said she works nights" is not found word for word/);
  const map = stored(caseFile);
  assert.equal(map.extractions[0].repaired, true);
  assert.deepEqual(map.extractions[0].problems, []);
  assert.equal(map.parts.caregivers.versions[0].content.items[0].role.refs[0].checked, "found");
});

test("what still fails after the repair is saved and flagged, never dropped", async () => {
  const { service, caseId, caseFile } = await setup((found) => {
    const bad = factsAnswer(found);
    (bad.caregivers as Array<Record<string, unknown>>)[0].role = claim("Mother", [ref(found.interview, "words nobody wrote")]);
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

test("a count that is in none of its quotes is a problem for the repair", async () => {
  const found = { obs: "o", interview: "i", pdf: "p" };
  const answer = behaviorsAnswer(found, []) as unknown as BehaviorsAnswer;
  answer.behaviors[0].baseline.observations[0].value = claim("4", [ref("o", "3 on 11/04")]) as never;
  const parsed = parseMapAnswer("map-behaviors", JSON.stringify(answer));
  assert.ok(parsed.ok);
  const result = checkMapAnswer("map-behaviors", parsed.answer, { sources: [{ id: "o", title: "Observations", text: OBSERVATIONS }, { id: "i", title: "Interview", text: INTERVIEW }], sections: [], notes: "", settingIds: new Set() });
  assert.ok(result.problems.some((problem) => /the number "4" is not written in any of its quotes/.test(problem)));
  // A behavior in two groups, and a setting the map does not have.
  answer.groups.push({ key: "new-9", behaviorKeys: ["new-1"], nature: "Again", function: "escape", measure: "frequency", reason: "" });
  answer.behaviors[0].settingIds = ["set-9"];
  const again = checkMapAnswer("map-behaviors", answer, { sources: [{ id: "o", title: "Observations", text: OBSERVATIONS }, { id: "i", title: "Interview", text: INTERVIEW }], sections: [], notes: "", settingIds: new Set() });
  assert.ok(again.problems.some((problem) => /is in two groups/.test(problem)));
  assert.ok(again.problems.some((problem) => /"set-9" is not a setting of the map/.test(problem)));
  // Quotes compare across quote marks, dashes, spaces and case.
  const loose = behaviorsAnswer(found, []) as unknown as BehaviorsAnswer;
  loose.behaviors[0].consequences = [claim("x", [ref("i", "HE SPITS   and then I have to stop the homework")]) as never];
  const looseResult = checkMapAnswer("map-behaviors", loose, { sources: [{ id: "o", title: "Observations", text: OBSERVATIONS }, { id: "i", title: "Interview", text: INTERVIEW }], sections: [], notes: "", settingIds: new Set() });
  assert.equal(looseResult.quotes.get(loose.behaviors[0].consequences[0].refs[0]), "found");
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
  const { service, caseId, caseFile, cases, model, ids } = await setup((found) => ({
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
  void ids;
});

test("her confirmed thresholds go with the behaviors request as her standing instructions (D16)", async () => {
  const { service, caseId, model } = await setup((found) => ({ facts: [{ answer: factsAnswer(found) }], behaviors: [{ answer: behaviorsAnswer(found, []) }] }), {
    instructions: "End of an episode: 10 consecutive seconds without the behavior.",
  });
  await draft(service, caseId);
  assert.doesNotMatch(model.sent[0].prompt.task, /\n<standing-instructions>\n/);
  assert.match(model.sent[1].prompt.task, /\n<standing-instructions>\nEnd of an episode: 10 consecutive seconds/);
});

test("an answer that is not JSON, even after the repair, saves nothing and says so", async () => {
  const { service, caseId, caseFile } = await setup(() => ({ facts: [{ answer: "not json" }, { answer: "still not json" }], behaviors: [] }));
  const events = await draft(service, caseId);
  const error = events.find((event) => event.type === "error");
  assert.ok(error?.type === "error" && error.code === "unreadable_answer");
  assert.equal(stored(caseFile), undefined, "no map written");
});

test("the answer schemas follow strict structured outputs: every object closed and fully required, no limits, no recursion", () => {
  const walk = (schema: unknown, where: string) => {
    if (Array.isArray(schema)) return schema.forEach((entry, index) => walk(entry, `${where}[${index}]`));
    if (typeof schema !== "object" || schema === null) return;
    const node = schema as Record<string, unknown>;
    for (const banned of ["minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems", "pattern", "$ref", "format"]) assert.equal(banned in node, false, `${where} has ${banned}`);
    if (node.type === "object") {
      assert.equal(node.additionalProperties, false, `${where} is not closed`);
      assert.deepEqual([...(node.required as string[])].sort(), Object.keys(node.properties as object).sort(), `${where} does not require every property`);
    }
    for (const [key, value] of Object.entries(node)) walk(value, `${where}.${key}`);
  };
  walk(mapAnswerSchema("map-facts"), "facts");
  walk(mapAnswerSchema("map-behaviors"), "behaviors");
});
