import { z } from "zod";
import {
  GROUP_ID_PREFIX,
  MAP_ID_PREFIX,
  MAP_ITEM_ID,
  MAP_PART_LIMITS,
  MAP_PARTS,
  MAP_TEXT_LIMITS,
  MAX_MAP_GROUPS,
  MAX_MAP_LIST,
  MAX_MAP_REFS,
  MAX_MAP_VERSIONS,
  mapPartStatus,
  type CaseMapSummary,
  type CaseMapView,
  type MapCollection,
  type MapItemView,
  type MapPartId,
  type MapPartVersionInfo,
  type MapPartView,
  type MapVersionKind,
} from "../shared/case-map.ts";

/*
 * The case map inside a case's data file (schema version 4; src/shared/case-map.ts says
 * what it is). Pure functions on the stored data: nothing here touches the disk, so it is
 * unit-tested (tests/case-map.test.ts).
 *
 * The same rules as the rest of the file keep her data safe:
 * - every object is read loosely: a key this version does not know is kept as it is;
 * - a kind, origin, status or tag this version does not know is kept as written;
 * - nothing is ever deleted: each part keeps every version (D1), an AI version never
 *   changes, and her editing pass is the one version that changes while she types, as in
 *   a section. Removing an item makes a version without it; the earlier ones keep it.
 */

const TimestampSchema = z.iso.datetime();
const VersionNumberSchema = z.int().min(1).max(1_000_000);
/** A kind, origin, status, tag or function as written: a newer app's value is kept. */
const WordSchema = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
const ItemIdSchema = z.string().regex(MAP_ITEM_ID);
const SectionNumberSchema = z.int().min(1).max(22);

const RefSchema = z.looseObject({
  kind: WordSchema,
  sourceId: z.string().max(64).optional(),
  sectionId: z.string().max(64).optional(),
  version: VersionNumberSchema.optional(),
  session: z.string().max(40).optional(),
  quote: z.string().max(MAP_TEXT_LIMITS.quote).optional(),
  /** How the app checked the quote (D4): "found", "not-found", or "not-checked" for a PDF (D32). */
  checked: WordSchema.optional(),
});

/**
 * A claim as stored. Its refs: up to MAX_MAP_REFS where it came from, plus her own ref
 * when she changed it (the earlier refs are kept after hers, never cut: review round 1, minor 4).
 */
function claimOf<T extends z.ZodType>(value: T) {
  return z.looseObject({
    value,
    // At most MAX_MAP_REFS refs where it came from, and at most one of hers (review round 2, R2-3):
    // her edit of any claim that reads back then fits too, so it is never refused.
    refs: z
      .array(RefSchema)
      .max(MAX_MAP_REFS + 1)
      .refine((refs) => refs.filter((ref) => ref.kind !== "her").length <= MAX_MAP_REFS && refs.filter((ref) => ref.kind === "her").length <= 1),
    origin: WordSchema,
    check: z.string().max(MAP_TEXT_LIMITS.text).nullable(),
  });
}

const text = (max: number) => claimOf(z.string().max(max)).nullable().optional();
const list = (max: number = MAP_TEXT_LIMITS.text) => z.array(claimOf(z.string().max(max))).max(MAX_MAP_LIST).optional();
const T = MAP_TEXT_LIMITS;

/** When she last changed an item by hand (D2: what she touched inside a part). */
const edited = { editedAt: TimestampSchema.optional() };

const ClientSchema = z.looseObject({
  id: z.literal("client"),
  age: text(T.name),
  diagnosis: text(T.text),
  severityLevel: text(T.name),
  evaluator: text(T.name),
  evaluationDate: text(T.short),
  medications: list(),
  school: text(T.name),
  grade: text(T.short),
  schedule: text(T.text),
  iep: text(T.text),
  otherServices: z.array(z.looseObject({ name: text(T.name), provider: text(T.name), paid: text(T.short) })).max(MAX_MAP_LIST).optional(),
  languages: list(T.name),
  ...edited,
});

const CaregiverSchema = z.looseObject({
  id: ItemIdSchema,
  role: text(T.name),
  language: text(T.name),
  availability: text(T.text),
  participation: text(T.text),
  limits: text(T.text),
  mitigation: text(T.text),
  ...edited,
});

const SettingSchema = z.looseObject({ id: ItemIdSchema, name: text(T.name), kind: text(T.short), evidence: text(T.short), by: text(T.name), dates: text(T.text), ...edited });

const DeficitSchema = z.looseObject({
  id: ItemIdSchema,
  area: text(T.name),
  scores: z
    .array(z.looseObject({ instrument: text(T.name), scale: text(T.name), score: text(T.short), percentile: text(T.short), level: text(T.name) }))
    .max(MAX_MAP_LIST)
    .optional(),
  evidence: list(),
  impact: text(T.text),
  ...edited,
});

const StrengthSchema = z.looseObject({ id: ItemIdSchema, text: text(T.text), kind: text(T.short), setting: text(T.name), ...edited });

const IdListSchema = z.array(ItemIdSchema).max(MAX_MAP_LIST);

const BehaviorSchema = z.looseObject({
  id: ItemIdSchema,
  name: text(T.name),
  topographies: list(),
  measure: text(T.short),
  definition: text(T.definition),
  onset: text(T.text),
  offset: text(T.text),
  examples: list(),
  nonExamples: list(),
  baseline: z
    .looseObject({
      observations: z.array(z.looseObject({ date: text(T.short), setting: text(T.name), length: text(T.short), minutes: text(T.short), value: text(T.short) })).max(MAX_MAP_LIST).optional(),
      other: list(),
    })
    .optional(),
  intensity: text(T.short),
  settingIds: IdListSchema.optional(),
  antecedents: list(),
  consequences: list(),
  function: z
    .looseObject({
      primary: z.array(WordSchema).max(5).optional(),
      secondary: z.array(WordSchema).max(5).optional(),
      origin: WordSchema.optional(),
      evidence: z
        .array(z.looseObject({ tool: WordSchema, respondent: z.string().max(T.name).nullable().optional(), result: text(T.text), supports: z.array(WordSchema).max(5).optional() }))
        .max(MAX_MAP_LIST)
        .optional(),
      reasoning: z.string().max(T.text).nullable().optional(),
      check: z.string().max(T.text).nullable().optional(),
    })
    .optional(),
  barriers: claimOf(z.array(WordSchema).max(20)).nullable().optional(),
  risks: list(),
  ...edited,
});

const GroupSchema = z.looseObject({
  id: ItemIdSchema,
  behaviorIds: IdListSchema,
  nature: z.string().max(T.name),
  function: WordSchema.nullable(),
  measure: WordSchema.nullable(),
  reason: z.string().max(T.text),
  origin: WordSchema,
  ...edited,
});

const RiskSchema = z.looseObject({ id: ItemIdSchema, behaviorIds: IdListSchema.optional(), what: text(T.text), evidence: list(), level: text(T.name), ...edited });
const FactSchema = z.looseObject({ id: ItemIdSchema, text: text(T.text), homeSection: SectionNumberSchema.nullable().optional(), ...edited });
const OpenItemSchema = z.looseObject({
  id: ItemIdSchema,
  kind: WordSchema,
  text: z.string().max(T.text),
  itemRef: z.looseObject({ part: z.string().max(32), itemId: ItemIdSchema }).nullable().optional(),
  homeSection: SectionNumberSchema.nullable().optional(),
  status: WordSchema,
  ...edited,
});
const ReportItemSchema = z.looseObject({
  id: ItemIdSchema,
  kind: WordSchema,
  text: z.string().max(T.text),
  sections: z.array(z.string().max(64)).max(22).optional(),
  refs: z.array(RefSchema).max(MAX_MAP_REFS).optional(),
  status: WordSchema,
  ...edited,
});

const ITEM_SCHEMAS: Record<MapPartId, z.ZodType> = {
  client: ClientSchema,
  caregivers: CaregiverSchema,
  settings: SettingSchema,
  deficits: DeficitSchema,
  strengths: StrengthSchema,
  behaviors: BehaviorSchema,
  risks: RiskSchema,
  facts: FactSchema,
  openItems: OpenItemSchema,
  report: ReportItemSchema,
};

const uniqueIds = (items: ReadonlyArray<{ id: string }>) => new Set(items.map((item) => item.id)).size === items.length;

/** A version's content as any part keeps it; each known part's items are checked with that part's schema (CaseMapSchema). */
const ContentSchema = z.looseObject({
  items: z.array(z.looseObject({ id: ItemIdSchema })).refine(uniqueIds),
  groups: z.array(z.looseObject({ id: ItemIdSchema })).refine(uniqueIds).optional(),
});

/** The schema of one known part's content: its items and limits (D6). */
export function contentSchemaFor(part: MapPartId) {
  return z.looseObject({
    items: z.array(ITEM_SCHEMAS[part]).max(MAP_PART_LIMITS[part]),
    ...(part === "behaviors" ? { groups: z.array(GroupSchema).max(MAX_MAP_GROUPS).optional() } : {}),
  });
}

/** Each known part's content schema, built once (a read checks every version of every part). */
const CONTENT_SCHEMAS = Object.fromEntries(MAP_PARTS.map((part) => [part, contentSchemaFor(part)])) as Record<MapPartId, ReturnType<typeof contentSchemaFor>>;

const PartVersionSchema = z.looseObject({
  number: VersionNumberSchema,
  /** "ai", "edited", "update"; a kind a newer app writes is kept as it is. */
  kind: WordSchema,
  createdAt: TimestampSchema,
  /** Her editing pass changes while she types. */
  updatedAt: TimestampSchema.optional(),
  basedOn: VersionNumberSchema.optional(),
  /** The AI request that made it (caseMap.extractions). */
  extraction: z.string().max(64).optional(),
  /** She approved it at some time: it is never changed in place again, so what she approved stays recorded (review round 2, R2-1). */
  approvedOnce: z.literal(true).optional(),
  content: ContentSchema,
});

const PartSchema = z.looseObject({
  currentVersion: VersionNumberSchema.nullable(),
  approvedVersion: VersionNumberSchema.nullable(),
  approvedAt: TimestampSchema.optional(),
  outOfDate: z.looseObject({ since: TimestampSchema, reasons: z.array(z.string().max(500)).max(50) }).optional(),
  versions: z
    .array(PartVersionSchema)
    .max(MAX_MAP_VERSIONS)
    .refine((versions) => new Set(versions.map((version) => version.number)).size === versions.length),
});

/** The case map as aba-case.json keeps it. A part id this version does not know (a newer app's) is kept as it is. */
export const CaseMapSchema = z
  .looseObject({
    parts: z.record(z.string().regex(/^[a-z][a-zA-Z0-9]{0,31}$/), PartSchema),
    /** The AI requests that made versions (from the extraction pull request on), each as a generation record. */
    extractions: z.array(z.looseObject({ id: z.string().max(64), kind: WordSchema })).max(MAX_MAP_VERSIONS).optional(),
  })
  .superRefine((map, ctx) => {
    for (const part of MAP_PARTS) {
      for (const version of map.parts[part]?.versions ?? []) {
        if (!CONTENT_SCHEMAS[part].safeParse(version.content).success) ctx.addIssue({ code: "custom", message: `part ${part}, version ${version.number}` });
      }
    }
  });

export type StoredCaseMap = z.infer<typeof CaseMapSchema>;
export type StoredMapPart = z.infer<typeof PartSchema>;
export type StoredMapVersion = z.infer<typeof PartVersionSchema>;
type Content = StoredMapVersion["content"];
type StoredItem = Content["items"][number];

/* Reading */

/** Anything with a case map: the case's data (CaseData), kept generic so this file does not import case-file.ts. */
export interface WithCaseMap {
  caseMap?: StoredCaseMap;
  updatedAt: string;
}

function emptyPart(): StoredMapPart {
  return { currentVersion: null, approvedVersion: null, versions: [] };
}

export function storedPart(data: WithCaseMap, part: MapPartId): StoredMapPart {
  return data.caseMap?.parts[part] ?? emptyPart();
}

function findVersion(part: StoredMapPart, number: number | null): StoredMapVersion | undefined {
  return number === null ? undefined : part.versions.find((version) => version.number === number);
}

/** The version shown: the current one, or the newest when the pointer names none. */
export function currentPartVersion(part: StoredMapPart): StoredMapVersion | undefined {
  return findVersion(part, part.currentVersion) ?? part.versions.at(-1);
}

function versionKind(kind: string): MapVersionKind {
  return kind === "ai" || kind === "update" ? kind : "edited";
}

/* Defaults: what an item's missing fields read as. A stored item is never filled in on disk; the view does it. */

function blankItem(part: MapPartId, id: string): Record<string, unknown> {
  switch (part) {
    case "client":
      return { id, age: null, diagnosis: null, severityLevel: null, evaluator: null, evaluationDate: null, medications: [], school: null, grade: null, schedule: null, iep: null, otherServices: [], languages: [] };
    case "caregivers":
      return { id, role: null, language: null, availability: null, participation: null, limits: null, mitigation: null };
    case "settings":
      return { id, name: null, kind: null, evidence: null, by: null, dates: null };
    case "deficits":
      return { id, area: null, scores: [], evidence: [], impact: null };
    case "strengths":
      return { id, text: null, kind: null, setting: null };
    case "behaviors":
      return {
        id,
        name: null,
        topographies: [],
        measure: null,
        definition: null,
        onset: null,
        offset: null,
        examples: [],
        nonExamples: [],
        baseline: { observations: [], other: [] },
        intensity: null,
        settingIds: [],
        antecedents: [],
        consequences: [],
        function: { primary: [], secondary: [], origin: "hypothesis", evidence: [], reasoning: null, check: null },
        barriers: null,
        risks: [],
      };
    case "risks":
      return { id, behaviorIds: [], what: null, evidence: [], level: null };
    case "facts":
      return { id, text: null, homeSection: null };
    case "openItems":
      return { id, kind: "check", text: "", itemRef: null, homeSection: null, status: "open" };
    case "report":
      return { id, kind: "thread-gap", text: "", sections: [], refs: [], status: "open" };
  }
}

function blankGroup(id: string): Record<string, unknown> {
  return { id, behaviorIds: [], nature: "", function: null, measure: null, reason: "", origin: "her" };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Missing fields filled in from the blank item, deeply, so the interface always gets every field. */
function withDefaults(blank: unknown, stored: unknown): unknown {
  if (isPlainObject(blank) && isPlainObject(stored)) {
    const out: Record<string, unknown> = { ...stored };
    for (const [key, value] of Object.entries(blank)) out[key] = key in stored && stored[key] !== undefined ? withDefaults(value, stored[key]) : value;
    return out;
  }
  return stored === undefined ? blank : stored;
}

function itemView(part: MapPartId, item: StoredItem): MapItemView {
  const filled = withDefaults(blankItem(part, item.id), item) as Record<string, unknown>;
  return { ...filled, editedAt: typeof item.editedAt === "string" ? item.editedAt : null } as unknown as MapItemView;
}

function groupView(group: StoredItem) {
  const filled = withDefaults(blankGroup(group.id), group) as Record<string, unknown>;
  return { ...filled, editedAt: typeof group.editedAt === "string" ? group.editedAt : null } as MapPartView["groups"][number];
}

export function mapPartView(data: WithCaseMap, part: MapPartId): MapPartView {
  const stored = storedPart(data, part);
  const current = currentPartVersion(stored);
  const versions: MapPartVersionInfo[] = stored.versions.map((version) => ({
    number: version.number,
    kind: versionKind(version.kind),
    createdAt: version.createdAt,
    updatedAt: version.updatedAt ?? null,
    basedOn: version.basedOn ?? null,
    itemCount: version.content.items.length,
    groupCount: version.content.groups?.length ?? 0,
  }));
  return {
    id: part,
    status: mapPartStatus(stored.versions, current?.number ?? null, findVersion(stored, stored.approvedVersion)?.number ?? null),
    currentVersion: current?.number ?? null,
    approvedVersion: findVersion(stored, stored.approvedVersion)?.number ?? null,
    approvedAt: stored.approvedAt ?? null,
    outOfDate: stored.outOfDate ? { since: stored.outOfDate.since, reasons: [...stored.outOfDate.reasons] } : null,
    versions,
    items: (current?.content.items ?? []).map((item) => itemView(part, item)),
    groups: part === "behaviors" ? (current?.content.groups ?? []).map(groupView) : [],
  };
}

export function caseMapView(data: WithCaseMap): CaseMapView {
  return { parts: Object.fromEntries(MAP_PARTS.map((part) => [part, mapPartView(data, part)])) as Record<MapPartId, MapPartView>, revision: data.updatedAt };
}

export function caseMapSummary(data: WithCaseMap): CaseMapSummary {
  let approved = 0;
  let withContent = 0;
  for (const part of MAP_PARTS) {
    const view = mapPartView(data, part);
    if (view.status === "approved") approved++;
    if (view.items.length > 0 || view.groups.length > 0) withContent++;
  }
  return { approved, withContent };
}

/* Changes */

/** Why a change cannot be made, before anything is saved (refused as "Refused: ..."). */
export class MapInputError extends Error {}

function refuse(message: string): never {
  throw new MapInputError(`Refused: ${message}`);
}

function withPart<D extends WithCaseMap>(data: D, part: MapPartId, stored: StoredMapPart): D {
  const map: StoredCaseMap = data.caseMap ?? { parts: {} };
  return { ...data, caseMap: { ...map, parts: { ...map.parts, [part]: stored } } };
}

function nextNumber(part: StoredMapPart): number {
  return part.versions.reduce((max, version) => Math.max(max, version.number), 0) + 1;
}

function withoutApproval(part: StoredMapPart): StoredMapPart {
  const { approvedAt: _was, ...rest } = part;
  void _was;
  return { ...rest, approvedVersion: null };
}

/**
 * Writes the content of a part as she changed it (D1): into her editing pass while it is
 * still the newest version, hers, not approved, and the one shown; otherwise into a new
 * "edited" version based on the one shown. A version she ever approved is never changed in
 * place, even after she took the approval back. A new version takes the approval away (she
 * approves again), as for a section.
 */
function writeContent<D extends WithCaseMap>(data: D, part: MapPartId, content: Content, editing: number | null, now: string): { data: D; version: number } {
  const stored = storedPart(data, part);
  const newest = stored.versions.at(-1);
  const checked = CONTENT_SCHEMAS[part].safeParse(content);
  if (!checked.success) refuse("the change does not fit the case map's limits.");
  if (
    editing !== null &&
    newest &&
    newest.number === editing &&
    newest.kind === "edited" &&
    stored.approvedVersion !== newest.number &&
    newest.approvedOnce !== true &&
    currentPartVersion(stored)?.number === newest.number
  ) {
    const versions = [...stored.versions.slice(0, -1), { ...newest, content, updatedAt: now }];
    return { data: withPart(data, part, { ...stored, versions }), version: newest.number };
  }
  if (stored.versions.length >= MAX_MAP_VERSIONS) refuse("this part has too many versions.");
  const current = currentPartVersion(stored);
  const number = nextNumber(stored);
  const version: StoredMapVersion = { number, kind: "edited", createdAt: now, updatedAt: now, ...(current ? { basedOn: current.number } : {}), content };
  return { data: withPart(data, part, withoutApproval({ ...stored, versions: [...stored.versions, version], currentVersion: number })), version: number };
}

function currentContent(stored: StoredMapPart): Content {
  const current = currentPartVersion(stored);
  return current ? { ...current.content, items: [...current.content.items], ...(current.content.groups ? { groups: [...current.content.groups] } : {}) } : { items: [] };
}

/** A new id for an item of a part (or a group): one more than any id with that prefix in any version, so an id is never reused. */
function newId(stored: StoredMapPart, part: MapPartId, collection: MapCollection): string {
  if (part === "client") return "client";
  const prefix = collection === "groups" ? GROUP_ID_PREFIX : MAP_ID_PREFIX[part];
  let max = 0;
  for (const version of stored.versions) {
    for (const item of [...version.content.items, ...(version.content.groups ?? [])]) {
      const match = new RegExp(`^${prefix}-(\\d+)$`).exec(item.id);
      if (match) max = Math.max(max, Number(match[1]));
    }
  }
  return `${prefix}-${max + 1}`;
}

/* Provenance: what she changed becomes hers (D3); what she left as it was keeps where it came from. */

function isClaimInput(value: unknown): value is { value: unknown; check?: unknown } {
  return isPlainObject(value) && "value" in value && Object.keys(value).every((key) => key === "value" || key === "check");
}

function isClaim(value: unknown): value is { value: unknown; refs: unknown[]; origin: string; check: string | null } {
  return isPlainObject(value) && "value" in value && Array.isArray(value.refs) && typeof value.origin === "string";
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const HER_REF = { kind: "her" } as const;

function mergeClaim(input: { value: unknown; check?: unknown }, stored: unknown): unknown {
  const check = typeof input.check === "string" && input.check.trim() !== "" ? input.check : null;
  if (isClaim(stored) && same(stored.value, input.value)) return { ...stored, check };
  const earlier = isClaim(stored) ? stored.refs.filter((ref) => !(isPlainObject(ref) && ref.kind === "her")) : [];
  // Her ref first, every earlier one after it: a claim's refs are at most MAX_MAP_REFS plus hers, so nothing is cut.
  return { value: input.value, refs: [HER_REF, ...earlier], origin: "her", check };
}

/** Keys the interface never sends: the main process keeps them. */
const KEPT_KEYS = new Set(["origin", "refs", "editedAt"]);

/** A line she added and left empty: not stored (review round 1, minor 5). */
function isEmptyLine(claim: unknown): boolean {
  if (!isClaimInput(claim)) return false;
  const check = typeof claim.check === "string" ? claim.check.trim() : "";
  return typeof claim.value === "string" && claim.value.trim() === "" && check === "";
}

/**
 * Her input merged into the stored item. A claim whose value she kept keeps its refs and
 * origin; a changed or new one is hers. A list of claims is matched by value first, so a
 * line she did not touch keeps where it came from; when no line was added or removed, a
 * line she edited is then paired with the unmatched stored line at the same place, so its
 * earlier refs follow it after hers (review round 1, S4; round 2, R2-2). Empty lines are dropped. An object with an origin of its own (a
 * function, a group) becomes hers when anything in it changed. Keys the interface does
 * not send (a newer app's) are kept.
 */
export function mergeInput(input: unknown, stored: unknown): unknown {
  if (isClaimInput(input)) return mergeClaim(input, stored);
  if (input === null) return null;
  if (Array.isArray(input)) {
    const storedList = Array.isArray(stored) ? [...stored] : [];
    if (input.every(isClaimInput)) {
      const lines = input.filter((claim) => !isEmptyLine(claim)) as Array<{ value: unknown; check?: unknown }>;
      const used = new Set<number>();
      // First the lines she kept, by value.
      const matches = lines.map((claim) => {
        const at = storedList.findIndex((candidate, position) => !used.has(position) && isClaim(candidate) && same(candidate.value, claim.value));
        if (at !== -1) used.add(at);
        return at;
      });
      // Then, when no line was added or removed, each edited line takes the unmatched stored
      // line at its own place; otherwise places do not line up and an edited line is hers
      // alone (review round 2, R2-2).
      const samePlaces = lines.length === storedList.length;
      return lines.map((claim, index) => {
        let at = matches[index];
        if (samePlaces && at === -1 && !used.has(index) && isClaim(storedList[index])) {
          at = index;
          used.add(index);
        }
        return mergeClaim(claim, at === -1 ? undefined : storedList[at]);
      });
    }
    return input.map((entry, index) => mergeInput(entry, storedList[index]));
  }
  if (isPlainObject(input)) {
    const base = isPlainObject(stored) ? stored : {};
    const out: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(input)) {
      if (KEPT_KEYS.has(key)) continue;
      out[key] = mergeInput(value, base[key]);
    }
    if ("origin" in base) {
      const { origin: _o, editedAt: _e, ...before } = base;
      const { origin: _o2, editedAt: _e2, ...after } = out;
      void _o;
      void _e;
      void _o2;
      void _e2;
      if (!same(before, after) || !("origin" in base)) out.origin = "her";
    }
    return out;
  }
  return input;
}

/* What the interface may send for each part: values and [CHECK] texts only (strict: nothing else gets in). */

const ClaimInputSchema = (max: number) => z.strictObject({ value: z.string().max(max), check: z.string().max(T.text).nullable() });
const textIn = (max: number) => ClaimInputSchema(max).nullable();
const listIn = (max: number = T.text) => z.array(ClaimInputSchema(max)).max(MAX_MAP_LIST);
const TagListInput = z.strictObject({ value: z.array(WordSchema).max(20), check: z.string().max(T.text).nullable() }).nullable();

const ITEM_INPUTS: Record<MapPartId, z.ZodType> = {
  client: z.strictObject({
    age: textIn(T.name),
    diagnosis: textIn(T.text),
    severityLevel: textIn(T.name),
    evaluator: textIn(T.name),
    evaluationDate: textIn(T.short),
    medications: listIn(),
    school: textIn(T.name),
    grade: textIn(T.short),
    schedule: textIn(T.text),
    iep: textIn(T.text),
    otherServices: z.array(z.strictObject({ name: textIn(T.name), provider: textIn(T.name), paid: textIn(T.short) })).max(MAX_MAP_LIST),
    languages: listIn(T.name),
  }),
  caregivers: z.strictObject({ role: textIn(T.name), language: textIn(T.name), availability: textIn(T.text), participation: textIn(T.text), limits: textIn(T.text), mitigation: textIn(T.text) }),
  settings: z.strictObject({ name: textIn(T.name), kind: textIn(T.short), evidence: textIn(T.short), by: textIn(T.name), dates: textIn(T.text) }),
  deficits: z.strictObject({
    area: textIn(T.name),
    scores: z.array(z.strictObject({ instrument: textIn(T.name), scale: textIn(T.name), score: textIn(T.short), percentile: textIn(T.short), level: textIn(T.name) })).max(MAX_MAP_LIST),
    evidence: listIn(),
    impact: textIn(T.text),
  }),
  strengths: z.strictObject({ text: textIn(T.text), kind: textIn(T.short), setting: textIn(T.name) }),
  behaviors: z.strictObject({
    name: textIn(T.name),
    topographies: listIn(),
    measure: textIn(T.short),
    definition: textIn(T.definition),
    onset: textIn(T.text),
    offset: textIn(T.text),
    examples: listIn(),
    nonExamples: listIn(),
    baseline: z.strictObject({
      observations: z.array(z.strictObject({ date: textIn(T.short), setting: textIn(T.name), length: textIn(T.short).optional(), minutes: textIn(T.short), value: textIn(T.short) })).max(MAX_MAP_LIST),
      other: listIn(),
    }),
    intensity: textIn(T.short),
    settingIds: IdListSchema,
    antecedents: listIn(),
    consequences: listIn(),
    function: z.strictObject({
      primary: z.array(WordSchema).max(5),
      secondary: z.array(WordSchema).max(5),
      evidence: z
        .array(z.strictObject({ tool: WordSchema, respondent: z.string().max(T.name).nullable(), result: textIn(T.text), supports: z.array(WordSchema).max(5) }))
        .max(MAX_MAP_LIST),
      reasoning: z.string().max(T.text).nullable(),
      check: z.string().max(T.text).nullable(),
    }),
    barriers: TagListInput,
    risks: listIn(),
  }),
  risks: z.strictObject({ behaviorIds: IdListSchema, what: textIn(T.text), evidence: listIn(), level: textIn(T.name) }),
  facts: z.strictObject({ text: textIn(T.text), homeSection: SectionNumberSchema.nullable() }),
  openItems: z.strictObject({
    kind: WordSchema,
    text: z.string().max(T.text),
    itemRef: z.strictObject({ part: z.string().max(32), itemId: ItemIdSchema }).nullable(),
    homeSection: SectionNumberSchema.nullable(),
    status: WordSchema,
  }),
  // The report on her sections is the AI's to write (Read what I have); she only marks each item.
  report: z.strictObject({ status: WordSchema }),
};

const GroupInputSchema = z.strictObject({
  behaviorIds: IdListSchema,
  nature: z.string().max(T.name),
  function: WordSchema.nullable(),
  measure: WordSchema.nullable(),
  reason: z.string().max(T.text),
});

/** Checks what the interface sent for an item (any field may be left out: it keeps its value). */
export function parseItemInput(part: MapPartId, collection: MapCollection, input: unknown): Record<string, unknown> {
  if (collection === "groups" && part !== "behaviors") refuse("only the behaviors part has groups.");
  const schema = collection === "groups" ? GroupInputSchema : ITEM_INPUTS[part];
  const parsed = (schema as z.ZodObject).partial().safeParse(input);
  if (!parsed.success) refuse("the item is not one this part holds, or is too long.");
  return parsed.data as Record<string, unknown>;
}

function itemsOf(content: Content, collection: MapCollection): StoredItem[] {
  return collection === "groups" ? [...(content.groups ?? [])] : [...content.items];
}

function withItems(content: Content, collection: MapCollection, items: StoredItem[]): Content {
  return collection === "groups" ? { ...content, groups: items } : { ...content, items };
}

/**
 * A behavior belongs to one group at most (her rule groups same-nature behaviors with one
 * function). The groups are put in order after a change, never refused (review round 1,
 * S1: a refused save would lose what she typed): a behavior the group she changed now
 * names leaves any other group (which is marked changed by her); an id the version has no
 * behavior for, or one named twice, is dropped.
 */
function settleGroups(content: Content, changedGroup: string | null, now: string): Content {
  const behaviors = new Set(content.items.map((item) => item.id));
  const groups = content.groups ?? [];
  const idsOf = (group: StoredItem) => ((group.behaviorIds as string[] | undefined) ?? []).filter((id, at, all) => behaviors.has(id) && all.indexOf(id) === at);
  const claimed = new Set(changedGroup === null ? [] : idsOf(groups.find((group) => group.id === changedGroup) ?? { id: "" }));
  const seen = new Set<string>();
  const settled = groups.map((group) => {
    const before = (group.behaviorIds as string[] | undefined) ?? [];
    const ids = idsOf(group).filter((id) => (group.id === changedGroup || !claimed.has(id)) && !seen.has(id));
    for (const id of ids) seen.add(id);
    if (same(ids, before)) return group;
    return { ...group, behaviorIds: ids, ...(group.id === changedGroup ? {} : { editedAt: now }) };
  });
  return { ...content, groups: settled };
}

/** The newest version of a part that holds an item (or group), and that item: a kept edit of an item the version shown no longer has. */
function latestStoredItem(stored: StoredMapPart, collection: MapCollection, itemId: string): StoredItem | undefined {
  for (const version of [...stored.versions].sort((a, b) => b.number - a.number)) {
    const found = itemsOf(version.content, collection).find((item) => item.id === itemId);
    if (found) return found;
  }
  return undefined;
}

/** Her change to an item (or a group) of a part, as she types: the item as saved, in her editing pass. Null when nothing changed. */
export function saveMapItem<D extends WithCaseMap>(
  data: D,
  part: MapPartId,
  collection: MapCollection,
  itemId: string,
  rawInput: unknown,
  editing: number | null,
  now: string,
): { data: D; version: number } | "item-not-found" | null {
  const input = parseItemInput(part, collection, rawInput);
  const stored = storedPart(data, part);
  const content = currentContent(stored);
  const items = itemsOf(content, collection);
  let index = items.findIndex((item) => item.id === itemId);
  if (index === -1) {
    // An edit of an item the version shown does not hold (she showed an older version, or
    // "Try again" of an edit kept from before): the item comes back with it, from the newest
    // version that had it, so what she typed is never lost (review round 1, minor 2).
    const earlier = latestStoredItem(stored, collection, itemId);
    if (!earlier) return "item-not-found";
    const limit = collection === "groups" ? MAX_MAP_GROUPS : MAP_PART_LIMITS[part];
    if (items.length >= limit) refuse("this part is full.");
    items.push(earlier);
    index = items.length - 1;
  }
  const before = items[index];
  const merged = mergeInput(input, before) as StoredItem;
  if (same(merged, before) && items.length === itemsOf(content, collection).length) return null;
  items[index] = { ...merged, id: before.id, editedAt: now };
  let next = withItems(content, collection, items);
  if (part === "behaviors") next = settleGroups(next, collection === "groups" ? before.id : null, now);
  return writeContent(data, part, next, editing, now);
}

/** Adds an item (or a group) she typed or started: hers, with a new id. */
export function addMapItem<D extends WithCaseMap>(data: D, part: MapPartId, collection: MapCollection, rawInput: unknown, editing: number | null, now: string): { data: D; version: number; itemId: string } {
  const input = parseItemInput(part, collection, rawInput);
  const stored = storedPart(data, part);
  const content = currentContent(stored);
  const items = itemsOf(content, collection);
  const limit = collection === "groups" ? MAX_MAP_GROUPS : MAP_PART_LIMITS[part];
  if (part === "client" && items.length > 0) refuse("the client part has one item.");
  if (items.length >= limit) refuse("this part is full.");
  const id = newId(stored, part, collection);
  const blank = collection === "groups" ? blankGroup(id) : blankItem(part, id);
  const merged = mergeInput(input, {}) as Record<string, unknown>;
  const item = { ...(withDefaults(blank, merged) as Record<string, unknown>), id, editedAt: now } as StoredItem;
  if (collection === "groups") item.origin = "her";
  if (part === "behaviors" && collection === "items") (item.function as Record<string, unknown>).origin = "her";
  let next = withItems(content, collection, [...items, item]);
  if (part === "behaviors") next = settleGroups(next, collection === "groups" ? id : null, now);
  const written = writeContent(data, part, next, editing, now);
  return { ...written, itemId: id };
}

/** Removes an item from the version she works in (D: allowed; every earlier version keeps it). A behavior leaves its group too. */
export function removeMapItem<D extends WithCaseMap>(data: D, part: MapPartId, collection: MapCollection, itemId: string, editing: number | null, now: string): { data: D; version: number } | "item-not-found" {
  const stored = storedPart(data, part);
  const content = currentContent(stored);
  const items = itemsOf(content, collection);
  if (!items.some((item) => item.id === itemId)) return "item-not-found";
  let next = withItems(content, collection, items.filter((item) => item.id !== itemId));
  if (part === "behaviors" && collection === "items" && next.groups) {
    next = {
      ...next,
      groups: next.groups.map((group) => {
        const ids = (group.behaviorIds as string[] | undefined) ?? [];
        return ids.includes(itemId) ? { ...group, behaviorIds: ids.filter((id) => id !== itemId), editedAt: now } : group;
      }),
    };
  }
  return writeContent(data, part, next, editing, now);
}

/** Shows another version of a part (going back moves the pointer only). Null when there is no such version. */
export function setMapPartVersion<D extends WithCaseMap>(data: D, part: MapPartId, number: number): D | null {
  const stored = storedPart(data, part);
  if (!findVersion(stored, number)) return null;
  return withPart(data, part, { ...stored, currentVersion: number });
}

/** Approves a version of a part (and shows it), or takes the approval back (null). Null when there is no such version. */
export function approveMapPart<D extends WithCaseMap>(data: D, part: MapPartId, number: number | null, now: string): D | null {
  const stored = storedPart(data, part);
  if (number === null) return stored.approvedVersion === null ? data : withPart(data, part, withoutApproval(stored));
  if (!findVersion(stored, number)) return null;
  const versions = stored.versions.map((version) => (version.number === number && version.approvedOnce !== true ? { ...version, approvedOnce: true as const } : version));
  return withPart(data, part, { ...stored, versions, approvedVersion: number, approvedAt: now, currentVersion: number });
}

/* The AI's drafts (step 1, pull request 2) */

/** What one AI request of the map recorded (caseMap.extractions): who wrote it, from what, and what the checks found. */
export interface MapExtractionRecord {
  id: string;
  kind: string;
  at: string;
  /** The run it belongs to: the two requests of one "Draft the map". */
  run: string;
  generation: Record<string, unknown>;
  format: string;
  repaired: boolean;
  /** Whether the repair's answer was used; false when it came back unreadable, cut short or failed, and the first answer was saved with its flags (review round 1, B1). */
  repairUsed?: boolean;
  /** What the code checks found in the first answer, which the repair was asked to fix (at most 50; review round 1, S6). */
  problemsBeforeRepair?: string[];
  /** What the code checks still found after the repair (at most 50). */
  problems: string[];
}

/** An item as the AI's answer gives it, already in the stored shape, with its key instead of an id. */
export type AnswerItem = Record<string, unknown> & { key: string };

/** A part from an answer: its items, the behaviors part's groups, and whether the items replace the AI's or join them. */
export interface AnswerPart {
  items: AnswerItem[];
  groups?: AnswerItem[];
  /** "join": the items are added to what the version shown holds (the open items of the second request). */
  mode?: "replace" | "join";
}

const MAX_EXTRACTIONS = 10_000;
const MAX_EXTRACTION_PROBLEMS = 50;

/**
 * Saves an answer as new versions (D1, D5). For each part:
 * - a part whose version shown she approved is left as it is: the AI never changes approved content;
 * - an item keeps its id when its key is an id the part has had; any other key gets a new id from code;
 * - an item she changed by hand (editedAt) is kept as hers, in place of the AI's, and kept
 *   when the AI leaves it out;
 * - the new version is "ai" when the part had no version before this run, "update" otherwise;
 * - a part whose content would not change gets no new version.
 * Links between items (a group's or a risk's behaviors) go from keys to ids. The record is kept.
 */
export function applyMapAnswer<D extends WithCaseMap>(
  data: D,
  parts: Partial<Record<MapPartId, AnswerPart>>,
  record: MapExtractionRecord,
  partsBeforeRun: ReadonlySet<MapPartId>,
  now: string,
): { data: D; written: MapPartId[]; kept: MapPartId[] } {
  let next = data;
  const written: MapPartId[] = [];
  const kept: MapPartId[] = [];
  const behaviorIds = new Map<string, string>();
  const order = (Object.keys(parts) as MapPartId[]).sort((a, b) => (a === "behaviors" ? -1 : b === "behaviors" ? 1 : 0));
  const mapIds = (keys: unknown) => (Array.isArray(keys) ? [...new Set(keys.map((key) => behaviorIds.get(String(key))).filter((id): id is string => id !== undefined))] : []);
  const problems = [...record.problems];

  for (const part of order) {
    const answer = parts[part]!;
    const stored = storedPart(next, part);
    const status = mapPartView(next, part).status;
    if (status === "approved") {
      kept.push(part);
      // Her approved behaviors keep their ids: a risk of the AI names them by id (review round 1, S4).
      if (part === "behaviors") for (const item of currentContent(stored).items) behaviorIds.set(item.id, item.id);
      continue;
    }
    const content = currentContent(stored);
    const everIds = new Set(stored.versions.flatMap((version) => [...version.content.items, ...(version.content.groups ?? [])].map((item) => item.id)));
    const counter = (prefix: string) => {
      let max = 0;
      for (const id of everIds) {
        const match = new RegExp(`^${prefix}-(\\d+)$`).exec(id);
        if (match) max = Math.max(max, Number(match[1]));
      }
      return () => `${prefix}-${++max}`;
    };
    const nextItemId = part === "client" ? () => "client" : counter(MAP_ID_PREFIX[part]);
    const nextGroupId = counter(GROUP_ID_PREFIX);

    const settle = (incoming: AnswerItem[], current: StoredItem[], newId: () => string, isGroup: boolean): StoredItem[] => {
      const hers = new Map(current.filter((item) => typeof item.editedAt === "string").map((item) => [item.id, item]));
      const used = new Set<string>();
      const out: StoredItem[] = [];
      for (const raw of incoming) {
        const { key, behaviorKeys, ...rest } = raw;
        const id = part === "client" ? "client" : everIds.has(key) && !used.has(key) ? key : newId();
        used.add(id);
        if (part === "behaviors" && !isGroup) behaviorIds.set(key, id);
        if (hers.has(id)) {
          out.push(hers.get(id)!);
          continue;
        }
        const linked = isGroup || part === "risks" ? { behaviorIds: mapIds(behaviorKeys) } : {};
        out.push({ ...rest, ...linked, id } as StoredItem);
      }
      for (const [id, item] of hers) if (!used.has(id)) out.push(item);
      return out;
    };

    const items = answer.mode === "join" ? [...content.items, ...settle(answer.items, [], nextItemId, false)] : settle(answer.items, content.items, nextItemId, false);
    let nextContent: Content = { ...content, items };
    if (part === "behaviors") {
      // Her behaviors kept by id: a group of the AI names them by the key the answer gave.
      for (const item of items) if (!behaviorIds.has(item.id)) behaviorIds.set(item.id, item.id);
      nextContent = settleGroups({ ...nextContent, groups: settle(answer.groups ?? [], content.groups ?? [], nextGroupId, true) }, null, now);
    }
    // The AI's content never stops the save (review round 1, B2): a link to an id the map
    // does not have is left out, an item over the limits is left out, and each is recorded.
    nextContent = { ...nextContent, items: nextContent.items.map((item) => withKnownLinks(item, settingIdsOf(next), problems, part)) };
    if (!CONTENT_SCHEMAS[part].safeParse(nextContent).success) nextContent = fitting(part, nextContent, problems);
    if (JSON.stringify(nextContent) === JSON.stringify(content)) continue;
    if (!CONTENT_SCHEMAS[part].safeParse(nextContent).success) {
      problems.push(`${part}: the AI's content does not fit the case map's limits, so this part was left as it was.`);
      continue;
    }
    const number = nextNumber(stored);
    const version: StoredMapVersion = {
      number,
      kind: partsBeforeRun.has(part) ? "update" : "ai",
      createdAt: now,
      ...(currentPartVersion(stored) ? { basedOn: currentPartVersion(stored)!.number } : {}),
      extraction: record.id,
      content: nextContent,
    };
    next = withPart(next, part, withoutApproval({ ...stored, versions: [...stored.versions, version], currentVersion: number }));
    written.push(part);
  }
  const map: StoredCaseMap = next.caseMap ?? { parts: {} };
  const capped = (list: readonly string[]) => list.slice(0, MAX_EXTRACTION_PROBLEMS).map((problem) => problem.slice(0, 500));
  const extractions = [
    ...(map.extractions ?? []),
    { ...record, problems: capped(problems), ...(record.problemsBeforeRepair ? { problemsBeforeRepair: capped(record.problemsBeforeRepair) } : {}) },
  ].slice(-MAX_EXTRACTIONS);
  next = { ...next, caseMap: { ...map, extractions } };
  return { data: next, written, kept };
}

/** The ids of the settings the map holds now. */
function settingIdsOf(data: WithCaseMap): Set<string> {
  return new Set(currentContent(storedPart(data, "settings")).items.map((item) => item.id));
}

/** An item with its setting links narrowed to settings the map has (review round 1, B2); what was left out is recorded. */
function withKnownLinks(item: StoredItem, settingIds: ReadonlySet<string>, problems: string[], part: MapPartId): StoredItem {
  if (part !== "behaviors" || !Array.isArray(item.settingIds) || typeof item.editedAt === "string") return item;
  const known = (item.settingIds as unknown[]).filter((id): id is string => typeof id === "string" && ItemIdSchema.safeParse(id).success && settingIds.has(id));
  if (known.length === (item.settingIds as unknown[]).length) return item;
  problems.push(`behaviors: ${item.id} named settings the map does not have; they were left out.`);
  return { ...item, settingIds: known };
}

/** The content with each item and group that does not fit the map's limits left out, and recorded (review round 1, B2). */
function fitting(part: MapPartId, content: Content, problems: string[]): Content {
  const fits = (item: StoredItem, schema: z.ZodType) => {
    const ok = schema.safeParse(item).success;
    if (!ok && typeof item.editedAt !== "string") problems.push(`${part}: ${item.id} does not fit the case map's limits and was left out.`);
    return ok || typeof item.editedAt === "string";
  };
  const items = content.items.filter((item) => fits(item, ITEM_SCHEMAS[part])).slice(0, MAP_PART_LIMITS[part]);
  const groups = content.groups === undefined ? undefined : content.groups.filter((group) => fits(group, GroupSchema)).slice(0, MAX_MAP_GROUPS);
  return { ...content, items, ...(groups ? { groups } : {}) };
}

/** Values only, for a prompt: a claim as its value (and its [CHECK]), everything else as it is. */
function valuesOnly(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(valuesOnly);
  if (!isPlainObject(value)) return value;
  if (isClaim(value)) return value.check ? { value: value.value, check: value.check } : value.value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "editedAt" || key === "origin" || key === "refs") continue;
    out[key] = valuesOnly(entry);
  }
  return out;
}

/**
 * Her map, for an update (D12, "her-map"): the parts she approved, whole, and in every
 * other part the items she typed or changed by hand. Each item with its id. Null when she
 * has none.
 */
export function herMapForPrompt(data: WithCaseMap, parts: readonly MapPartId[]): string | null {
  const out: Record<string, unknown> = {};
  for (const part of parts) {
    const view = mapPartView(data, part);
    const stored = currentPartVersion(storedPart(data, part));
    if (!stored) continue;
    const items = view.status === "approved" ? stored.content.items : stored.content.items.filter((item) => typeof item.editedAt === "string");
    const groups = part === "behaviors" ? (view.status === "approved" ? (stored.content.groups ?? []) : (stored.content.groups ?? []).filter((group) => typeof group.editedAt === "string")) : [];
    if (items.length === 0 && groups.length === 0) continue;
    out[part] = { ...(view.status === "approved" ? { approved: true } : {}), items: valuesOnly(items), ...(groups.length > 0 ? { groups: valuesOnly(groups) } : {}) };
  }
  return Object.keys(out).length > 0 ? JSON.stringify(out) : null;
}

/** The facts the behaviors request builds on: the settings with their ids, and the caregivers' roles. */
export function mapFactsForPrompt(data: WithCaseMap): { text: string; settingIds: Set<string> } {
  const settings = mapPartView(data, "settings").items as unknown as Array<Record<string, unknown> & { id: string }>;
  const caregivers = mapPartView(data, "caregivers").items as unknown as Array<Record<string, unknown> & { id: string }>;
  const text = JSON.stringify({ settings: valuesOnly(settings.map(({ id, name, kind, evidence }) => ({ id, name, kind, evidence }))), caregivers: valuesOnly(caregivers.map(({ id, role }) => ({ id, role }))) });
  return { text, settingIds: new Set(settings.map((setting) => setting.id)) };
}

/** Every id an item of these parts has had, for the answers' keys to reuse (D5). */
export function partsWithVersions(data: WithCaseMap): Set<MapPartId> {
  return new Set(MAP_PARTS.filter((part) => storedPart(data, part).versions.length > 0));
}
