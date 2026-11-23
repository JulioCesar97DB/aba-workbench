import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { mockProvider } from "../src/lib/providers/mock.ts";
import type { GenerateEvent, GenerateOptions, Provider } from "../src/lib/providers/types.ts";
import { CASE_FILE_NAME, readCaseFile, serializeCaseFile } from "../src/main/case-file.ts";
import { contextSections, saveOwnText, startNewSession, setNotes } from "../src/main/case-sections.ts";
import { CaseLibrary } from "../src/main/cases.ts";
import { changeInstructions, EDITING_PASS_MS, INSTRUCTIONS_FILE_NAME, InstructionsStore, readInstructionsFile } from "../src/main/instructions.ts";
import { SectionService } from "../src/main/sections.ts";
import type { GenerationUpdateEvent, SectionSaveResult } from "../src/shared/api.ts";
import { abaMatrixClipboard } from "../src/shared/section-text.ts";

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
function fakeModel(answers: { consistency?: string } = {}) {
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
          ? "A new second paragraph, with a [MISSING: date of the IEP]."
          : "First paragraph of an invented draft.\n\nSecond paragraph.\n\nThird paragraph.";
      yield { type: "status", phase: "writing" };
      for (const piece of text.match(/.{1,7}/gsu) ?? []) yield { type: "text", delta: piece };
      yield { type: "done", complete: true, stopReason: "end_turn", servedModel: options.model, usage, attempts: null };
    },
  };
  return { provider, prompts };
}

async function setup(answers: { consistency?: string } = {}) {
  const folder = tempFolder();
  let ids = 0;
  const cases = new CaseLibrary({
    location: async () => ({ folder, isDefault: false }),
    newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
    log: () => undefined,
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
    provider: () => model.provider,
    credential: async () => ({ kind: "api-key", apiKey: "test-key-not-real" }),
    chosenModel: async () => null,
    rememberProvider: async () => undefined,
    writeClipboard: async (content) => void clipboard.push(content),
    log: () => undefined,
  });
  const caseFile = path.join(folder, "Invented case", CASE_FILE_NAME);
  return { service, caseId, model, clipboard, caseFile, userData };
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
  assert.deepEqual(checked.result.section.versions[0].consistency, { status: "nothing-to-compare", items: [] });
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
  assert.deepEqual(checked.result.section.versions.at(-1)!.consistency, { status: "none", items: [] });
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
  assert.deepEqual(checked.result.section.versions.at(-1)!.consistency, { status: "found", items: ["Background Information says 4 years old; this says 5.", "Another one."] });
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
