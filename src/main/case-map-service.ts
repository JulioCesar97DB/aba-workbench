import { z } from "zod";
import type { Provider, ProviderCredential } from "../lib/providers/types.ts";
import type { DraftingProvider, GenerationUpdateEvent, GetCaseMapResult, GetPlanResult, HbiIntroResult, MapSaveResult, PlanCopyResult, StartSectionResult } from "../shared/api.ts";
import { DECIDED_PARTS, PLAN_PARTS, fingerprint, isPlanPartId, planMapInputOf, type PlanPartId } from "../shared/plan.ts";
import { planCopy } from "../shared/plan-copy.ts";
import { defaultModel } from "../shared/models.ts";
import { runMapDraft } from "./case-map-draft.ts";
import { runDefinitionReview } from "./definition-review.ts";
import type { InstructionsStore } from "./instructions.ts";
import { isMapPartId, MAP_ITEM_ID, type MapCollection } from "../shared/case-map.ts";
import type { CaseData } from "./case-file.ts";
import { addMapItem, approveMapPart, caseMapSummary, caseMapView, decidePlanItems, markPlanCopied, planSummaryOf, planView, removeMapItem, saveMapItem, setMapPartVersion, type PartId } from "./case-map.ts";
import type { CaseLibrary } from "./cases.ts";

/*
 * The case map, as the interface reaches it (src/main/ipc.ts): reading it, her changes to
 * an item or a group as she types, adding and removing them, going back to a version of a
 * part, and approving a part. No AI here (step 1, pull request 1). Every argument from the
 * interface is checked here; the changes themselves are pure functions in case-map.ts.
 * Nothing here imports Electron, so it is unit-tested.
 */

/** What an item's text may weigh: the form she types in, as JSON. Far above any item the limits allow. */
export const MAX_MAP_ITEM_JSON = 400_000;

const CollectionSchema = z.enum(["items", "groups"]);
const ItemIdSchema = z.string().regex(MAP_ITEM_ID);
const EditingSchema = z.int().min(1).max(1_000_000).nullable();
const VersionSchema = z.int().min(1).max(1_000_000);
const ApproveSchema = VersionSchema.nullable();

function refuse(message: string): never {
  throw new Error(`Refused: ${message}`);
}

function parse<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown, what: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) refuse(what);
  return parsed.data;
}

function partOf(value: unknown): PartId {
  if (!isMapPartId(value) && !isPlanPartId(value)) refuse("not a part of the case map.");
  return value;
}

/** A map part only: the map's approval and versions shown are not the plan's (D2: the plan's items are decided one by one). */
function mapPartOf(value: unknown) {
  if (!isMapPartId(value)) refuse("not a part of the case map.");
  return value;
}

const DecisionsSchema = z
  .array(z.strictObject({ part: z.enum(DECIDED_PARTS), itemId: ItemIdSchema, decision: z.enum(["accepted", "rejected", "proposed"]) }))
  .min(1)
  .max(500);
const PlanEditingSchema = z.partialRecord(z.enum(PLAN_PARTS), EditingSchema);
const FieldIdsSchema = z.array(z.string().regex(/^[a-z][a-z0-9:-]{0,79}$/)).min(1).max(10);
const IntroSchema = z.string().min(1).max(5_000);

/** An item's fields as she typed them: a JSON object (the failed-saves path keeps it as text). */
function itemInput(text: unknown): unknown {
  if (typeof text !== "string" || text.length > MAX_MAP_ITEM_JSON) refuse("the item must be text, and not that long.");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    refuse("the item is not readable.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) refuse("the item is not readable.");
  return value;
}

type Change = (data: CaseData, now: string) => { data: CaseData; version: number | null; itemId?: string; versions?: Partial<Record<PlanPartId, number>> } | null | "version-not-found" | "item-not-found";

/** Her plan standing instructions and confirmed intro, and the store that keeps them (instructions.json). */
type PlanInstructionsStore = Pick<InstructionsStore, "plan" | "saveHbiIntro">;

/** What the AI's drafts need; without it (the tests of typing by hand), "Draft the map" is refused. */
export interface CaseMapAiOptions {
  instructions: Pick<InstructionsStore, "get">;
  rulesDir: string;
  /** The provider by id; tests pass a fake. */
  provider: (id: DraftingProvider) => Provider;
  /** The credential for a provider, or null when it is not connected. */
  credential: (id: DraftingProvider) => Promise<ProviderCredential | null>;
  /** The model chosen in Settings for a provider (null: the default). */
  chosenModel: (id: DraftingProvider) => Promise<string | null>;
  rememberProvider: (id: DraftingProvider) => Promise<unknown>;
  log?: (message: string) => void;
}

export class CaseMapService {
  private readonly cases: Pick<CaseLibrary, "changeCase">;
  private readonly ai: CaseMapAiOptions | null;
  private readonly instructions: PlanInstructionsStore | null;
  private readonly writeClipboard: (text: string) => Promise<void> | void;

  constructor(options: { cases: Pick<CaseLibrary, "changeCase">; ai?: CaseMapAiOptions; instructions?: PlanInstructionsStore; writeClipboard?: (text: string) => Promise<void> | void }) {
    this.cases = options.cases;
    this.ai = options.ai ?? null;
    this.instructions = options.instructions ?? null;
    this.writeClipboard =
      options.writeClipboard ??
      (() => {
        throw new Error("No clipboard.");
      });
  }

  private async planInstructions() {
    return (await this.instructions?.plan()) ?? { text: "", hbiIntro: null };
  }

  /** The plan (step 3), the map it is built from, and her plan instructions. */
  async getPlan(caseId: unknown): Promise<GetPlanResult> {
    const result = await this.cases.changeCase(caseId, () => ({ save: null, value: null }));
    if (result.kind !== "saved" && result.kind !== "unchanged") return { outcome: "case-unavailable" };
    return { outcome: "read", plan: planView(result.data), map: caseMapView(result.data), instructions: await this.planInstructions() };
  }

  /** Her decisions on plan items (D2, D4): accept, reject, recover; "Aceptar lo que queda" with `onlyUndecided`. */
  async decide(caseId: unknown, changes: unknown, editing: unknown, onlyUndecided: unknown): Promise<MapSaveResult> {
    const list = parse(DecisionsSchema, changes, "not decisions on plan items.");
    const passes = parse(PlanEditingSchema, editing, "not versions.");
    if (typeof onlyUndecided !== "boolean") refuse("not a choice.");
    return this.change(caseId, (data, now) => {
      const next = decidePlanItems(data, list, passes, now, onlyUndecided);
      if (next === "item-not-found" || next === null) return next;
      return { data: next.data, version: null, versions: next.versions };
    });
  }

  /**
   * Copies plan fields for ABA Matrix (D22, D23): rendered by code from what is saved, put on
   * the clipboard as plain text, then marked copied with a fingerprint of the text. Several
   * fields that make up a block go as the whole block's text.
   */
  async copyPlanFields(caseId: unknown, fieldIds: unknown): Promise<PlanCopyResult> {
    const ids = parse(FieldIdsSchema, fieldIds, "not fields of the plan.");
    const read = await this.cases.changeCase(caseId, () => ({ save: null, value: null }));
    if (read.kind !== "saved" && read.kind !== "unchanged") return { outcome: "case-unavailable" };
    const instructions = await this.planInstructions();
    const groups = planCopy({ plan: planView(read.data), map: planMapInputOf(caseMapView(read.data)), hbiIntro: instructions.hbiIntro?.text ?? null });
    const fields = ids.map((id) => groups.flatMap((group) => group.fields).find((field) => field.id === id));
    if (fields.some((field) => field === undefined)) return { outcome: "field-not-found" };
    const chosen = fields as NonNullable<(typeof fields)[number]>[];
    const block = groups.find((group) => group.whole !== null && group.fields.length === chosen.length && group.fields.every((field) => ids.includes(field.id)));
    const text = chosen.length === 1 ? chosen[0].text : (block?.whole ?? chosen.map((field) => field.text).join("\n\n"));
    await this.writeClipboard(text);
    // Marked only once the clipboard holds it (as T8): a mark never says more than happened.
    const marked = await this.change(caseId, (data, now) => ({ data: markPlanCopied(data, chosen.map((field) => ({ id: field.id, fingerprint: fingerprint(field.text) })), now), version: null }));
    return { outcome: "copied", markers: chosen.reduce((sum, field) => sum + field.markers, 0), result: marked.outcome === "saved" ? marked : null };
  }

  /** Confirms the HBI intro once, for all her cases (D16). */
  async confirmHbiIntro(text: unknown): Promise<HbiIntroResult> {
    const intro = parse(IntroSchema, typeof text === "string" ? text.trim() : text, "the intro must be text, and not that long.");
    if (!this.instructions) refuse("the instructions are not set up.");
    const saved = await this.instructions.saveHbiIntro(intro);
    return saved ? { outcome: "saved", instructions: await this.planInstructions() } : { outcome: "not-saved" };
  }

  async get(caseId: unknown): Promise<GetCaseMapResult> {
    const result = await this.cases.changeCase(caseId, () => ({ save: null, value: null }));
    if (result.kind === "saved" || result.kind === "unchanged") return { outcome: "read", map: caseMapView(result.data), instructions: (await this.ai?.instructions.get("case-map")) ?? "" };
    return { outcome: "case-unavailable" };
  }

  /**
   * "Draft the map" / "Update the map": the AI's two requests (src/main/case-map-draft.ts),
   * run like any generation. Her map's standing instructions (her thresholds) go with the
   * behaviors request once she has confirmed them.
   */
  async prepareDraft(
    caseId: unknown,
    providerId: unknown,
  ): Promise<{ outcome: Exclude<StartSectionResult["outcome"], "started" | "busy"> } | { outcome: "ready"; run: (signal: AbortSignal) => AsyncIterable<Exclude<GenerationUpdateEvent, { type: "finished" }>> }> {
    const ai = this.ai;
    if (!ai) refuse("the AI is not set up.");
    if (providerId !== "anthropic" && providerId !== "openai") refuse("unknown provider.");
    const credential = await ai.credential(providerId);
    if (!credential) return { outcome: "not-connected" };
    const read = await this.cases.changeCase(caseId, () => ({ save: null, value: null }));
    if (read.kind !== "saved" && read.kind !== "unchanged") return { outcome: "case-unavailable" };
    const model = (await ai.chosenModel(providerId)) ?? defaultModel(providerId);
    const instructions = await ai.instructions.get("case-map");
    await ai.rememberProvider(providerId).catch(() => undefined);
    const provider = ai.provider(providerId);
    const log = ai.log ?? ((message: string) => console.warn(message));
    return {
      outcome: "ready",
      run: (signal) => runMapDraft({ cases: this.cases, caseId: caseId as string, rulesDir: ai.rulesDir, providerId, provider, credential, model, instructions, signal, log }),
    };
  }

  /**
   * "Review the definitions again" (T3; owner's decision 2A): the review of the behaviors'
   * definitions on its own, one request, run like any generation.
   */
  async prepareReview(
    caseId: unknown,
    providerId: unknown,
  ): Promise<{ outcome: Exclude<StartSectionResult["outcome"], "started" | "busy"> } | { outcome: "ready"; run: (signal: AbortSignal) => AsyncIterable<Exclude<GenerationUpdateEvent, { type: "finished" }>> }> {
    const ai = this.ai;
    if (!ai) refuse("the AI is not set up.");
    if (providerId !== "anthropic" && providerId !== "openai") refuse("unknown provider.");
    const credential = await ai.credential(providerId);
    if (!credential) return { outcome: "not-connected" };
    const read = await this.cases.changeCase(caseId, () => ({ save: null, value: null }));
    if (read.kind !== "saved" && read.kind !== "unchanged") return { outcome: "case-unavailable" };
    const model = (await ai.chosenModel(providerId)) ?? defaultModel(providerId);
    const provider = ai.provider(providerId);
    const log = ai.log ?? ((message: string) => console.warn(message));
    return {
      outcome: "ready",
      run: (signal) => runDefinitionReview({ cases: this.cases, caseId: caseId as string, rulesDir: ai.rulesDir, providerId, provider, credential, model, signal, log }),
    };
  }

  /** Runs a change to the map and answers with the whole map as saved. */
  private async change(caseId: unknown, change: Change): Promise<MapSaveResult> {
    type Outcome = "version-not-found" | "item-not-found" | { version: number | null; itemId: string | null; versions?: Partial<Record<PlanPartId, number>> };
    const result = await this.cases.changeCase<Outcome>(caseId, (data, _folder, now) => {
      const next = change(data, now);
      if (next === "version-not-found" || next === "item-not-found") return { save: null, value: next };
      if (next === null) return { save: null, value: { version: null, itemId: null } };
      return { save: next.data, value: { version: next.version, itemId: next.itemId ?? null, ...(next.versions ? { versions: next.versions } : {}) } };
    });
    if (result.kind === "unavailable") return { outcome: "case-unavailable" };
    if (result.kind === "failed") return { outcome: result.outcome };
    if (result.value === "version-not-found" || result.value === "item-not-found") return { outcome: result.value };
    return {
      outcome: "saved",
      map: caseMapView(result.data),
      summary: caseMapSummary(result.data),
      version: result.value.version,
      itemId: result.value.itemId,
      plan: planView(result.data),
      planSummary: planSummaryOf(result.data),
      ...(result.value.versions ? { versions: result.value.versions } : {}),
    };
  }

  /** Her change to an item or a group, as she types (through the failed saves: what she typed is kept if it cannot be saved). */
  async saveItem(caseId: unknown, part: unknown, collection: unknown, itemId: unknown, text: unknown, editing: unknown): Promise<MapSaveResult> {
    const id = partOf(part);
    const list = parse<MapCollection>(CollectionSchema, collection, "not a list of the part.");
    const item = parse<string>(ItemIdSchema, itemId, "not an item.");
    const input = itemInput(text);
    const pass = parse<number | null>(EditingSchema, editing, "not a version.");
    return this.change(caseId, (data, now) => saveMapItem(data, id, list, item, input, pass, now));
  }

  async addItem(caseId: unknown, part: unknown, collection: unknown, text: unknown, editing: unknown): Promise<MapSaveResult> {
    const id = partOf(part);
    const list = parse<MapCollection>(CollectionSchema, collection, "not a list of the part.");
    const input = itemInput(text);
    const pass = parse<number | null>(EditingSchema, editing, "not a version.");
    return this.change(caseId, (data, now) => addMapItem(data, id, list, input, pass, now));
  }

  async removeItem(caseId: unknown, part: unknown, collection: unknown, itemId: unknown, editing: unknown): Promise<MapSaveResult> {
    const id = partOf(part);
    const list = parse<MapCollection>(CollectionSchema, collection, "not a list of the part.");
    const item = parse<string>(ItemIdSchema, itemId, "not an item.");
    const pass = parse<number | null>(EditingSchema, editing, "not a version.");
    return this.change(caseId, (data, now) => removeMapItem(data, id, list, item, pass, now));
  }

  async setCurrent(caseId: unknown, part: unknown, version: unknown): Promise<MapSaveResult> {
    const id = mapPartOf(part);
    const number = parse<number>(VersionSchema, version, "not a version.");
    return this.change(caseId, (data) => {
      const next = setMapPartVersion(data, id, number);
      return next ? { data: next, version: number } : "version-not-found";
    });
  }

  async approve(caseId: unknown, part: unknown, version: unknown): Promise<MapSaveResult> {
    const id = mapPartOf(part);
    const number = parse<number | null>(ApproveSchema, version, "not a version.");
    return this.change(caseId, (data, now) => {
      const next = approveMapPart(data, id, number, now);
      if (!next) return "version-not-found";
      return next === data ? null : { data: next, version: number };
    });
  }
}
