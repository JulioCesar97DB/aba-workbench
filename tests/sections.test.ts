import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { mockProvider } from "../src/lib/providers/mock.ts";
import type { GenerateEvent, GenerateOptions, Provider, ProviderCredential } from "../src/lib/providers/types.ts";
import { CASE_FILE_NAME, readCaseFile, serializeCaseFile } from "../src/main/case-file.ts";
import { contextSections, saveOwnText, startNewSession, setNotes } from "../src/main/case-sections.ts";
import { FailedSaves, runSaves } from "../src/main/failed-saves.ts";
import { hasLinesInParagraphs, isParagraphAnswer, linesAsParagraphs, paragraphSpans, replaceParagraph, splitParagraphs } from "../src/shared/section-text.ts";
import { CaseLibrary } from "../src/main/cases.ts";
import { changeInstructions, EDITING_PASS_MS, INSTRUCTIONS_FILE_NAME, InstructionsStore, readInstructionsFile } from "../src/main/instructions.ts";
import { SectionService } from "../src/main/sections.ts";
import type { GenerationUpdateEvent, SectionSaveResult } from "../src/shared/api.ts";
import { abaMatrixClipboard } from "../src/shared/section-text.ts";
import { isOlderRevision } from "../src/shared/sections.ts";
import { createAnthropicProvider } from "../src/lib/providers/anthropic.ts";
import { CHATGPT_TASK_PREAMBLE, createOpenAIProvider } from "../src/lib/providers/openai.ts";
import { caseCacheKey } from "../src/main/cache-key.ts";
import { sseResponse, stubFetch } from "./helpers.ts";

const folders: string[] = [];
after(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});
function tempFolder(): string {
  const folder = mkdtempSync(path.join(tmpdir(), "aba-sections-test-"));
  folders.push(folder);
  return folder;
}

const usage = { uncachedInputTokens: 1000, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 500, reasoningTokens: null };

/** A provider that answers each kind of request the way a model would, with invented text, and records what it was sent. */
function fakeModel(answers: { consistency?: string; paragraph?: string } = {}) {
  const prompts: GenerateOptions["prompt"][] = [];
  const provider: Provider = {
    ...mockProvider,
    id: "anthropic",
    async *generate(options): AsyncIterable<GenerateEvent> {
      prompts.push(options.prompt);
      const task = options.prompt.task;
      const text = task.includes("Consistency check")
        ? (answers.consistency ?? "NO CONTRADICTIONS")
        : task.includes("Paragraph change request")
          ? (answers.paragraph ?? "A new second paragraph, with a [MISSING: date of the IEP].")
          : "First paragraph of an invented draft.\n\nSecond paragraph.\n\nThird paragraph.";
      yield { type: "status", phase: "writing" };
      for (const piece of text.match(/.{1,7}/gsu) ?? []) yield { type: "text", delta: piece };
      yield { type: "done", complete: true, stopReason: "end_turn", servedModel: options.model, usage, attempts: null };
    },
  };
  return { provider, prompts };
}

async function setup(answers: { consistency?: string; paragraph?: string } = {}, options: { failWrites?: () => boolean; provider?: Provider; credential?: ProviderCredential } = {}) {
  const folder = tempFolder();
  let ids = 0;
  const cases = new CaseLibrary({
    location: async () => ({ folder, isDefault: false }),
    newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
    log: () => undefined,
    ...(options.failWrites
      ? {
          writeFile: async (file: string, text: string) => {
            if (options.failWrites!()) throw new Error("EACCES: the disk refused (test)");
            const { writeFileDurably } = await import("../src/main/durable-write.ts");
            await writeFileDurably(file, text);
          },
        }
      : {}),
  });
  const created = await cases.create({ label: "Invented case" });
  assert.ok(created.outcome === "created");
  const caseId = created.case.id;
  await cases.addTextSource(caseId, { type: "cde", text: "Invented CDE notes for a child who does not exist." });
  const model = fakeModel(answers);
  const clipboard: Array<{ text: string; html: string }> = [];
  const userData = tempFolder();
  const service = new SectionService({
    cases,
    instructions: new InstructionsStore(path.join(userData, INSTRUCTIONS_FILE_NAME), { log: () => undefined }),
    rulesDir: path.join(process.cwd(), "rules"),
    provider: () => options.provider ?? model.provider,
    credential: async () => options.credential ?? { kind: "api-key", apiKey: "test-key-not-real" },
    chosenModel: async () => null,
    rememberProvider: async () => undefined,
    writeClipboard: async (content) => void clipboard.push(content),
    log: () => undefined,
  });
  const caseFile = path.join(folder, "Invented case", CASE_FILE_NAME);
  return { service, caseId, model, clipboard, caseFile, userData, cases };
}

async function generate(service: SectionService, caseId: string, sectionId: string, request: unknown, signal = new AbortController().signal) {
  const ready = await service.prepareGeneration(caseId, sectionId, "anthropic", request);
  assert.equal(ready.outcome, "ready");
  assert.ok(ready.outcome === "ready");
  const events: Array<Exclude<GenerationUpdateEvent, { type: "finished" }>> = [];
  for await (const event of ready.run(signal)) events.push(event);
  return events;
}

function saved(result: SectionSaveResult) {
  assert.equal(result.outcome, "saved");
  assert.ok(result.outcome === "saved");
  return result;
}

test("her pasted text is version 1, kept exactly as written; typing updates it, a new pass makes a new version", async () => {
  const { service, caseId } = await setup();
  const pasted = "Sofía is 4.\r\n\r\n  She lives with   her parents. ";
  const first = saved(await service.saveText(caseId, "background-information", pasted, null));
  assert.equal(first.section.state, "hers");
  assert.equal(first.section.versions[0].text, "Sofía is 4.\n\n  She lives with   her parents. ", "only line endings change");
  assert.equal(first.sections.find((s) => s.id === "background-information")?.state, "hers");
  const typed = saved(await service.saveText(caseId, "background-information", "Sofía is 4 years old.", 1));
  assert.equal(typed.section.versions.length, 1);
  assert.equal(typed.section.versions[0].text, "Sofía is 4 years old.");
  const edit = saved(await service.saveText(caseId, "background-information", "Sofía is 4 years old. Edited later.", null));
  assert.deepEqual(edit.section.versions.map((v) => [v.number, v.kind]), [[1, "hers"], [2, "edited"]]);
  assert.equal(edit.section.state, "hers");
});

test("a draft streams in and becomes a version with what made it; nothing to compare yet", async () => {
  const { service, caseId, caseFile } = await setup();
  const events = await generate(service, caseId, "medical-necessity", { kind: "draft" });
  const text = events.flatMap((e) => (e.type === "text" ? [e.delta] : [])).join("");
  assert.match(text, /First paragraph of an invented draft/);
  const savedEvent = events.find((e) => e.type === "saved");
  assert.ok(savedEvent?.type === "saved" && savedEvent.result.outcome === "saved");
  const version = savedEvent.result.section.versions[0];
  assert.equal(version.kind, "draft");
  assert.equal(version.model, "claude-fable-5-2", "the most capable model by default");
  assert.ok(version.costUsd !== null && version.costUsd > 0, "the real cost is recorded");
  assert.deepEqual(version.sourcesUsed.map((source) => source.title), ["CDE"]);
  const checked = events.at(-1);
  assert.ok(checked?.type === "checked" && checked.result.outcome === "saved");
  assert.deepEqual(checked.result.section.versions[0].consistency, { status: "nothing-to-compare", items: [], stale: false });
  const stored = JSON.parse(readFileSync(caseFile, "utf8"));
  assert.equal(stored.schemaVersion, 3);
  const record = stored.sections["medical-necessity"].versions[0].generation;
  assert.equal(record.deidentified, false);
  assert.equal(record.effort, "high");
  assert.ok(record.rulesVersions["section-medical-necessity"]);
});

test("her sections and approved ones are context, labeled final; unapproved drafts are not", async () => {
  const { service, caseId, model } = await setup();
  saved(await service.saveText(caseId, "background-information", "Her own background text.", null));
  await generate(service, caseId, "strengths-and-weaknesses", { kind: "draft" });
  assert.deepEqual(await service.saveInstructions("medical-necessity", "Each area with its score."), { outcome: "saved" });
  assert.equal((await service.saveNotes(caseId, "The mother confirmed today the school plan.")).outcome, "saved");
  const events = await generate(service, caseId, "medical-necessity", { kind: "draft" });
  const draftPrompt = model.prompts.at(-2)!;
  assert.match(draftPrompt.task, /<her-sections>\n<section title="Background Information">\nHer own background text./);
  assert.doesNotMatch(draftPrompt.task, /Strengths and Weaknesses"/, "an unapproved AI draft is not context");
  assert.match(draftPrompt.task, /<standing-instructions>\nEach area with its score.\n/);
  assert.match(draftPrompt.task, /<session-notes>\nThe mother confirmed today the school plan.\n/);
  // The consistency check ran on the new version, against her section, and found nothing.
  assert.match(model.prompts.at(-1)!.task, /Consistency check/);
  const checked = events.at(-1);
  assert.ok(checked?.type === "checked" && checked.result.outcome === "saved");
  assert.deepEqual(checked.result.section.versions.at(-1)!.consistency, { status: "none", items: [], stale: false });
  // Once approved, the Strengths draft is context too.
  saved(await service.approve(caseId, "strengths-and-weaknesses", 1));
  await generate(service, caseId, "crisis-plan", { kind: "draft" });
  assert.match(model.prompts.at(-2)!.task, /<section title="Strengths and Weaknesses">/);
});

test("contradictions the check finds are kept with the version", async () => {
  const { service, caseId } = await setup({ consistency: "- Background Information says 4 years old; this says 5.\n- Another one." });
  saved(await service.saveText(caseId, "background-information", "Her own background text.", null));
  const events = await generate(service, caseId, "medical-necessity", { kind: "draft" });
  const checked = events.at(-1);
  assert.ok(checked?.type === "checked" && checked.result.outcome === "saved");
  assert.deepEqual(checked.result.section.versions.at(-1)!.consistency, { status: "found", items: ["Background Information says 4 years old; this says 5.", "Another one."], stale: false });
});

test("a paragraph change keeps every other paragraph byte for byte, and takes the approval away", async () => {
  const { service, caseId, model } = await setup();
  await generate(service, caseId, "medical-necessity", { kind: "draft" });
  saved(await service.approve(caseId, "medical-necessity", 1));
  const events = await generate(service, caseId, "medical-necessity", { kind: "paragraph", fromVersion: 1, paragraphIndex: 1, request: "explica los percentiles" });
  // No other section of hers yet: no consistency check was sent, so the paragraph request is the last one.
  assert.match(model.prompts.at(-1)!.task, /<marked-paragraph>\nSecond paragraph.\n<\/marked-paragraph>/);
  assert.match(model.prompts.at(-1)!.task, /<her-request>\nexplica los percentiles\n<\/her-request>/);
  const savedEvent = events.find((e) => e.type === "saved");
  assert.ok(savedEvent?.type === "saved" && savedEvent.result.outcome === "saved");
  const section = savedEvent.result.section;
  const [v1, v2] = section.versions;
  assert.equal(v2.text, "First paragraph of an invented draft.\n\nA new second paragraph, with a [MISSING: date of the IEP].\n\nThird paragraph.");
  assert.equal(v2.kind, "paragraph");
  assert.equal(v2.paragraphIndex, 1);
  assert.equal(v2.basedOn, 1);
  assert.equal(v1.text, "First paragraph of an invented draft.\n\nSecond paragraph.\n\nThird paragraph.", "the earlier version is kept as it was");
  assert.equal(section.approvedVersion, null);
  assert.equal(section.state, "drafted");
  // Going back moves only the pointer.
  const back = saved(await service.setCurrent(caseId, "medical-necessity", 1));
  assert.equal(back.section.currentVersion, 1);
  assert.equal(back.section.versions.length, 2);
});

test("improving her text adds a version beside hers; hers stays the context until she approves the new one", async () => {
  const { service, caseId } = await setup();
  saved(await service.saveText(caseId, "background-information", "Her own background text.", null));
  const events = await generate(service, caseId, "background-information", { kind: "improve", fromVersion: 1 });
  const savedEvent = events.find((e) => e.type === "saved");
  assert.ok(savedEvent?.type === "saved" && savedEvent.result.outcome === "saved");
  assert.deepEqual(savedEvent.result.section.versions.map((v) => v.kind), ["hers", "improve"]);
  assert.equal(savedEvent.result.section.versions[0].text, "Her own background text.");
});

/* Real runs, 2026-11-23: "Improve with AI" changed her 3:00-6:00 p.m. to 5:30, unflagged */

test("Improve keeps her facts exactly, and its check compares the new version with her own text", async () => {
  const { service, caseId, model, caseFile } = await setup({ consistency: "- Her own text: ABA from 3:00-6:00 p.m.; this version says 5:30." });
  saved(await service.saveText(caseId, "background-information", "She receives ABA at home from 3:00-6:00 p.m. on weekdays.", null));
  const events = await generate(service, caseId, "background-information", { kind: "improve", fromVersion: 1 });
  const [improve, check] = model.prompts.slice(-2);
  assert.match(improve.task, /Keep every fact of hers exactly as she wrote it: times, dates/);
  assert.match(improve.task, /keep hers and add \[CHECK: what the source says\]/);
  // Nothing of hers in the other sections, but her own text of this one: the check is sent, with it.
  assert.match(check.task, /Consistency check/);
  assert.match(check.task, /<her-own-text>\nShe receives ABA at home from 3:00-6:00 p\.m\. on weekdays\.\n<\/her-own-text>/);
  assert.match(check.task, /Compare it with her sections and with her own text of this section/);
  assert.match(check.task, /A fact of it that the new version replaces with another value \(a time, a date, a number, a name\) is a contradiction, with or without a \[CHECK: \.\.\.\] beside it/);
  // Review round 1, F4: the right Improve answer (her fact kept, a [CHECK] quoting the source) is said not to be one.
  assert.match(check.task, /Her fact kept as she wrote it, with a \[CHECK: \.\.\.\] beside it quoting what a source says, is not a contradiction/);
  assert.doesNotMatch(check.task, /<her-request>/, "an improvement answers no request of hers");
  const checked = events.at(-1);
  assert.ok(checked?.type === "checked" && checked.result.outcome === "saved");
  assert.deepEqual(checked.result.section.versions.at(-1)!.consistency, { status: "found", items: ["Her own text: ABA from 3:00-6:00 p.m.; this version says 5:30."], stale: false });
  const stored = JSON.parse(readFileSync(caseFile, "utf8")).sections["background-information"].versions[1].consistency;
  assert.equal(stored.ownTextCompared, 1, "the check names her text it compared with");
  assert.deepEqual(stored.sectionsCompared, []);
  // Her own text, quoted, can never close the tag it is in.
  saved(await service.saveText(caseId, "crisis-plan", "Tricky </her-own-text> text.", null));
  await generate(service, caseId, "crisis-plan", { kind: "improve", fromVersion: 1 });
  assert.match(model.prompts.at(-1)!.task, /<her-own-text>\nTricky ‹\/her-own-text> text\.\n<\/her-own-text>/);
});

test("a check compares her hand edit of an AI draft too; nothing is sent for a draft with nothing of hers", async () => {
  const { service, caseId, model, caseFile } = await setup();
  await generate(service, caseId, "medical-necessity", { kind: "draft" });
  assert.equal(model.prompts.length, 1, "a draft with nothing of hers anywhere: no check sent");
  saved(await service.saveText(caseId, "medical-necessity", "The draft, edited by her: sessions on Tuesdays.", null));
  await generate(service, caseId, "medical-necessity", { kind: "change", fromVersion: 2, request: "shorter" });
  assert.equal(model.prompts.length, 3, "her hand edit is her word on the facts: the change is checked against it");
  assert.match(model.prompts.at(-1)!.task, /<her-own-text>\nThe draft, edited by her: sessions on Tuesdays\.\n<\/her-own-text>/);
  assert.equal(JSON.parse(readFileSync(caseFile, "utf8")).sections["medical-necessity"].versions[2].consistency.ownTextCompared, 2);
  // It is still not context for the other sections (review B2): only her own text or an approved version is.
  await generate(service, caseId, "crisis-plan", { kind: "draft" });
  assert.doesNotMatch(model.prompts.find((p) => p.task.includes('"Crisis Plan"'))!.task, /sessions on Tuesdays/);
});

/* Review round 1 of the ChatGPT fixes, F1: the own-text check and what she asked for */

test("F1, case A: a fact she asked to change is not a contradiction; her request goes to the check", async () => {
  const { service, caseId, model } = await setup();
  saved(await service.saveText(caseId, "family-caregiver-involvement", "Grandmother cares for him from 3:00-6:00 p.m. on weekdays.", null));
  await generate(service, caseId, "family-caregiver-involvement", { kind: "change", fromVersion: 1, request: "The hours changed: it is now 4:00-7:00 p.m." });
  const check = model.prompts.at(-1)!.task;
  assert.match(check, /<her-own-text>\nGrandmother cares for him from 3:00-6:00 p\.m\. on weekdays\.\n<\/her-own-text>/);
  assert.match(check, /<her-request>\nThe hours changed: it is now 4:00-7:00 p\.m\.\n<\/her-request>/);
  assert.match(check, /a difference from her own text that she asked for there is not a contradiction/);
  // A paragraph change after it: both of her requests since her text reach the check, oldest first.
  await generate(service, caseId, "family-caregiver-involvement", { kind: "paragraph", fromVersion: 2, paragraphIndex: 0, request: "shorter" });
  assert.match(model.prompts.at(-1)!.task, /<her-request>\nThe hours changed: it is now 4:00-7:00 p\.m\.\n\nshorter\n<\/her-request>/);
});

test("F1, case B: after she fixes a fact by hand in an AI version, later versions are checked against her fix", async () => {
  const { service, caseId, model, caseFile } = await setup();
  saved(await service.saveText(caseId, "background-information", "ABA at home from 3:00-6:00 p.m.", null));
  await generate(service, caseId, "background-information", { kind: "improve", fromVersion: 1 });
  // She resolves the [CHECK] by hand in the AI's version: an edit of version 2.
  saved(await service.setCurrent(caseId, "background-information", 2));
  saved(await service.saveText(caseId, "background-information", "ABA at home from 3:00-5:30 p.m. (confirmed).", null));
  await generate(service, caseId, "background-information", { kind: "change", fromVersion: 3, request: "shorter" });
  const check = model.prompts.at(-1)!.task;
  assert.match(check, /<her-own-text>\nABA at home from 3:00-5:30 p\.m\. \(confirmed\)\.\n<\/her-own-text>/);
  assert.doesNotMatch(check, /3:00-6:00/, "never the older text she corrected");
  assert.match(check, /<her-request>\nshorter\n<\/her-request>/, "only what she asked after her fix");
  const versions = JSON.parse(readFileSync(caseFile, "utf8")).sections["background-information"].versions;
  assert.deepEqual(versions.map((v: { kind: string }) => v.kind), ["hers", "improve", "edited", "change"]);
  assert.equal(versions[3].consistency.ownTextCompared, 3);
});

test("the case's cache key is opaque: a fixed shape, the same for one case, different for each, and never the id itself", () => {
  const a = "3f0c1a2b-4c5d-4e6f-8a9b-0c1d2e3f4a5b";
  const b = "3f0c1a2b-4c5d-4e6f-8a9b-0c1d2e3f4a5c";
  assert.match(caseCacheKey(a), /^aba-[A-Za-z0-9_-]{32}$/);
  assert.equal(caseCacheKey(a), caseCacheKey(a));
  assert.notEqual(caseCacheKey(a), caseCacheKey(b));
  for (const part of a.split("-")) assert.ok(!caseCacheKey(a).includes(part), part);
});

/* Review round 2 of the ChatGPT fixes */

test("R1: a fact she set by a request is her fact; the check is told a later version that puts the old value back contradicts it", async () => {
  const { service, caseId, model } = await setup();
  saved(await service.saveText(caseId, "family-caregiver-involvement", "Grandmother cares for him from 3:00-6:00 p.m.", null));
  await generate(service, caseId, "family-caregiver-involvement", { kind: "change", fromVersion: 1, request: "The hours changed: it is now 4:00-7:00 p.m." });
  await generate(service, caseId, "family-caregiver-involvement", { kind: "change", fromVersion: 2, request: "shorter" });
  const check = model.prompts.at(-1)!.task;
  assert.match(check, /<her-own-text>\nGrandmother cares for him from 3:00-6:00 p\.m\.\n<\/her-own-text>/);
  assert.match(check, /<her-request>\nThe hours changed: it is now 4:00-7:00 p\.m\.\n\nshorter\n<\/her-request>/);
  assert.match(
    check,
    /Where she asked in <her-request> for a fact to change, the value she asked for is now her fact: a new version that keeps her old value or gives a third one is a contradiction \(unless a later request of hers changed it again\)\./,
  );
  // Without a request of hers (an improvement of her text) the line is not there.
  saved(await service.saveText(caseId, "crisis-plan", "Her crisis plan.", null));
  await generate(service, caseId, "crisis-plan", { kind: "improve", fromVersion: 1 });
  assert.doesNotMatch(model.prompts.at(-1)!.task, /the value she asked for is now her fact/);
});

test("R2: her own text and her requests come from the version's own lineage, not from a hand edit on another branch", async () => {
  const { service, caseId, model, caseFile } = await setup();
  saved(await service.saveText(caseId, "family-caregiver-involvement", "Grandmother cares for him from 3:00-6:00 p.m.", null));
  await generate(service, caseId, "family-caregiver-involvement", { kind: "change", fromVersion: 1, request: "The hours changed: it is now 4:00-7:00 p.m." });
  // She goes back to her text and edits it by hand (a branch from version 1), then asks for a change of version 2.
  saved(await service.setCurrent(caseId, "family-caregiver-involvement", 1));
  saved(await service.saveText(caseId, "family-caregiver-involvement", "Grandmother cares for him from 3:00-6:00 p.m. on weekdays.", null));
  await generate(service, caseId, "family-caregiver-involvement", { kind: "change", fromVersion: 2, request: "shorter" });
  const versions = JSON.parse(readFileSync(caseFile, "utf8")).sections["family-caregiver-involvement"].versions;
  assert.deepEqual(versions.map((v: { kind: string; basedOn?: number }) => [v.kind, v.basedOn ?? null]), [["hers", null], ["change", 1], ["edited", 1], ["change", 2]]);
  const check = model.prompts.at(-1)!.task;
  assert.match(check, /<her-own-text>\nGrandmother cares for him from 3:00-6:00 p\.m\.\n<\/her-own-text>/, "version 1, which version 4 came from");
  assert.match(check, /<her-request>\nThe hours changed: it is now 4:00-7:00 p\.m\.\n\nshorter\n<\/her-request>/, "every request on the way, so 4:00-7:00 is not a false alarm");
  assert.equal(versions[3].consistency.ownTextCompared, 1);
  // A draft, which comes from no text of hers, is still compared with her latest hand-written version before it.
  await generate(service, caseId, "family-caregiver-involvement", { kind: "draft" });
  assert.match(model.prompts.at(-1)!.task, /<her-own-text>\nGrandmother cares for him from 3:00-6:00 p\.m\. on weekdays\.\n<\/her-own-text>/);
  assert.doesNotMatch(model.prompts.at(-1)!.task, /<her-request>/);
});

test("P1: a failed or stopped Check again never takes the earlier check's cost out of the totals", async () => {
  const model = fakeModel();
  let failChecks = false;
  const provider: Provider = {
    ...model.provider,
    async *generate(options) {
      if (failChecks && options.prompt.task.includes("Consistency check")) throw new Error("fetch failed (test)");
      yield* model.provider.generate(options);
    },
  };
  const { service, caseId, caseFile } = await setup({}, { provider });
  saved(await service.saveText(caseId, "background-information", "Her own background text.", null));
  await generate(service, caseId, "medical-necessity", { kind: "draft" });
  const before = await service.get(caseId, "medical-necessity");
  assert.ok(before.outcome === "read");
  const firstCheck = before.section.versions[0].checkCostUsd!;
  assert.ok(firstCheck > 0);
  const total = before.section.costUsd;

  failChecks = true;
  const again = await service.prepareCheck(caseId, "medical-necessity", "anthropic", 1);
  assert.ok(again.outcome === "ready");
  for await (const event of again.run(new AbortController().signal)) void event;
  const after = await service.get(caseId, "medical-necessity");
  assert.ok(after.outcome === "read");
  assert.equal(after.section.versions[0].consistency?.status, "failed");
  assert.equal(after.section.costUsd, total, "the section total keeps what the first check cost");
  assert.equal(after.section.versions[0].checkCostUsd, firstCheck, "the version's checks cost what they cost");
  const stored = JSON.parse(readFileSync(caseFile, "utf8")).sections["medical-necessity"].versions[0].consistency;
  assert.equal(stored.earlierCostUsd, firstCheck);
  assert.deepEqual(stored.earlierUsage, { uncachedInputTokens: 1000, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 500, reasoningTokens: null });

  // A check stopped before it ends saves nothing, so the earlier record stays as it was.
  failChecks = false;
  const stopped = await service.prepareCheck(caseId, "medical-necessity", "anthropic", 1);
  assert.ok(stopped.outcome === "ready");
  const controller = new AbortController();
  controller.abort();
  for await (const event of stopped.run(controller.signal)) void event;
  const still = await service.get(caseId, "medical-necessity");
  assert.ok(still.outcome === "read");
  assert.equal(still.section.costUsd, total);

  // A successful one adds its own cost to the earlier ones.
  const ok = await service.prepareCheck(caseId, "medical-necessity", "anthropic", 1);
  assert.ok(ok.outcome === "ready");
  for await (const event of ok.run(new AbortController().signal)) void event;
  const last = await service.get(caseId, "medical-necessity");
  assert.ok(last.outcome === "read");
  assert.ok(Math.abs(last.section.costUsd - (total + firstCheck)) < 1e-12);
  assert.ok(Math.abs(last.section.versions[0].checkCostUsd! - 2 * firstCheck) < 1e-12);
});

test("a check records its tokens and cost, as a version does", async () => {
  const { service, caseId, caseFile } = await setup();
  saved(await service.saveText(caseId, "background-information", "Her own background text.", null));
  const events = await generate(service, caseId, "medical-necessity", { kind: "draft" });
  const checked = events.at(-1);
  assert.ok(checked?.type === "checked" && checked.result.outcome === "saved");
  const version = checked.result.section.versions.at(-1)!;
  assert.ok(version.checkCostUsd !== null && version.checkCostUsd > 0, "the check's cost is shown");
  const stored = JSON.parse(readFileSync(caseFile, "utf8")).sections["medical-necessity"].versions[0];
  const tokens = { uncachedInputTokens: 1000, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 500, reasoningTokens: null };
  assert.deepEqual(stored.consistency.usage, tokens);
  assert.deepEqual(stored.generation.usage, tokens, "a version keeps the reasoning tokens too");
  assert.equal(stored.consistency.costUsd, version.checkCostUsd);
  // Read back as the app reads it.
  const read = await service.get(caseId, "medical-necessity");
  assert.ok(read.outcome === "read");
  assert.equal(read.section.costUsd, (version.costUsd ?? 0) + (version.checkCostUsd ?? 0));
});

test("copy for ABA Matrix puts plain text and minimal HTML on the clipboard and counts the markers", async () => {
  const { service, caseId, clipboard } = await setup();
  saved(await service.saveText(caseId, "crisis-plan", "One <b> & [MISSING: x].\n\nTwo\nlines [CHECK: y].", null));
  assert.deepEqual(await service.copy(caseId, "crisis-plan", 1), { outcome: "copied", markers: 2 });
  assert.deepEqual(clipboard, [{ text: "One <b> & [MISSING: x].\n\nTwo\nlines [CHECK: y].", html: "<p>One &lt;b&gt; &amp; [MISSING: x].</p><p>Two<br>lines [CHECK: y].</p>" }]);
  assert.deepEqual(await service.copy(caseId, "crisis-plan", 9), { outcome: "version-not-found" });
  assert.deepEqual(abaMatrixClipboard("\n\nA\n\n\nB\n").text, "A\n\nB");
});

test("a stopped request saves nothing", async () => {
  const { service, caseId } = await setup();
  const controller = new AbortController();
  const ready = await service.prepareGeneration(caseId, "medical-necessity", "anthropic", { kind: "draft" });
  assert.ok(ready.outcome === "ready");
  const events = [];
  for await (const event of ready.run(controller.signal)) {
    events.push(event);
    if (event.type === "text") controller.abort();
  }
  assert.ok(!events.some((e) => e.type === "saved"));
  const read = await service.get(caseId, "medical-necessity");
  assert.ok(read.outcome === "read");
  assert.equal(read.section.versions.length, 0);
});

test("hostile input is refused before anything is read or sent", async () => {
  const { service, caseId, model } = await setup();
  await assert.rejects(service.get(caseId, "not-a-section"), /Refused/);
  await assert.rejects(service.saveText(caseId, "crisis-plan", 42, null), /Refused/);
  await assert.rejects(service.saveText("not-an-id", "crisis-plan", "x", null), /Refused/);
  await assert.rejects(service.prepareGeneration(caseId, "crisis-plan", "mock", { kind: "draft" }), /Refused/);
  await assert.rejects(service.prepareGeneration(caseId, "crisis-plan", "anthropic", { kind: "draft", extra: 1 }), /Refused/);
  await assert.rejects(service.prepareGeneration(caseId, "crisis-plan", "anthropic", { kind: "change", fromVersion: 1, request: "  " }), /Refused/);
  assert.deepEqual(await service.prepareGeneration(caseId, "crisis-plan", "anthropic", { kind: "improve", fromVersion: 3 }), { outcome: "version-not-found" });
  assert.equal(model.prompts.length, 0);
});

test("session notes are used until a new session archives them; nothing is deleted", async () => {
  const { service, caseId, caseFile } = await setup();
  assert.deepEqual(await service.saveNotes(caseId, "Note for today."), { outcome: "saved", notes: "Note for today." });
  assert.deepEqual(await service.startNewSession(caseId), { outcome: "saved", notes: "" });
  const stored = JSON.parse(readFileSync(caseFile, "utf8"));
  assert.equal(stored.sessionNotes, undefined);
  assert.equal(stored.sessionNotesArchive[0].text, "Note for today.");
  assert.ok(stored.sessionNotesArchive[0].endedAt);
});

test("a version 2 case reads as version 3 with no sections, keeping what it held", async () => {
  const { caseFile } = await setup();
  const v3 = JSON.parse(readFileSync(caseFile, "utf8"));
  const { sections: _sections, ...v2body } = v3;
  void _sections;
  const v2 = { ...v2body, schemaVersion: 2, extra: { kept: true } };
  const read = readCaseFile(JSON.stringify(v2));
  assert.ok(read.ok);
  assert.equal(read.migratedFrom, 2);
  assert.deepEqual(read.data.sections, {});
  const again = JSON.parse(serializeCaseFile(read.data));
  assert.deepEqual(again.extra, { kept: true });
  assert.deepEqual(again.sources, v2.sources);
  // A version 3 file with a section id and a version kind this version does not know keeps them.
  const later = { ...v3, sections: { "future-section": { currentVersion: 1, approvedVersion: null, versions: [{ number: 1, kind: "future-kind", createdAt: v3.createdAt, text: "x", extra: 1 }] } } };
  const readLater = readCaseFile(JSON.stringify(later));
  assert.ok(readLater.ok);
  assert.deepEqual(JSON.parse(serializeCaseFile(readLater.data)).sections, later.sections);
  writeFileSync(caseFile, JSON.stringify(later));
});

test("the pure section functions: an editing pass, context, notes", () => {
  const base = readCaseFile(JSON.stringify({ schemaVersion: 2, id: "3f0c1a2b-4c5d-4e6f-8a9b-0c1d2e3f4a5b", label: "Case", createdAt: "2026-11-22T15:00:00.000Z", updatedAt: "2026-11-22T15:00:00.000Z", files: [], sources: [] }));
  assert.ok(base.ok);
  assert.equal(saveOwnText(base.data, "crisis-plan", "   ", null, "2026-11-22T15:00:00.000Z"), null, "nothing to save in an empty paste");
  const one = saveOwnText(base.data, "crisis-plan", "Hers.", null, "2026-11-22T15:00:00.000Z");
  assert.ok(one);
  assert.deepEqual(contextSections(one.data, "medical-necessity").map((c) => [c.id, c.version]), [["crisis-plan", 1]]);
  assert.deepEqual(contextSections(one.data, "crisis-plan"), [], "never the section itself");
  const notes = setNotes(one.data, "N", "2026-11-22T16:00:00.000Z");
  assert.ok(notes);
  assert.equal(setNotes(notes, "N", "2026-11-22T17:00:00.000Z"), null);
  const archived = startNewSession(notes, "2026-11-22T18:00:00.000Z");
  assert.ok(archived);
  assert.equal(archived.sessionNotes, undefined);
  assert.equal(archived.sessionNotesArchive?.length, 1);
});

test("standing instructions: one history entry per editing pass; a damaged file is never written over", async () => {
  const empty = readInstructionsFile(null);
  assert.ok(empty.ok);
  const t0 = new Date("2026-11-22T10:00:00.000Z");
  const a = changeInstructions(empty.file, "medical-necessity", "First.", t0)!;
  const b = changeInstructions(a, "medical-necessity", "First, typed on.", new Date(t0.getTime() + 1000))!;
  assert.deepEqual(b.sections["medical-necessity"].history, [], "the same pass");
  const c = changeInstructions(b, "medical-necessity", "Next pass.", new Date(t0.getTime() + EDITING_PASS_MS + 1000))!;
  assert.deepEqual(c.sections["medical-necessity"].history.map((h) => h.text), ["First, typed on."]);
  assert.equal(changeInstructions(c, "medical-necessity", "Next pass.", t0), null);
  assert.deepEqual(readInstructionsFile("{ broken"), { ok: false, problem: "damaged" });
  assert.deepEqual(readInstructionsFile(JSON.stringify({ version: 2, sections: {} })), { ok: false, problem: "newer-version" });

  const folder = tempFolder();
  const file = path.join(folder, INSTRUCTIONS_FILE_NAME);
  const store = new InstructionsStore(file, { log: () => undefined });
  assert.equal(await store.save("crisis-plan", "Use the agency's protocol."), true);
  assert.equal(await store.get("crisis-plan"), "Use the agency's protocol.");
  writeFileSync(file, "{ damaged");
  assert.equal(await store.save("crisis-plan", "x"), false);
  assert.equal(readFileSync(file, "utf8"), "{ damaged");
  assert.equal(await store.get("crisis-plan"), "");
});

/* Review round 1 */

test("B1: a check line longer than the data file allows is cut, and the case stays readable", async () => {
  const long = "x".repeat(2500);
  const { service, caseId, caseFile } = await setup({ consistency: `- ${long}` });
  saved(await service.saveText(caseId, "background-information", "Her own background text.", null));
  const events = await generate(service, caseId, "medical-necessity", { kind: "draft" });
  const checked = events.at(-1);
  assert.ok(checked?.type === "checked" && checked.result.outcome === "saved");
  const item = checked.result.section.versions.at(-1)!.consistency!.items[0];
  assert.equal(item.length, 2000);
  assert.ok(readCaseFile(readFileSync(caseFile)).ok, "the case reads back");
  assert.equal((await service.get(caseId, "medical-necessity")).outcome, "read");
});

test("B1: a change that would not read back whole is refused, and the file is left as it was", async () => {
  const { caseId, caseFile, cases } = await setup();
  const before = readFileSync(caseFile, "utf8");
  const result = await cases.changeCase(caseId, (data) => ({
    save: { ...data, sections: { "crisis-plan": { currentVersion: 1, approvedVersion: null, versions: [{ number: 1, kind: "draft", createdAt: data.createdAt, text: "x", consistency: { status: "found", items: ["y".repeat(2001)], checkedAt: data.createdAt, model: null, costUsd: null, sectionsCompared: [] } }] } } },
    value: null,
  }));
  assert.deepEqual(result, { kind: "failed", outcome: "not-saved" });
  assert.equal(readFileSync(caseFile, "utf8"), before);
});

test("B2: her edit of her own text is what the other sections are built on, not the text she corrected", async () => {
  const { service, caseId, model } = await setup();
  saved(await service.saveText(caseId, "background-information", "Seen on 10/02/2026 (wrong date).", null));
  saved(await service.saveText(caseId, "background-information", "Seen on 10/12/2026 (her correction).", null));
  await generate(service, caseId, "background-information", { kind: "improve", fromVersion: 2 });
  await generate(service, caseId, "medical-necessity", { kind: "draft" });
  const draft = model.prompts.find((prompt) => prompt.task.includes("Draft request") && prompt.task.includes("Medical Necessity"))!;
  assert.match(draft.task, /her correction/);
  assert.doesNotMatch(draft.task, /wrong date/);
  // Her edit of the AI's version is not hers all the way down: her own text stays the context.
  const view = await service.get(caseId, "background-information");
  assert.ok(view.outcome === "read");
  assert.deepEqual(view.section.versions.map((v) => v.kind), ["hers", "edited", "improve"]);
  saved(await service.saveText(caseId, "background-information", "An edit of the AI's text.", null));
  await generate(service, caseId, "crisis-plan", { kind: "draft" });
  const crisis = model.prompts.find((prompt) => prompt.task.includes('"Crisis Plan"') && prompt.task.includes("Draft request"))!;
  assert.match(crisis.task, /her correction/);
});

test("B3: section text, instructions and notes that cannot be saved are kept in the main process with what was typed, and Try again saves them", async () => {
  let failing = false;
  const { service, caseId, caseFile, cases } = await setup({}, { failWrites: () => failing });
  const failed = new FailedSaves({ run: runSaves(cases, () => service), labelOf: () => "Invented case", newId: (() => { let n = 0; return () => `id-${++n}`; })() });
  failing = true;
  assert.equal((await failed.save(caseId, { kind: "section-text", sectionId: "crisis-plan", text: "Typed while the disk refused.", editing: null })).outcome, "not-saved");
  assert.equal((await failed.save(caseId, { kind: "notes", text: "Notes typed then." })).outcome, "not-saved");
  assert.deepEqual(
    failed.list().map(({ about, sectionId, failure }) => ({ about, sectionId, failure })),
    [
      { about: "section", sectionId: "crisis-plan", failure: "not-saved" },
      { about: "notes", sectionId: null, failure: "not-saved" },
    ],
  );
  failing = false;
  for (const item of failed.list()) assert.equal((await failed.retry(item.id)).outcome, "saved");
  assert.equal(failed.size, 0);
  const stored = JSON.parse(readFileSync(caseFile, "utf8"));
  assert.equal(stored.sections["crisis-plan"].versions[0].text, "Typed while the disk refused.");
  assert.equal(stored.sessionNotes.text, "Notes typed then.");
});

test("B3: instructions that cannot be saved are kept too, under the case they were typed in", async () => {
  const { caseId, cases } = await setup();
  const folder = tempFolder();
  const file = path.join(folder, "instructions.json");
  writeFileSync(file, "{ damaged");
  const service = new SectionService({
    cases,
    instructions: new InstructionsStore(file, { log: () => undefined }),
    rulesDir: path.join(process.cwd(), "rules"),
    provider: () => mockProvider,
    credential: async () => null,
    chosenModel: async () => null,
    rememberProvider: async () => undefined,
    writeClipboard: async () => undefined,
  });
  const failed = new FailedSaves({ run: runSaves(cases, () => service), labelOf: () => null });
  assert.equal((await failed.save(caseId, { kind: "instructions", sectionId: "crisis-plan", text: "Mine." })).outcome, "not-saved");
  assert.deepEqual(failed.list().map(({ caseId: inCase, about, sectionId }) => ({ inCase, about, sectionId })), [{ inCase: caseId, about: "instructions", sectionId: "crisis-plan" }]);
});

test("M1: a paragraph change that answers with the whole section is not saved", async () => {
  const { service, caseId } = await setup({ paragraph: "First paragraph of an invented draft.\n\nA new second paragraph.\n\nThird paragraph." });
  await generate(service, caseId, "medical-necessity", { kind: "draft" });
  const events = await generate(service, caseId, "medical-necessity", { kind: "paragraph", fromVersion: 1, paragraphIndex: 1, request: "x" });
  assert.deepEqual(events.find((e) => e.type === "saved"), { type: "saved", result: { outcome: "not-one-paragraph" } });
  const read = await service.get(caseId, "medical-necessity");
  assert.ok(read.outcome === "read");
  assert.equal(read.section.versions.length, 1);
});

test("M1: what counts as one paragraph's answer", () => {
  const text = "A first paragraph that is long enough to be recognised.\n\nShort second.\n\nA third paragraph that is long enough to be recognised.";
  assert.equal(isParagraphAnswer(text, 1, "A better second."), true);
  assert.equal(isParagraphAnswer(text, 1, "Second, part one.\n\nSecond, part two."), true);
  assert.equal(isParagraphAnswer(text, 1, "One.\n\nTwo.\n\nThree."), false, "more than two paragraphs");
  assert.equal(isParagraphAnswer(text, 1, "A first paragraph that is long enough to be recognised. Short second, better."), false, "repeats another paragraph");
  assert.equal(isParagraphAnswer(text, 1, "y".repeat(2000)), false, "much longer than the paragraph");
});

test("M2: a paragraph change on her irregular text keeps everything else byte for byte", async () => {
  const pasted = "  Indented first.  \n\n\n\nSecond.\n \nThird line one\nline two  ";
  assert.equal(replaceParagraph(pasted, 1, "  New P2. "), "  Indented first.  \n\n\n\nNew P2.\n \nThird line one\nline two  ");
  const { service, caseId } = await setup({ paragraph: "New P2." });
  saved(await service.saveText(caseId, "crisis-plan", pasted, null));
  const events = await generate(service, caseId, "crisis-plan", { kind: "paragraph", fromVersion: 1, paragraphIndex: 1, request: "x" });
  const savedEvent = events.find((e) => e.type === "saved");
  assert.ok(savedEvent?.type === "saved" && savedEvent.result.outcome === "saved");
  assert.equal(savedEvent.result.section.versions[1].text, "  Indented first.  \n\n\n\nNew P2.\n \nThird line one\nline two  ");
  assert.equal(savedEvent.result.section.versions[0].text, pasted);
});

test("M2: paragraph spans and splitParagraphs agree on any text", () => {
  const pieces = ["A", "b c", " ", "\n", "\n\n", "\n \n", "\t", "\n\n\n"];
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let round = 0; round < 500; round++) {
    const text = Array.from({ length: 1 + Math.floor(random() * 12) }, () => pieces[Math.floor(random() * pieces.length)]).join("");
    assert.deepEqual(paragraphSpans(text).map(({ start, end }) => text.slice(start, end)), splitParagraphs(text), JSON.stringify(text));
  }
});

test("M3: lines with no blank lines between them are one paragraph, and can be made each a paragraph", () => {
  assert.equal(hasLinesInParagraphs("Para one.\nPara two.\nPara three."), true);
  assert.equal(hasLinesInParagraphs("Para one.\n\nPara two."), false);
  assert.equal(linesAsParagraphs("Para one.\r\n Para two. \n\nPara three."), "Para one.\n\nPara two.\n\nPara three.");
});

test("M5: a check that failed can be run again, and a check is marked stale when her sections change", async () => {
  const { service, caseId } = await setup({ consistency: "Maybe." });
  saved(await service.saveText(caseId, "background-information", "Her own background text.", null));
  const events = await generate(service, caseId, "medical-necessity", { kind: "draft" });
  const checked = events.at(-1);
  assert.ok(checked?.type === "checked" && checked.result.outcome === "saved");
  assert.equal(checked.result.section.versions[0].consistency?.status, "failed");
  // Run again (here the model still answers the same way, but the request goes through and is saved again).
  const again = await service.prepareCheck(caseId, "medical-necessity", "anthropic", 1);
  assert.ok(again.outcome === "ready");
  const out = [];
  for await (const event of again.run(new AbortController().signal)) out.push(event);
  assert.deepEqual(out.map((e) => e.type), ["status", "checked"]);
  // Her section changes: the check no longer holds.
  saved(await service.saveText(caseId, "background-information", "Her corrected background.", null));
  const read = await service.get(caseId, "medical-necessity");
  assert.ok(read.outcome === "read");
  assert.equal(read.section.versions[0].consistency?.stale, true);
  assert.deepEqual(await service.prepareCheck(caseId, "medical-necessity", "anthropic", 9), { outcome: "version-not-found" });
});

test("low 1: her text that is approved is never changed in place; the edit becomes a new version", async () => {
  const { service, caseId } = await setup();
  saved(await service.saveText(caseId, "crisis-plan", "Approved text.", null));
  saved(await service.approve(caseId, "crisis-plan", 1));
  const edit = saved(await service.saveText(caseId, "crisis-plan", "Changed.", 1));
  assert.deepEqual(edit.section.versions.map((v) => [v.number, v.text]), [[1, "Approved text."], [2, "Changed."]]);
  assert.equal(edit.section.approvedVersion, null);
});

test("nit: an answer longer than a section can be is not saved, with its own reason", async () => {
  const huge: Provider = {
    ...mockProvider,
    async *generate(options) {
      yield { type: "text", delta: "y ".repeat(60_000) };
      yield { type: "done", complete: true, stopReason: "end_turn", servedModel: options.model, usage, attempts: null };
    },
  };
  const { service, caseId } = await setup({}, { provider: huge });
  const events = await generate(service, caseId, "crisis-plan", { kind: "draft" });
  assert.deepEqual(events.find((e) => e.type === "saved"), { type: "saved", result: { outcome: "too-long" } });
});

/* The owner's decision on M4 (2026-11-23): one cache for every request */

function claudeAnswer(text: string, model: string) {
  const usage = { input_tokens: 100, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  return sseResponse([
    ["message_start", { type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, stop_details: null, usage } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null, stop_details: null }, usage: { output_tokens: 50 } }],
    ["message_stop", { type: "message_stop" }],
  ]);
}

/** A Claude request up to and including its last cache breakpoint: what the cache is read with. */
function cachedPrefix(body: Record<string, unknown>) {
  const messages = body.messages as Array<{ role: string; content: Array<{ cache_control?: unknown }> }>;
  const content = messages[0].content;
  let last = -1;
  content.forEach((block, index) => {
    if (block.cache_control) last = index;
  });
  return { ...body, messages: [{ ...messages[0], content: content.slice(0, last + 1) }] };
}

test("M4: every kind of section request sends Claude the same settings and the same cached prefix, so one cache serves them all", async () => {
  const { fetchStub, calls } = stubFetch(({ body }) => {
    const request = body as { model: string; messages: Array<{ content: Array<{ text?: string }> }> };
    const task = request.messages[0].content.at(-1)?.text ?? "";
    const text = task.includes("Consistency check")
      ? "NO CONTRADICTIONS"
      : task.includes("Paragraph change request")
        ? "A better second paragraph."
        : "First paragraph of an invented draft.\n\nSecond paragraph.\n\nThird paragraph.";
    return claudeAnswer(text, request.model);
  });
  const claude = createAnthropicProvider({ fetch: fetchStub });
  const { service, caseId } = await setup({}, { provider: claude });
  saved(await service.saveText(caseId, "background-information", "Her own background text.", null));
  await generate(service, caseId, "medical-necessity", { kind: "draft" });
  await generate(service, caseId, "medical-necessity", { kind: "paragraph", fromVersion: 1, paragraphIndex: 1, request: "clearer" });
  await generate(service, caseId, "medical-necessity", { kind: "change", fromVersion: 2, request: "shorter" });
  await generate(service, caseId, "background-information", { kind: "improve", fromVersion: 1 });
  const again = await service.prepareCheck(caseId, "medical-necessity", "anthropic", 1);
  assert.ok(again.outcome === "ready");
  for await (const event of again.run(new AbortController().signal)) void event;

  const requests = calls.filter((call) => call.url.includes("/v1/messages")).map((call) => call.body!);
  const tasks = requests.map((body) => {
    const content = (body.messages as Array<{ content: Array<{ text?: string }> }>)[0].content;
    return content.at(-1)?.text ?? "";
  });
  // Draft, its check, paragraph change, its check, change, its check, improve and its check (against her
  // own Background Information text, since 2026-11-23), and the check run again.
  assert.equal(requests.length, 9);
  for (const kind of ["Draft request", "Paragraph change request", "Change request", "Improve request", "Consistency check"]) {
    assert.ok(tasks.some((task) => task.includes(kind)), `a ${kind} was sent`);
  }
  const first = cachedPrefix(requests[0]);
  assert.equal((first as unknown as { output_config: { effort: string } }).output_config.effort, "high");
  for (const [index, body] of requests.entries()) {
    assert.deepEqual(cachedPrefix(body), first, `request ${index + 1} (${tasks[index].split("\n").at(-1)?.slice(0, 40)}) has the draft's settings and cached prefix`);
  }
});

/** An OpenAI answer, streamed as the Responses API does. */
function openaiAnswer(text: string, model: string) {
  const response = { id: "resp_test", object: "response", model, status: "completed", output: [], usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 0 }, output_tokens: 50, output_tokens_details: { reasoning_tokens: 10 }, total_tokens: 150 } };
  return sseResponse([
    ["response.output_text.delta", { type: "response.output_text.delta", sequence_number: 0, item_id: "m1", output_index: 0, content_index: 0, delta: text, logprobs: [] }],
    ["response.completed", { type: "response.completed", sequence_number: 1, response }],
  ]);
}

test("ChatGPT sign-in: every kind of section request sends the same settings and input; only the instructions change, so implicit caching serves them all", async () => {
  const { fetchStub, calls } = stubFetch(({ body }) => {
    const request = body as { model: string; instructions: string };
    const text = request.instructions.includes("Consistency check")
      ? "NO CONTRADICTIONS"
      : request.instructions.includes("Paragraph change request")
        ? "A better second paragraph."
        : "First paragraph of an invented draft.\n\nSecond paragraph.\n\nThird paragraph.";
    return openaiAnswer(text, request.model);
  });
  const { service, caseId, caseFile, cases } = await setup({}, { provider: createOpenAIProvider({ fetch: fetchStub }), credential: { kind: "chatgpt", accessToken: "chatgpt-access-token-not-real" } });
  saved(await service.saveText(caseId, "background-information", "Her own background text.", null));
  await generate(service, caseId, "medical-necessity", { kind: "draft" });
  await generate(service, caseId, "medical-necessity", { kind: "paragraph", fromVersion: 1, paragraphIndex: 1, request: "clearer" });
  await generate(service, caseId, "medical-necessity", { kind: "change", fromVersion: 2, request: "shorter" });
  await generate(service, caseId, "background-information", { kind: "improve", fromVersion: 1 });
  // The test's service sends every provider id to this one OpenAI provider; "anthropic" keeps the model the other requests used.
  const again = await service.prepareCheck(caseId, "medical-necessity", "anthropic", 1);
  assert.ok(again.outcome === "ready");
  for await (const event of again.run(new AbortController().signal)) void event;
  const requests = calls.map((call) => call.body!);
  assert.equal(requests.length, 9, "draft, paragraph change, change and improve, each with its check, and a check run again");
  for (const kind of ["Draft request", "Paragraph change request", "Change request", "Improve request", "Consistency check"]) {
    assert.ok(requests.some((body) => String(body.instructions).includes(kind)), `a ${kind} was sent`);
  }
  const { instructions: firstTask, ...first } = requests[0];
  assert.match(String(firstTask), /Draft request/);
  // Review round 1, F3: the whole-assessment rules keep their force over the task.
  for (const body of requests) assert.ok(String(body.instructions).startsWith(`${CHATGPT_TASK_PREAMBLE}\n\n`));
  // Owner's decision, 2026-11-23: one opaque cache key for every request of the case, whatever its kind.
  const key = caseCacheKey(caseId);
  for (const body of requests) assert.equal(body.prompt_cache_key, key);
  for (const secret of [caseId, "Invented case", "Her own background text", "invented"]) assert.ok(!key.toLowerCase().includes(secret.toLowerCase()), secret);
  // Another case gets another key.
  const other = await cases.create({ label: "Another invented case" });
  assert.ok(other.outcome === "created");
  await cases.addTextSource(other.case.id, { type: "cde", text: "Invented notes for a second child who does not exist." });
  await generate(service, other.case.id, "crisis-plan", { kind: "draft" });
  const last = calls.at(-1)!.body!;
  assert.equal(last.prompt_cache_key, caseCacheKey(other.case.id));
  assert.notEqual(last.prompt_cache_key, key);
  assert.deepEqual(first.reasoning, { effort: "high" });
  for (const [index, body] of requests.entries()) {
    const { instructions, ...rest } = body;
    assert.equal(typeof instructions, "string");
    assert.deepEqual(rest, first, `request ${index + 1} sends the draft's settings and input`);
  }
  // A ChatGPT plan has no price per request: no cost, but the tokens are kept, reasoning included.
  const stored = JSON.parse(readFileSync(caseFile, "utf8")).sections["medical-necessity"].versions[0];
  assert.equal(stored.generation.costUsd, null);
  assert.deepEqual(stored.consistency.usage, { uncachedInputTokens: 100, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 50, reasoningTokens: 10 });
  assert.equal(stored.consistency.costUsd, null);
});

/* Review round 2 */

test("L1: her hand fix of the version she approved stays what the other sections build on", async () => {
  const { service, caseId, model } = await setup();
  saved(await service.saveText(caseId, "background-information", "Her pasted text.", null));
  saved(await service.saveText(caseId, "background-information", "Her edit of it.", null));
  await generate(service, caseId, "background-information", { kind: "improve", fromVersion: 2 });
  saved(await service.approve(caseId, "background-information", 3));
  const fixed = saved(await service.saveText(caseId, "background-information", "The improved text, with a typo fixed by hand.", null));
  assert.equal(fixed.section.approvedVersion, null, "an edit still clears the approval");
  await generate(service, caseId, "crisis-plan", { kind: "draft" });
  const draft = model.prompts.find((prompt) => prompt.task.includes('"Crisis Plan"') && prompt.task.includes("Draft request"))!;
  assert.match(draft.task, /with a typo fixed by hand/);
  assert.doesNotMatch(draft.task, /Her edit of it\./);
});

test("B3 round 2: a save that does not contain a kept text never forgets it, until its box has shown it", async () => {
  let failing = false;
  const { service, caseId, caseFile, cases } = await setup({}, { failWrites: () => failing });
  failing = true;
  let n = 0;
  const failed = new FailedSaves({ run: runSaves(cases, () => service), labelOf: () => "Invented case", newId: () => `id-${++n}` });
  assert.equal((await failed.save(caseId, { kind: "notes", text: "Saved note. What the mother told me." })).outcome, "not-saved");
  // The page reloads: no box shows the kept text until one says so.
  failed.newPage();
  const [kept] = failed.list();
  assert.equal(kept.text, "Saved note. What the mother told me.");
  failing = false;
  // A save of the older text plus new typing (the box did not show the kept text): saved, but the kept text stays.
  assert.equal((await failed.save(caseId, { kind: "notes", text: "Saved note. Later." })).outcome, "saved");
  assert.deepEqual(failed.list().map((item) => item.text), ["Saved note. What the mother told me."]);
  // A save that holds it forgets it.
  assert.equal((await failed.save(caseId, { kind: "notes", text: "Saved note. What the mother told me. Later." })).outcome, "saved");
  assert.equal(failed.size, 0);
  // Once its box has shown it, the box's next save replaces it, whatever she did with the text.
  failing = true;
  await failed.save(caseId, { kind: "notes", text: "Another kept note." });
  failed.newPage();
  failed.markShown(failed.list()[0].id);
  failing = false;
  assert.equal((await failed.save(caseId, { kind: "notes", text: "She rewrote it." })).outcome, "saved");
  assert.equal(failed.size, 0);
  assert.equal(JSON.parse(readFileSync(caseFile, "utf8")).sessionNotes.text, "She rewrote it.");
});

test("B3 round 2: a kept section text a later save does not contain is saved as its own version first", async () => {
  let failing = false;
  const { service, caseId, caseFile, cases } = await setup({}, { failWrites: () => failing });
  const failed = new FailedSaves({ run: runSaves(cases, () => service), labelOf: () => null });
  assert.equal((await failed.save(caseId, { kind: "section-text", sectionId: "crisis-plan", text: "Hers v1.", editing: null })).outcome, "saved");
  failing = true;
  await failed.save(caseId, { kind: "section-text", sectionId: "crisis-plan", text: "Hers v1. A long correction typed before the reload.", editing: null });
  failed.newPage();
  assert.deepEqual(failed.list().map(({ text, editing }) => ({ text, editing })), [{ text: "Hers v1. A long correction typed before the reload.", editing: null }]);
  failing = false;
  // After the reload she edits the text on disk, not the kept one: the kept one is saved first, as its own version.
  assert.equal((await failed.save(caseId, { kind: "section-text", sectionId: "crisis-plan", text: "Hers v1. Small fix.", editing: null })).outcome, "saved");
  assert.equal(failed.size, 0);
  const texts = JSON.parse(readFileSync(caseFile, "utf8")).sections["crisis-plan"].versions.map((v: { text: string }) => v.text);
  assert.deepEqual(texts, ["Hers v1.", "Hers v1. A long correction typed before the reload.", "Hers v1. Small fix."]);
});

test("B3 round 2: a later failed text that does not hold the kept one is kept beside it", async () => {
  let failing = false;
  const { service, caseId, cases } = await setup({}, { failWrites: () => failing });
  failing = true;
  const failed = new FailedSaves({ run: runSaves(cases, () => service), labelOf: () => null });
  await failed.save(caseId, { kind: "notes", text: "First kept." });
  // After a reload, before any box shows it, a save typed over the older text on disk fails too.
  failed.newPage();
  await failed.save(caseId, { kind: "notes", text: "Typed over the old text" });
  await failed.save(caseId, { kind: "notes", text: "Typed over the old text, growing" });
  assert.deepEqual(failed.list().map((item) => item.text).sort(), ["First kept.", "Typed over the old text, growing"]);
});

/* Review round 3: R3-1 */

test("R3-1: typing and deleting in one box during an outage keeps only her latest text, and nothing older comes back", async () => {
  let failing = false;
  const { service, caseId, caseFile, cases } = await setup({}, { failWrites: () => failing });
  const failed = new FailedSaves({ run: runSaves(cases, () => service), labelOf: () => null });
  assert.equal((await failed.save(caseId, { kind: "notes", text: "Start." })).outcome, "saved");
  failing = true;
  await failed.save(caseId, { kind: "notes", text: "Mother said A. Teacher said C." });
  await failed.save(caseId, { kind: "notes", text: "Mother said A." });
  assert.deepEqual(failed.list().map((item) => item.text), ["Mother said A."], "one entry: the latest, in front of her");
  failing = false;
  assert.equal((await failed.save(caseId, { kind: "notes", text: "Mother said A. Grandmother said D." })).outcome, "saved");
  assert.equal(failed.size, 0, "nothing older is left to put back");
  assert.equal(JSON.parse(readFileSync(caseFile, "utf8")).sessionNotes.text, "Mother said A. Grandmother said D.");
});

test("R3-1: with a reload in between, the box shows the newest kept text and older snapshots can never come back over it", async () => {
  let failing = false;
  const { service, caseId, caseFile, cases } = await setup({}, { failWrites: () => failing });
  const failed = new FailedSaves({ run: runSaves(cases, () => service), labelOf: () => null });
  failing = true;
  await failed.save(caseId, { kind: "notes", text: "Mother said A. Teacher said C." });
  failed.newPage();
  // After the reload, before the box shows it, she deletes in a box still on the old text: kept beside.
  await failed.save(caseId, { kind: "notes", text: "Mother said A." });
  assert.deepEqual(failed.list().map((item) => item.text), ["Mother said A. Teacher said C.", "Mother said A."]);
  // The box shows the newest; the older one counts as shown too.
  failed.markShown(failed.list().at(-1)!.id);
  failing = false;
  assert.equal((await failed.save(caseId, { kind: "notes", text: "Mother said A. Grandmother said D." })).outcome, "saved");
  assert.equal(failed.size, 0);
  assert.equal(JSON.parse(readFileSync(caseFile, "utf8")).sessionNotes.text, "Mother said A. Grandmother said D.");
});

test("R3-1: the same sequence on her instructions keeps the latest text", async () => {
  const { caseId, cases } = await setup();
  const folder = tempFolder();
  const file = path.join(folder, "instructions.json");
  const service = new SectionService({
    cases,
    instructions: new InstructionsStore(file, { log: () => undefined }),
    rulesDir: path.join(process.cwd(), "rules"),
    provider: () => mockProvider,
    credential: async () => null,
    chosenModel: async () => null,
    rememberProvider: async () => undefined,
    writeClipboard: async () => undefined,
  });
  const failed = new FailedSaves({ run: runSaves(cases, () => service), labelOf: () => null });
  const op = (text: string) => ({ kind: "instructions" as const, sectionId: "medical-necessity", text });
  assert.equal((await failed.save(caseId, op("Start."))).outcome, "saved");
  // The outage: a folder where the file goes, so it can be neither read nor written.
  rmSync(file);
  mkdirSync(file);
  await failed.save(caseId, op("Score per area. Example from school."));
  await failed.save(caseId, op("Score per area."));
  assert.deepEqual(failed.list().map((item) => item.text), ["Score per area."]);
  rmSync(file, { recursive: true });
  assert.equal((await failed.save(caseId, op("Score per area. Example from home."))).outcome, "saved");
  assert.equal(failed.size, 0);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).sections["medical-necessity"].text, "Score per area. Example from home.");
});

test("R3-1, L-a: deleting text in the section editor during an outage adds no version of the deleted text", async () => {
  let failing = false;
  const { service, caseId, caseFile, cases } = await setup({}, { failWrites: () => failing });
  const failed = new FailedSaves({ run: runSaves(cases, () => service), labelOf: () => null });
  await failed.save(caseId, { kind: "section-text", sectionId: "crisis-plan", text: "P1.", editing: null });
  failing = true;
  await failed.save(caseId, { kind: "section-text", sectionId: "crisis-plan", text: "P1. Wrong sentence.", editing: 1 });
  await failed.save(caseId, { kind: "section-text", sectionId: "crisis-plan", text: "P1.", editing: 1 });
  failing = false;
  await failed.save(caseId, { kind: "section-text", sectionId: "crisis-plan", text: "P1. Right sentence.", editing: 1 });
  const texts = JSON.parse(readFileSync(caseFile, "utf8")).sections["crisis-plan"].versions.map((v: { text: string }) => v.text);
  assert.deepEqual(texts, ["P1. Right sentence."]);
});

test("revision: every saved change answers with a later revision, so the screen can drop a snapshot that comes back late", async () => {
  const { service, caseId } = await setup();
  const first = saved(await service.saveText(caseId, "environmental-changes", "Para one.\nPara two.", null));
  const second = saved(await service.saveText(caseId, "environmental-changes", "Para one.\n\nPara two.", null));
  const approved = saved(await service.approve(caseId, "environmental-changes", 2));
  const shown = saved(await service.setCurrent(caseId, "environmental-changes", 1));
  const revisions = [first, second, approved, shown].map((result) => result.section.revision);
  for (const [older, newer] of revisions.slice(0, -1).map((revision, index) => [revision, revisions[index + 1]])) {
    assert.ok(isOlderRevision(older, newer), `${older} is older than ${newer}`);
    assert.ok(!isOlderRevision(newer, older));
  }
  const read = await service.get(caseId, "environmental-changes");
  assert.ok(read.outcome === "read");
  // A read changes nothing: the same revision, never older than the last answer.
  assert.equal(read.section.revision, shown.section.revision);
  assert.ok(!isOlderRevision(read.section.revision, shown.section.revision));
  // A revision that does not parse is never taken for an older one.
  assert.ok(!isOlderRevision("not a date", shown.section.revision));
});
