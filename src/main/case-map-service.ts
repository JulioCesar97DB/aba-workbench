import { z } from "zod";
import type { Provider, ProviderCredential } from "../lib/providers/types.ts";
import type { DraftingProvider, GenerationUpdateEvent, GetCaseMapResult, MapSaveResult, StartSectionResult } from "../shared/api.ts";
import { defaultModel } from "../shared/models.ts";
import { runMapDraft } from "./case-map-draft.ts";
import { runDefinitionReview } from "./definition-review.ts";
import type { InstructionsStore } from "./instructions.ts";
import { isMapPartId, MAP_ITEM_ID, type MapCollection, type MapPartId } from "../shared/case-map.ts";
import type { CaseData } from "./case-file.ts";
import { addMapItem, approveMapPart, caseMapSummary, caseMapView, removeMapItem, saveMapItem, setMapPartVersion } from "./case-map.ts";
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

function partOf(value: unknown): MapPartId {
  if (!isMapPartId(value)) refuse("not a part of the case map.");
  return value;
}

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

type Change = (data: CaseData, now: string) => { data: CaseData; version: number | null; itemId?: string } | null | "version-not-found" | "item-not-found";

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

  constructor(options: { cases: Pick<CaseLibrary, "changeCase">; ai?: CaseMapAiOptions }) {
    this.cases = options.cases;
    this.ai = options.ai ?? null;
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
    type Outcome = "version-not-found" | "item-not-found" | { version: number | null; itemId: string | null };
    const result = await this.cases.changeCase<Outcome>(caseId, (data, _folder, now) => {
      const next = change(data, now);
      if (next === "version-not-found" || next === "item-not-found") return { save: null, value: next };
      if (next === null) return { save: null, value: { version: null, itemId: null } };
      return { save: next.data, value: { version: next.version, itemId: next.itemId ?? null } };
    });
    if (result.kind === "unavailable") return { outcome: "case-unavailable" };
    if (result.kind === "failed") return { outcome: result.outcome };
    if (result.value === "version-not-found" || result.value === "item-not-found") return { outcome: result.value };
    return { outcome: "saved", map: caseMapView(result.data), summary: caseMapSummary(result.data), version: result.value.version, itemId: result.value.itemId };
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
    const id = partOf(part);
    const number = parse<number>(VersionSchema, version, "not a version.");
    return this.change(caseId, (data) => {
      const next = setMapPartVersion(data, id, number);
      return next ? { data: next, version: number } : "version-not-found";
    });
  }

  async approve(caseId: unknown, part: unknown, version: unknown): Promise<MapSaveResult> {
    const id = partOf(part);
    const number = parse<number | null>(ApproveSchema, version, "not a version.");
    return this.change(caseId, (data, now) => {
      const next = approveMapPart(data, id, number, now);
      if (!next) return "version-not-found";
      return next === data ? null : { data: next, version: number };
    });
  }
}
