import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { JUDGE_SCHEMA_NAME, type JudgeInput } from "../src/lib/judge.ts";
import { mockProvider } from "../src/lib/providers/mock.ts";
import { responsesRequest } from "../src/lib/providers/openai.ts";
import type { GenerateEvent, GenerateOptions, Provider } from "../src/lib/providers/types.ts";
import { CASE_FILE_NAME } from "../src/main/case-file.ts";
import { caseCacheKey } from "../src/main/cache-key.ts";
import { CaseLibrary } from "../src/main/cases.ts";
import { INSTRUCTIONS_FILE_NAME, InstructionsStore } from "../src/main/instructions.ts";
import { resolveJudgeEnabled } from "../src/main/paths.ts";
import { SectionService } from "../src/main/sections.ts";
import type { GenerationUpdateEvent } from "../src/shared/api.ts";

/*
 * The app side of the evaluation's judge (development only): it goes through the section
 * service and prepareOutgoingRequest like her requests, sends the JSON schema when asked,
 * saves nothing, and is only reachable in a development build started hidden.
 */

const folders: string[] = [];
after(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});
const temp = () => {
  const folder = mkdtempSync(path.join(tmpdir(), "aba-eval-app-test-"));
  folders.push(folder);
  return folder;
};

const usage = { uncachedInputTokens: 10, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 5, reasoningTokens: null };

const JUDGE: JudgeInput = {
  rubricVersion: "1",
  items: [{ id: "thread", title: "Thread", anchors: { 2: "good", 1: "ok", 0: "bad" } }],
  expectations: ["Two paragraphs."],
  keyFacts: [{ id: "f1", fact: "A fact." }],
  caseNotes: [],
  payerFacts: ["Discharge grounds as the payer lists them."],
  format: "json-schema",
  repair: null,
};

async function setup() {
  const folder = temp();
  const sent: GenerateOptions[] = [];
  const provider: Provider = {
    ...mockProvider,
    id: "openai",
    async *generate(options): AsyncIterable<GenerateEvent> {
      sent.push(options);
      const answer = options.prompt.task.includes("<section-under-review") ? '{"section":"medical-necessity"}' : "A drafted paragraph.\n\nAnother one.";
      yield { type: "text", delta: answer };
      yield { type: "done", complete: true, stopReason: "completed", servedModel: options.model, usage, attempts: null };
    },
  };
  const cases = new CaseLibrary({ location: async () => ({ folder, isDefault: false }), log: () => undefined });
  const created = await cases.create({ label: "Invented eval case" });
  assert.ok(created.outcome === "created");
  const caseId = created.case.id;
  await cases.addTextSource(caseId, { type: "cde", text: "Invented CDE notes." });
  const service = new SectionService({
    cases,
    instructions: new InstructionsStore(path.join(temp(), INSTRUCTIONS_FILE_NAME), { log: () => undefined }),
    rulesDir: path.join(process.cwd(), "rules"),
    provider: () => provider,
    credential: async () => ({ kind: "chatgpt", accessToken: "not-a-real-token" }),
    chosenModel: async () => null,
    rememberProvider: async () => undefined,
    writeClipboard: async () => undefined,
    log: () => undefined,
  });
  return { service, caseId, sent, caseFile: path.join(folder, "Invented eval case", CASE_FILE_NAME) };
}

async function collect(run: (signal: AbortSignal) => AsyncIterable<Exclude<GenerationUpdateEvent, { type: "finished" }>>) {
  const events: Array<Exclude<GenerationUpdateEvent, { type: "finished" }>> = [];
  for await (const event of run(new AbortController().signal)) events.push(event);
  return events;
}

test("judge: scores the current versions through the app's own path, with the JSON schema, and saves nothing", async () => {
  const { service, caseId, sent, caseFile } = await setup();
  const draft = await service.prepareGeneration(caseId, "medical-necessity", "openai", { kind: "draft" });
  assert.ok(draft.outcome === "ready");
  await collect(draft.run);
  await service.saveText(caseId, "risk-assessment", "Her own risk text.", null);
  const before = readFileSync(caseFile, "utf8");

  const ready = await service.prepareJudge(caseId, "medical-necessity", "openai", JUDGE);
  assert.ok(ready.outcome === "ready");
  const events = await collect(ready.run);
  assert.equal(events.filter((event) => event.type === "text").map((event) => (event as { delta: string }).delta).join(""), '{"section":"medical-necessity"}');
  assert.ok(!events.some((event) => event.type === "saved" || event.type === "checked"));
  assert.equal(readFileSync(caseFile, "utf8"), before, "the case file is not touched");

  const judged = sent.at(-1)!;
  assert.match(judged.prompt.system, /reviewer of an evaluation set/);
  assert.doesNotMatch(judged.prompt.system, /ABA Matrix template has 22 sections|Write the/);
  assert.equal(judged.prompt.sources.length, 1, "the case's sources, as her requests send them");
  assert.match(judged.prompt.task, /<section-under-review title="Medical Necessity Criteria">\nA drafted paragraph/);
  assert.match(judged.prompt.task, /<section title="Risk Assessment">\nHer own risk text\./);
  assert.equal(judged.outputFormat?.name, JUDGE_SCHEMA_NAME);
  assert.equal(judged.cacheKey, caseCacheKey(caseId));
  const meta = events.find((event) => event.type === "meta") as { rulesVersions: Record<string, string> } | undefined;
  assert.deepEqual(meta?.rulesVersions, { judge: "2", rubric: "1" });

  const plain = await service.prepareJudge(caseId, "medical-necessity", "openai", { ...JUDGE, format: "plain-json" });
  assert.ok(plain.outcome === "ready");
  await collect(plain.run);
  assert.equal(sent.at(-1)!.outputFormat, null);
});

test("judge: her session notes and her standing instructions for the section reach the judge's prompt (review B2)", async () => {
  const { service, caseId, sent } = await setup();
  const draft = await service.prepareGeneration(caseId, "environmental-changes", "openai", { kind: "draft" });
  assert.ok(draft.outcome === "ready");
  await collect(draft.run);
  assert.equal((await service.saveNotes(caseId, "The YMCA program accepted her on 11/20.")).outcome, "saved");
  assert.equal((await service.saveInstructions("environmental-changes", "Give her standard supports.")).outcome, "saved");
  const ready = await service.prepareJudge(caseId, "environmental-changes", "openai", JUDGE);
  assert.ok(ready.outcome === "ready");
  await collect(ready.run);
  const task = sent.at(-1)!.prompt.task;
  assert.match(task, /<session-notes>\nThe YMCA program accepted her on 11\/20\.\n<\/session-notes>/);
  assert.match(task, /<standing-instructions>\nGive her standard supports\.\n<\/standing-instructions>/);
  assert.match(task, /<payer-facts>\n- Discharge grounds as the payer lists them\.\n<\/payer-facts>/);
});

test("judge: refuses input that is not a judge request, and a section with no text", async () => {
  const { service, caseId } = await setup();
  await assert.rejects(service.prepareJudge(caseId, "medical-necessity", "openai", { ...JUDGE, extra: "/etc/passwd" }), /Refused/);
  await assert.rejects(service.prepareJudge(caseId, "not-a-section", "openai", JUDGE), /Refused/);
  assert.deepEqual(await service.prepareJudge(caseId, "crisis-plan", "openai", JUDGE), { outcome: "version-not-found" });
});

test("OpenAI: the judge's schema goes in text.format on both routes; her requests never send one", () => {
  const prompt = { system: "S", sources: [], task: "T" };
  const base = { model: "gpt-6.2-astra", effort: "high" as const, maxOutputTokens: 100, prompt, signal: new AbortController().signal };
  const schema = { type: "object", additionalProperties: false, required: [], properties: {} };
  for (const credential of [{ kind: "chatgpt" as const, accessToken: "t" }, { kind: "api-key" as const, apiKey: "k" }]) {
    const body = responsesRequest({ ...base, credential, outputFormat: { name: "rubric_scores", schema } }) as unknown as Record<string, unknown>;
    assert.deepEqual(body.text, { format: { type: "json_schema", name: "rubric_scores", schema, strict: true } });
    assert.equal("text" in (responsesRequest({ ...base, credential }) as unknown as Record<string, unknown>), false);
  }
});

test("the judge is reachable only in a development build started hidden", () => {
  assert.equal(resolveJudgeEnabled({ isPackaged: false, hidden: true }), true);
  assert.equal(resolveJudgeEnabled({ isPackaged: false, hidden: false }), false);
  assert.equal(resolveJudgeEnabled({ isPackaged: true, hidden: true }), false);
  assert.equal(resolveJudgeEnabled({ isPackaged: true, hidden: false }), false);
});

test("only src/main/outgoing.ts builds the judge's prompt, and only the section service prepares it", () => {
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
  assert.deepEqual(using(/buildJudgePrompt\(/), ["src/lib/judge.ts", "src/main/outgoing.ts"]);
  assert.deepEqual(using(/prepareJudgeRequest\(/), ["src/main/outgoing.ts", "src/main/sections.ts"]);
  assert.deepEqual(using(/outputFormat: \{|outputFormat =/), ["src/main/sections.ts"], "her requests never ask for a schema");
});
