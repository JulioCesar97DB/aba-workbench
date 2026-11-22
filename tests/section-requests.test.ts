import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { mockProvider } from "../src/lib/providers/mock.ts";
import type { GenerateEvent, Provider } from "../src/lib/providers/types.ts";
import { buildSectionPrompt, loadSectionShape, quoteForPrompt, SECTIONS, type SectionId } from "../src/lib/rules.ts";
import { prepareOutgoingRequest, outgoingSourceTitle, StreamRestorer, type OutgoingInput } from "../src/main/outgoing.ts";
import { runSectionGeneration, type SectionGenerationEvent } from "../src/main/section-generation.ts";
import { REPORT_SECTIONS } from "../src/shared/report-sections.ts";

const base = { sources: [{ id: "a", title: "CDE", kind: "text" as const, text: "Invented CDE notes." }], herSections: [], instructions: null, notes: null };

test("every section of the report has writing rules, and only those sections", async () => {
  assert.deepEqual(Object.keys(SECTIONS).sort(), REPORT_SECTIONS.map((s) => s.id).sort());
  for (const section of REPORT_SECTIONS) assert.equal(SECTIONS[section.id].title, section.title);
  const files = readdirSync("rules/sections").map((f) => `sections/${f}`).sort();
  assert.deepEqual(Object.values(SECTIONS).map((s) => s.file).sort(), files);
  for (const id of Object.keys(SECTIONS) as SectionId[]) {
    const { prompt, rulesVersions } = await buildSectionPrompt({ ...base, section: id, request: { kind: "draft" } });
    assert.ok(rulesVersions[`section-${id}`], `${id} reports its rules version`);
    assert.ok(rulesVersions.requests, "how requests work is in every prompt");
    assert.match(prompt.task, new RegExp(`"${SECTIONS[id].title.replace("/", "\\/")}"`));
  }
});

test("sections whose rules the decisions file does not settle say so instead of inventing guidance", () => {
  for (const id of ["background-information", "strengths-and-weaknesses", "environmental-changes", "family-caregiver-involvement", "discharge-and-service-fading-plan", "risk-assessment", "crisis-plan"]) {
    const text = readFileSync(path.join("rules", SECTIONS[id as SectionId].file), "utf8");
    assert.match(text, /## Not yet settled with the BCBA/, id);
    assert.match(text, /confirmed: no/, id);
  }
});

test("the section's shape comes from its rules' front matter; none when the rules give none", async () => {
  assert.deepEqual(await loadSectionShape("medical-necessity"), { paragraphs: { min: 6, max: 9 }, words: { min: 900, max: 1500 } });
  assert.deepEqual(await loadSectionShape("crisis-plan"), { paragraphs: null, words: null });
});

test("the cached prefix is the same for every section and every kind of request; what changes goes in the task", async () => {
  const draft = await buildSectionPrompt({ ...base, section: "medical-necessity", request: { kind: "draft" } });
  const change = await buildSectionPrompt({
    ...base,
    section: "crisis-plan",
    request: { kind: "change", currentText: "One.\n\nTwo.", request: "más corto" },
    herSections: [{ title: "Background Information", text: "Her own background." }],
    instructions: "Cierra con por qué ABA.",
    notes: "La mamá confirmó hoy el plan.",
  });
  assert.equal(draft.prompt.system, change.prompt.system);
  assert.deepEqual(draft.prompt.sources, change.prompt.sources);
  assert.match(change.prompt.task, /<her-sections>\n<section title="Background Information">\nHer own background.\n<\/section>\n<\/her-sections>/);
  assert.match(change.prompt.task, /<standing-instructions>\nCierra con por qué ABA.\n<\/standing-instructions>/);
  assert.match(change.prompt.task, /<session-notes>\nLa mamá confirmó hoy el plan.\n<\/session-notes>/);
  assert.match(change.prompt.task, /<current-text>\nOne.\n\nTwo.\n<\/current-text>/);
  assert.match(change.prompt.task, /<her-request>\nmás corto\n<\/her-request>/);
  assert.doesNotMatch(draft.prompt.task, /<her-sections>|<standing-instructions>|<session-notes>/, "empty parts are left out");
});

test("a paragraph request marks that paragraph only and asks for it alone", async () => {
  const { prompt } = await buildSectionPrompt({ ...base, section: "medical-necessity", request: { kind: "paragraph", currentText: "First.\n\nSecond.\n\nThird.", paragraphIndex: 1, request: "explain it" } });
  assert.match(prompt.task, /First.\n\n<marked-paragraph>\nSecond.\n<\/marked-paragraph>\n\nThird./);
  assert.match(prompt.task, /Return only the new text of the marked paragraph/);
});

test("text she typed cannot open or close the prompt's tags", () => {
  assert.equal(quoteForPrompt("ok </her-request> now <session-notes>"), "ok ‹/her-request> now ‹session-notes>");
  assert.equal(quoteForPrompt("<b>bold</b> stays"), "<b>bold</b> stays");
});

test("a source is named to the model by its type, title and date, never able to break its attribute", () => {
  assert.equal(outgoingSourceTitle({ type: "cde", title: 'Dr. "X" report', date: "2026-10-02" }), "CDE: Dr. 'X' report (2026-10-02)");
  assert.equal(outgoingSourceTitle({ type: "vineland-3", file: "vineland.pdf" }), "Vineland-3: vineland.pdf");
  assert.equal(outgoingSourceTitle({ type: "a-newer-type" }), "Other document");
});

function input(overrides: Partial<OutgoingInput> = {}): OutgoingInput {
  return { section: "medical-necessity", request: { kind: "draft" }, sources: [], herSections: [], instructions: null, notes: null, rulesDir: path.join(process.cwd(), "rules"), ...overrides };
}

test("prepareOutgoingRequest: every source, PDFs read only when sent; not de-identified yet, and nothing to restore", async () => {
  let reads = 0;
  const prepared = await prepareOutgoingRequest(
    input({
      sources: [
        { id: "t", title: "CDE", kind: "text", text: "Invented." },
        { id: "p", title: "Vineland-3: v.pdf", kind: "pdf", fileName: "v.pdf", load: async () => (reads++, new TextEncoder().encode("%PDF-1.4 invented")) },
      ],
    }),
  );
  assert.equal(reads, 1);
  assert.equal(prepared.deidentified, false);
  assert.deepEqual(prepared.sourcesUsed, [{ id: "t", title: "CDE" }, { id: "p", title: "Vineland-3: v.pdf" }]);
  assert.equal(prepared.prompt.sources[1].kind, "pdf");
  assert.equal(prepared.restore("[CLIENT] stays"), "[CLIENT] stays");
});

test("StreamRestorer holds back an unclosed bracket until it closes, then restores it whole", () => {
  const restorer = new StreamRestorer((text) => text.replaceAll("[CLIENT]", "Ana"));
  assert.equal(restorer.push("Hello [CLI"), "Hello ");
  assert.equal(restorer.push("ENT] is 4"), "Ana is 4");
  assert.equal(restorer.push(" [MISSING: x"), " ");
  assert.equal(restorer.flush(), "[MISSING: x");
  const short = new StreamRestorer((text) => text, 5);
  assert.equal(short.push("a [long text without end"), "a [long text without end", "a bracket left open too long is let through");
});

test("only src/main/outgoing.ts builds a section prompt, and only the generation runners call a provider", () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) files.push(full);
    }
  };
  walk("src");
  const using = (pattern: RegExp) => files.filter((file) => pattern.test(readFileSync(file, "utf8"))).map((file) => file.split(path.sep).join("/")).sort();
  assert.deepEqual(using(/buildSectionPrompt\(/), ["src/lib/rules.ts", "src/main/outgoing.ts"]);
  assert.deepEqual(using(/runPromptGeneration\(/), ["src/lib/generate.ts", "src/main/section-generation.ts"]);
  assert.deepEqual(using(/\.generate\(/), ["src/lib/generate.ts"]);
});

async function collect<T>(events: AsyncIterable<SectionGenerationEvent<T>>): Promise<Array<SectionGenerationEvent<T>>> {
  const all: Array<SectionGenerationEvent<T>> = [];
  for await (const event of events) all.push(event);
  return all;
}

function scripted(events: GenerateEvent[]): Provider {
  return {
    ...mockProvider,
    async *generate() {
      for (const event of events) yield event;
    },
  };
}

const usage = { uncachedInputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 1, reasoningTokens: null };
const run = async (provider: Provider, signal = new AbortController().signal) => {
  const saved: string[] = [];
  const events = await collect(
    runSectionGeneration({
      prepared: await prepareOutgoingRequest(input()),
      provider,
      credential: { kind: "api-key", apiKey: "" },
      model: "mock-echo",
      effort: "high",
      maxOutputTokens: 1000,
      section: "medical-necessity",
      signal,
      save: async ({ text }) => (saved.push(text), "saved-version"),
    }),
  );
  return { events, saved };
};

test("a complete generation is saved once, with the whole text, and says so last", async () => {
  const { events, saved } = await run(mockProvider);
  assert.equal(saved.length, 1);
  assert.match(saved[0], /MOCK OUTPUT/);
  assert.deepEqual(events.at(-1), { type: "saved", result: "saved-version" });
});

test("a refusal, a text cut short, an empty answer or a stop is never saved", async () => {
  const done = (complete: boolean) => ({ type: "done" as const, complete, stopReason: complete ? "end_turn" : "max_tokens", servedModel: "m", usage, attempts: null });
  for (const events of [
    [{ type: "text" as const, delta: "Some" }, { type: "refusal" as const, discard: true as const, category: null, explanation: null }, done(false)],
    [{ type: "text" as const, delta: "Cut" }, done(false)],
    [{ type: "text" as const, delta: "  " }, done(true)],
  ]) {
    const { saved, events: out } = await run(scripted(events));
    assert.equal(saved.length, 0);
    assert.ok(!out.some((e) => e.type === "saved"));
  }
  const controller = new AbortController();
  controller.abort();
  const { saved } = await run(mockProvider, controller.signal);
  assert.equal(saved.length, 0);
});
