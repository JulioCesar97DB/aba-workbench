import { z } from "zod";
import type { GetCaseMapResult, MapSaveResult } from "../shared/api.ts";
import { isMapPartId, type MapCollection, type MapPartId } from "../shared/case-map.ts";
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
const ItemIdSchema = z.string().regex(/^(client|[a-z]{1,8}-[1-9][0-9]{0,5})$/);
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

export class CaseMapService {
  private readonly cases: Pick<CaseLibrary, "changeCase">;

  constructor(options: { cases: Pick<CaseLibrary, "changeCase"> }) {
    this.cases = options.cases;
  }

  async get(caseId: unknown): Promise<GetCaseMapResult> {
    const result = await this.cases.changeCase(caseId, () => ({ save: null, value: null }));
    if (result.kind === "saved" || result.kind === "unchanged") return { outcome: "read", map: caseMapView(result.data) };
    return { outcome: "case-unavailable" };
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
