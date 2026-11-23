import { generationCostUsd } from "../lib/pricing.ts";
import type { Effort, Provider, ProviderCredential, TokenUsage } from "../lib/providers/types.ts";
import { loadSectionShape, parseConsistencyAnswer, type SectionRequest } from "../lib/rules.ts";
import type { SectionShape } from "../shared/section-text.ts";
import type {
  CopySectionResult,
  DraftingProvider,
  GenerationUpdateEvent,
  GetSectionResult,
  InstructionsSaveResult,
  NotesSaveResult,
  SectionSaveResult,
  StartSectionResult,
} from "../shared/api.ts";
import { defaultModel } from "../shared/models.ts";
import type { ReportSectionId } from "../shared/report-sections.ts";
import { abaMatrixClipboard, findMarkers, isParagraphAnswer, MAX_SECTION_TEXT_LENGTH, replaceParagraph, tidySectionText } from "../shared/section-text.ts";
import type { SectionRequestInput, VersionKind } from "../shared/sections.ts";
import type { CaseData, GenerationRecord } from "./case-file.ts";
import {
  addAiVersion,
  ApproveSchema,
  approveVersion,
  contextSections,
  EditingSchema,
  NotesSchema,
  saveOwnText,
  SectionIdSchema,
  SectionRequestSchema,
  SectionTextSchema,
  sectionDetail,
  sectionSummaries,
  sessionNotes,
  setConsistency,
  setCurrentVersion,
  setNotes,
  startNewSession,
  VersionSchema,
  versionText,
} from "./case-sections.ts";
import type { CaseLibrary } from "./cases.ts";
import type { InstructionsStore } from "./instructions.ts";
import { outgoingSourcesOf, prepareOutgoingRequest, type PreparedRequest } from "./outgoing.ts";
import { runSectionGeneration } from "./section-generation.ts";

/*
 * The report's sections, as the interface reaches them (src/main/ipc.ts): reading a
 * section, her own text, going back to a version, approving, her instructions and notes,
 * copying for ABA Matrix, and the AI's requests. Every argument from the interface is
 * checked here. Nothing here imports Electron (the clipboard and the providers are
 * passed in), so it is unit-tested with the mock provider.
 */

/**
 * Owner's decision, 2026-11-23 (review M4): every section request (draft, change,
 * paragraph change, improve, and the consistency check) runs with the same settings,
 * effort high and the same output room. Claude keys its cache on these settings too, so
 * one cache entry, written by the first request of the hour, serves every request after
 * it; a request with other settings would write its own (tests/section-requests.test.ts
 * checks the prefix is the same for every kind of request).
 */
const EFFORT: Effort = "high";
const MAX_OUTPUT_TOKENS = 32_000;

export interface SectionServiceOptions {
  cases: Pick<CaseLibrary, "changeCase">;
  instructions: Pick<InstructionsStore, "get" | "save">;
  rulesDir: string;
  /** The provider by id; tests pass the mock. */
  provider: (id: DraftingProvider) => Provider;
  /** The credential for a provider, or null when it is not connected. */
  credential: (id: DraftingProvider) => Promise<ProviderCredential | null>;
  /** The model chosen in Settings for a provider (null: the default). */
  chosenModel: (id: DraftingProvider) => Promise<string | null>;
  /** Remembers the provider she drafted with last. */
  rememberProvider: (id: DraftingProvider) => Promise<unknown>;
  /** A Claude key was refused on a request: the connection needs attention. */
  claudeKeyRefused?: () => Promise<void>;
  /** Writes the clipboard (Electron's clipboard.write in the app). */
  writeClipboard: (content: { text: string; html: string }) => Promise<void>;
  log?: (message: string) => void;
}

function refuse(message: string): never {
  throw new Error(`Refused: ${message}`);
}

function parse<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown, what: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) refuse(what);
  return parsed.data;
}

export class SectionService {
  private readonly options: SectionServiceOptions;

  constructor(options: SectionServiceOptions) {
    this.options = options;
  }

  /** What the section's rules ask of its shape; none when they cannot be read (the check then looks at formatting only). */
  private async shape(id: ReportSectionId): Promise<SectionShape> {
    return loadSectionShape(id, this.options.rulesDir).catch(() => ({ paragraphs: null, words: null }));
  }

  /** The section as the interface sees it. */
  private async detail(data: CaseData, id: ReportSectionId) {
    const [instructions, shape] = await Promise.all([this.options.instructions.get(id), this.shape(id)]);
    return sectionDetail(data, id, instructions, shape);
  }

  async get(caseId: unknown, sectionId: unknown): Promise<GetSectionResult> {
    const id = parse(SectionIdSchema, sectionId, "not a section.");
    const result = await this.options.cases.changeCase(caseId, () => ({ save: null, value: null }));
    if (result.kind === "saved" || result.kind === "unchanged") return { outcome: "read", section: await this.detail(result.data, id) };
    return { outcome: "case-unavailable" };
  }

  /** Runs a change to a section and answers with the section as saved. */
  private async change(caseId: unknown, id: ReportSectionId, change: (data: CaseData, now: string) => CaseData | null | "version-not-found"): Promise<SectionSaveResult> {
    const result = await this.options.cases.changeCase(caseId, (data, _folder, now) => {
      const next = change(data, now);
      if (next === "version-not-found") return { save: null, value: "version-not-found" as const };
      return { save: next, value: null };
    });
    if (result.kind === "unavailable") return { outcome: "case-unavailable" };
    if (result.kind === "failed") return { outcome: result.outcome };
    if (result.value === "version-not-found") return { outcome: "version-not-found" };
    return { outcome: "saved", section: await this.detail(result.data, id), sections: sectionSummaries(result.data) };
  }

  async saveText(caseId: unknown, sectionId: unknown, text: unknown, editing: unknown): Promise<SectionSaveResult> {
    const id = parse(SectionIdSchema, sectionId, "not a section.");
    const raw = parse(SectionTextSchema, text, "the text must be text.");
    const pass = parse(EditingSchema, editing, "not a version.");
    return this.change(caseId, id, (data, now) => saveOwnText(data, id, raw, pass, now)?.data ?? null);
  }

  async setCurrent(caseId: unknown, sectionId: unknown, version: unknown): Promise<SectionSaveResult> {
    const id = parse(SectionIdSchema, sectionId, "not a section.");
    const number = parse(VersionSchema, version, "not a version.");
    return this.change(caseId, id, (data) => setCurrentVersion(data, id, number) ?? "version-not-found");
  }

  async approve(caseId: unknown, sectionId: unknown, version: unknown): Promise<SectionSaveResult> {
    const id = parse(SectionIdSchema, sectionId, "not a section.");
    const number = parse(ApproveSchema, version, "not a version.");
    return this.change(caseId, id, (data, now) => approveVersion(data, id, number, now) ?? "version-not-found");
  }

  async saveInstructions(sectionId: unknown, text: unknown): Promise<InstructionsSaveResult> {
    const id = parse(SectionIdSchema, sectionId, "not a section.");
    const raw = parse(NotesSchema, text, "the instructions must be text.");
    return (await this.options.instructions.save(id, raw)) ? { outcome: "saved" } : { outcome: "not-saved" };
  }

  private async notesChange(caseId: unknown, change: (data: CaseData, now: string) => CaseData | null): Promise<NotesSaveResult> {
    const result = await this.options.cases.changeCase(caseId, (data, _folder, now) => ({ save: change(data, now), value: null }));
    if (result.kind === "unavailable") return { outcome: "case-unavailable" };
    if (result.kind === "failed") return { outcome: result.outcome };
    return { outcome: "saved", notes: sessionNotes(result.data) };
  }

  async saveNotes(caseId: unknown, text: unknown): Promise<NotesSaveResult> {
    const raw = parse(NotesSchema, text, "the notes must be text.");
    return this.notesChange(caseId, (data, now) => setNotes(data, raw, now));
  }

  startNewSession(caseId: unknown): Promise<NotesSaveResult> {
    return this.notesChange(caseId, (data, now) => startNewSession(data, now));
  }

  async copy(caseId: unknown, sectionId: unknown, version: unknown): Promise<CopySectionResult> {
    const id = parse(SectionIdSchema, sectionId, "not a section.");
    const number = parse(VersionSchema, version, "not a version.");
    const result = await this.options.cases.changeCase(caseId, (data) => ({ save: null, value: versionText(data, id, number) }));
    if (result.kind !== "unchanged" && result.kind !== "saved") return { outcome: "case-unavailable" };
    if (result.value === null) return { outcome: "version-not-found" };
    await this.options.writeClipboard(abaMatrixClipboard(result.value));
    return { outcome: "copied", markers: findMarkers(result.value).length };
  }

  /**
   * Checks a request and gets it ready: the case is read as it is now, and the run
   * streams the AI's text, saves the new version, then checks it against her sections.
   * Anything that stops it before the first event comes back as an outcome.
   */
  async prepareGeneration(
    caseId: unknown,
    sectionId: unknown,
    providerId: unknown,
    input: unknown,
  ): Promise<{ outcome: Exclude<StartSectionResult["outcome"], "started" | "busy"> } | { outcome: "ready"; run: (signal: AbortSignal) => AsyncIterable<Exclude<GenerationUpdateEvent, { type: "finished" }>> }> {
    const id = parse(SectionIdSchema, sectionId, "not a section.");
    if (providerId !== "anthropic" && providerId !== "openai") refuse("unknown provider.");
    const request = parse(SectionRequestSchema, input, "not a section request.") as SectionRequestInput;
    const credential = await this.options.credential(providerId);
    if (!credential) return { outcome: "not-connected" };
    const read = await this.options.cases.changeCase(caseId, () => ({ save: null, value: null }));
    if (read.kind !== "unchanged" && read.kind !== "saved") return { outcome: "case-unavailable" };
    const data = read.data;
    const baseText = request.kind === "draft" ? null : versionText(data, id, request.fromVersion);
    if (request.kind !== "draft" && baseText === null) return { outcome: "version-not-found" };
    if (request.kind === "paragraph" && replaceParagraph(baseText ?? "", request.paragraphIndex, "x") === null) refuse("no paragraph at that place.");
    const model = (await this.options.chosenModel(providerId)) ?? defaultModel(providerId);
    await this.options.rememberProvider(providerId).catch(() => undefined);
    return { outcome: "ready", run: (signal) => this.run({ caseId: caseId as string, id, providerId, credential, model, request, data, folder: read.folder, baseText, signal }) };
  }

  /**
   * "Check again" (review M5): runs only the consistency check on a version, through the
   * same preparation as every request, and saves its result with it. A check that failed,
   * was stopped, or no longer holds because her sections changed can always be run again.
   */
  async prepareCheck(
    caseId: unknown,
    sectionId: unknown,
    providerId: unknown,
    version: unknown,
  ): Promise<{ outcome: Exclude<StartSectionResult["outcome"], "started" | "busy"> } | { outcome: "ready"; run: (signal: AbortSignal) => AsyncIterable<Exclude<GenerationUpdateEvent, { type: "finished" }>> }> {
    const id = parse(SectionIdSchema, sectionId, "not a section.");
    if (providerId !== "anthropic" && providerId !== "openai") refuse("unknown provider.");
    const number = parse(VersionSchema, version, "not a version.");
    const credential = await this.options.credential(providerId);
    if (!credential) return { outcome: "not-connected" };
    const read = await this.options.cases.changeCase(caseId, () => ({ save: null, value: null }));
    if (read.kind !== "unchanged" && read.kind !== "saved") return { outcome: "case-unavailable" };
    if (versionText(read.data, id, number) === null) return { outcome: "version-not-found" };
    const model = (await this.options.chosenModel(providerId)) ?? defaultModel(providerId);
    const data = read.data;
    const folder = read.folder;
    const check = (signal: AbortSignal) => this.checkAgain({ caseId: caseId as string, id, providerId, credential, model, folder, signal }, data, number);
    return { outcome: "ready", run: check };
  }

  private async *checkAgain(
    args: { caseId: string; id: ReportSectionId; providerId: DraftingProvider; credential: ProviderCredential; model: string; folder: string; signal: AbortSignal },
    data: CaseData,
    number: number,
  ): AsyncGenerator<Exclude<GenerationUpdateEvent, { type: "finished" }>> {
    yield { type: "status", phase: "thinking" };
    const instructions = await this.options.instructions.get(args.id);
    const result = await this.checkConsistency(args, data, number, instructions);
    if (!args.signal.aborted) yield { type: "checked", result };
  }

  private async prepare(data: CaseData, folder: string, id: ReportSectionId, request: SectionRequest, instructions: string): Promise<{ prepared: PreparedRequest; context: Array<{ id: string; version: number }> }> {
    const context = contextSections(data, id);
    const prepared = await prepareOutgoingRequest({
      section: id,
      request,
      sources: outgoingSourcesOf(data, folder),
      herSections: context.map(({ title, text }) => ({ title, text })),
      instructions,
      notes: sessionNotes(data),
      rulesDir: this.options.rulesDir,
    });
    return { prepared, context: context.map(({ id: sectionId, version }) => ({ id: sectionId, version })) };
  }

  private async *run(args: {
    caseId: string;
    id: ReportSectionId;
    providerId: DraftingProvider;
    credential: ProviderCredential;
    model: string;
    request: SectionRequestInput;
    data: CaseData;
    folder: string;
    baseText: string | null;
    signal: AbortSignal;
  }): AsyncGenerator<Exclude<GenerationUpdateEvent, { type: "finished" }>> {
    const { id, request, baseText, signal } = args;
    const instructions = await this.options.instructions.get(id);
    const promptRequest: SectionRequest =
      request.kind === "draft"
        ? { kind: "draft" }
        : request.kind === "improve"
          ? { kind: "improve", currentText: baseText ?? "" }
          : request.kind === "change"
            ? { kind: "change", currentText: baseText ?? "", request: request.request }
            : { kind: "paragraph", currentText: baseText ?? "", paragraphIndex: request.paragraphIndex, request: request.request };
    let built: Awaited<ReturnType<SectionService["prepare"]>>;
    try {
      built = await this.prepare(args.data, args.folder, id, promptRequest, instructions);
    } catch (error) {
      this.log(`A section request could not be prepared (${(error as NodeJS.ErrnoException).code ?? "error"}).`);
      yield { type: "error", code: "prepare_failed", message: "The case's sources or the writing rules could not be read.", status: null };
      return;
    }
    const provider = this.options.provider(args.providerId);
    const record = (done: { servedModel: string; usage: TokenUsage; attempts: Parameters<typeof generationCostUsd>[2] }): GenerationRecord => ({
      provider: provider.id,
      requestedModel: args.model.slice(0, 200),
      // Clamped to what the data file reads back (review B1): a provider's answer never makes a case unreadable.
      servedModel: done.servedModel.slice(0, 200),
      effort: EFFORT,
      rulesVersions: built.prepared.rulesVersions,
      sourcesUsed: built.prepared.sourcesUsed.map(({ id: sourceId, title }) => ({ id: sourceId, title })),
      sectionsUsed: built.context,
      ...(instructions.trim() ? { instructions } : {}),
      ...(sessionNotes(args.data).trim() ? { notes: sessionNotes(args.data) } : {}),
      deidentified: built.prepared.deidentified,
      usage: {
        uncachedInputTokens: done.usage.uncachedInputTokens,
        cacheWriteTokens: done.usage.cacheWriteTokens,
        cacheReadTokens: done.usage.cacheReadTokens,
        outputTokens: done.usage.outputTokens,
      },
      // A ChatGPT sign-in spends her plan, not money.
      costUsd: args.credential.kind === "chatgpt" ? null : generationCostUsd(done.servedModel, done.usage, done.attempts),
    });
    let savedVersion: number | null = null;
    let savedData: CaseData | null = null;
    const events = runSectionGeneration<SectionSaveResult>({
      prepared: built.prepared,
      provider,
      credential: args.credential,
      model: args.model,
      effort: EFFORT,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      section: id,
      signal,
      save: async ({ text, done }) => {
        // Stop pressed by now: nothing is written (review round 4, R4-1).
        if (signal.aborted) return null;
        if (request.kind === "paragraph" && !isParagraphAnswer(baseText ?? "", request.paragraphIndex, text)) return { outcome: "not-one-paragraph" };
        const finalText = request.kind === "paragraph" ? replaceParagraph(baseText ?? "", request.paragraphIndex, text) : tidySectionText(text);
        if (finalText === null) return { outcome: "not-saved" };
        if (finalText.length > MAX_SECTION_TEXT_LENGTH) return { outcome: "too-long" };
        let stopped = false;
        const result = await this.options.cases.changeCase(args.caseId, (data, _folder, now) => {
          // The last moment before the write, in the case's save queue: a Stop here still writes nothing.
          if (signal.aborted) {
            stopped = true;
            return { save: null, value: null };
          }
          const added = addAiVersion(data, id, {
            kind: request.kind as Exclude<VersionKind, "hers" | "edited">,
            text: finalText,
            basedOn: request.kind === "draft" ? null : request.fromVersion,
            request: request.kind === "change" || request.kind === "paragraph" ? request.request : null,
            paragraphIndex: request.kind === "paragraph" ? request.paragraphIndex : null,
            generation: record(done),
            now,
          });
          savedVersion = added.version;
          return { save: added.data, value: null };
        });
        if (stopped) return null;
        if (result.kind === "unavailable") return { outcome: "case-unavailable" };
        if (result.kind === "failed") return { outcome: result.outcome };
        savedData = result.data;
        return { outcome: "saved", section: await this.detail(result.data, id), sections: sectionSummaries(result.data) };
      },
    });
    for await (const event of events) {
      if (event.type === "error" && event.code === "invalid_key" && args.providerId === "anthropic") await this.options.claudeKeyRefused?.();
      yield event;
    }
    if (signal.aborted || savedVersion === null || savedData === null) return;
    yield { type: "checked", result: await this.checkConsistency(args, savedData, savedVersion, instructions) };
  }

  /**
   * Owner's decision, 2026-11-22: after each new AI version, the AI checks it against her
   * sections (hers or approved) and the result is saved with the version. With none of
   * her sections yet, nothing is sent. A failed check leaves the version as it is.
   */
  private async checkConsistency(
    args: { caseId: string; id: ReportSectionId; providerId: DraftingProvider; credential: ProviderCredential; model: string; folder: string; signal: AbortSignal },
    data: CaseData,
    version: number,
    instructions: string,
  ): Promise<SectionSaveResult> {
    const { id } = args;
    const text = versionText(data, id, version) ?? "";
    const now = () => new Date().toISOString();
    const compared = contextSections(data, id);
    let consistency: NonNullable<Parameters<typeof setConsistency>[3]>;
    if (compared.length === 0) {
      consistency = { status: "nothing-to-compare", items: [], checkedAt: now(), model: null, costUsd: null, sectionsCompared: [] };
    } else {
      consistency = { status: "failed", items: [], checkedAt: now(), model: args.model, costUsd: null, sectionsCompared: compared.map(({ id: sectionId, version: v }) => ({ id: sectionId, version: v })) };
      try {
        const { prepared } = await this.prepare(data, args.folder, id, { kind: "consistency", currentText: text }, instructions);
        let answer: string | null = null;
        const events = runSectionGeneration<null>({
          prepared,
          provider: this.options.provider(args.providerId),
          credential: args.credential,
          model: args.model,
          effort: EFFORT,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          section: id,
          signal: args.signal,
          save: async ({ text: checked, done }) => {
            answer = checked;
            consistency.model = done.servedModel.slice(0, 200);
            consistency.costUsd = args.credential.kind === "chatgpt" ? null : generationCostUsd(done.servedModel, done.usage, done.attempts);
            return null;
          },
        });
        for await (const event of events) void event;
        const items = answer === null ? null : parseConsistencyAnswer(answer);
        if (items !== null) consistency = { ...consistency, status: items.length === 0 ? "none" : "found", items, checkedAt: now() };
      } catch (error) {
        this.log(`The consistency check could not run (${(error as NodeJS.ErrnoException).code ?? "error"}).`);
      }
    }
    if (args.signal.aborted) return { outcome: "not-saved" };
    const saved = await this.change(args.caseId, id, (current) => setConsistency(current, id, version, consistency) ?? "version-not-found");
    return saved;
  }

  private log(message: string): void {
    (this.options.log ?? ((line: string) => console.warn(line)))(message);
  }
}
