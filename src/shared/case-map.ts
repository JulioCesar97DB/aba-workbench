/*
 * The case map (step 1 of the AI knowledge plan, owner's decisions D1-D35 of 2026-11-23):
 * one structured record of the case, kept inside aba-case.json (schema version 4), made
 * of parts that each keep their own history like a section's versions. The AI drafts it
 * (from a later pull request on); she corrects and approves it part by part. Plain data
 * and plain functions only, shared by the main process (which keeps it in the case's data
 * file, src/main/case-map.ts) and the interface.
 *
 * Every fact-bearing value is a claim: its value, where it came from (refs), what kind of
 * content it is (origin) and the [CHECK: ...] text on it, if any.
 */

/** The parts, in the order the screen shows them. */
export const MAP_PARTS = ["client", "caregivers", "settings", "deficits", "strengths", "behaviors", "risks", "facts", "openItems", "report"] as const;
export type MapPartId = (typeof MAP_PARTS)[number];

export function isMapPartId(value: unknown): value is MapPartId {
  return typeof value === "string" && (MAP_PARTS as readonly string[]).includes(value);
}

/** The lists of items a part holds: every part has "items"; the behaviors part also has "groups". */
export type MapCollection = "items" | "groups";

/** How many items each part may hold (D6), and how many groups the behaviors part may. */
export const MAP_PART_LIMITS: Readonly<Record<MapPartId, number>> = {
  client: 1,
  caregivers: 10,
  settings: 20,
  deficits: 20,
  strengths: 60,
  behaviors: 30,
  risks: 40,
  facts: 500,
  openItems: 500,
  report: 200,
};
export const MAX_MAP_GROUPS = 30;
/** Claims in one list (examples, antecedents...), observations of a baseline, scores of a deficit, evidence entries of a function. */
export const MAX_MAP_LIST = 30;
export const MAX_MAP_REFS = 10;
export const MAX_MAP_VERSIONS = 10_000;
/** Characters, by kind of text (D6). */
export const MAP_TEXT_LIMITS = { name: 120, short: 40, quote: 300, text: 1_500, definition: 3_000 } as const;

/** The id prefix of each part's items; the client part has one item, "client". */
export const MAP_ID_PREFIX: Readonly<Record<MapPartId, string>> = {
  client: "client",
  caregivers: "cg",
  settings: "set",
  deficits: "def",
  strengths: "str",
  behaviors: "beh",
  risks: "risk",
  facts: "fact",
  openItems: "oi",
  report: "rep",
};
export const GROUP_ID_PREFIX = "grp";

/** An item's id: "beh-1", "grp-3", or "client". */
export const MAP_ITEM_ID = /^(client|[a-z]{1,8}-[1-9][0-9]{0,5})$/;

/** Her five functions, in the order of her Hypothesis Based Interventions blocks (D17). */
export const FUNCTION_NAMES = ["tangibles", "attention", "escape", "sensory", "automatic"] as const;
export type FunctionName = (typeof FUNCTION_NAMES)[number];

/** The barrier tags of her behavior blocks, a fixed list in ABA Matrix (D18). */
export const BARRIER_TAGS = [
  "safety",
  "communication",
  "social-interaction",
  "following-instructions",
  "learning-and-task-engagement",
  "daily-living-skills",
  "community-participation",
  "transitions-and-flexibility",
  "emotional-regulation",
] as const;
export type BarrierTag = (typeof BARRIER_TAGS)[number];

export const MEASURES = ["frequency", "duration", "latency", "intensity"] as const;
export const SETTING_KINDS = ["home", "school", "community", "clinic", "other"] as const;
export const SETTING_EVIDENCE = ["observed", "reported"] as const;
export const STRENGTH_KINDS = ["strength", "interest", "preference", "reinforcer"] as const;
export const EVIDENCE_TOOLS = ["fast", "mas", "abc", "observation", "interview", "her-section"] as const;
export const OPEN_ITEM_KINDS = ["check", "missing"] as const;
export const REPORT_ITEM_KINDS = ["contradiction", "thread-gap", "payer-gap", "her-text-kept"] as const;
export const ITEM_STATUSES = ["open", "resolved", "dismissed"] as const;
/** Intensity, 1 to 3, hers only (D19); "" when not rated. */
export const INTENSITIES = ["1", "2", "3"] as const;

/**
 * What kind of content a claim is (D3, and the four kinds of content of rules/assessment.md):
 * - "her": from her sections, her notes, or what she typed in the map: final;
 * - "extracted": a source states it;
 * - "ai-drafted": written by the AI from cited facts (a definition), for her to approve;
 * - "hypothesis": a function or a group, with its evidence;
 * - "proposed": a clinical choice that is hers to make (a barrier tag).
 * A kind a newer app writes is kept as it is and shown as "her" would not be: as unknown.
 */
export const ORIGINS = ["her", "extracted", "ai-drafted", "hypothesis", "proposed"] as const;
export type Origin = (typeof ORIGINS)[number];

/**
 * Where a claim came from:
 * - "source": a source of the case, with a verbatim quote;
 * - "section": one of her sections, at a version, with a quote;
 * - "note": her session notes (the session's start time), with a quote;
 * - "her": she typed or changed it in the map;
 * - "app": computed by the app.
 * A kind a newer app writes is kept as it is.
 */
export interface MapRef {
  kind: string;
  sourceId?: string;
  sectionId?: string;
  version?: number;
  session?: string;
  quote?: string;
}

export interface Claim<T = string> {
  value: T;
  refs: MapRef[];
  origin: string;
  /** The [CHECK: ...] text on it, without the brackets; null when none. */
  check: string | null;
}

export type TextClaim = Claim<string>;

export interface ClientItem {
  id: "client";
  age: TextClaim | null;
  diagnosis: TextClaim | null;
  severityLevel: TextClaim | null;
  evaluator: TextClaim | null;
  evaluationDate: TextClaim | null;
  medications: TextClaim[];
  school: TextClaim | null;
  grade: TextClaim | null;
  schedule: TextClaim | null;
  iep: TextClaim | null;
  otherServices: Array<{ name: TextClaim; provider: TextClaim | null; paid: TextClaim | null }>;
  languages: TextClaim[];
}

export interface CaregiverItem {
  id: string;
  role: TextClaim | null;
  language: TextClaim | null;
  availability: TextClaim | null;
  participation: TextClaim | null;
  limits: TextClaim | null;
  mitigation: TextClaim | null;
}

export interface SettingItem {
  id: string;
  name: TextClaim | null;
  kind: TextClaim | null;
  evidence: TextClaim | null;
  by: TextClaim | null;
  dates: TextClaim | null;
}

export interface DeficitScore {
  instrument: TextClaim | null;
  scale: TextClaim | null;
  score: TextClaim | null;
  percentile: TextClaim | null;
  level: TextClaim | null;
}

export interface DeficitItem {
  id: string;
  area: TextClaim | null;
  scores: DeficitScore[];
  evidence: TextClaim[];
  impact: TextClaim | null;
}

export interface StrengthItem {
  id: string;
  text: TextClaim | null;
  kind: TextClaim | null;
  setting: TextClaim | null;
}

export interface BaselineObservation {
  date: TextClaim | null;
  setting: TextClaim | null;
  minutes: TextClaim | null;
  value: TextClaim | null;
}

export interface FunctionEvidence {
  tool: string;
  respondent: string | null;
  result: TextClaim | null;
  supports: string[];
}

export interface BehaviorFunction {
  primary: string[];
  secondary: string[];
  origin: string;
  evidence: FunctionEvidence[];
  reasoning: string | null;
  check: string | null;
}

export interface BehaviorItem {
  id: string;
  name: TextClaim | null;
  topographies: TextClaim[];
  measure: TextClaim | null;
  definition: TextClaim | null;
  onset: TextClaim | null;
  offset: TextClaim | null;
  examples: TextClaim[];
  nonExamples: TextClaim[];
  baseline: { observations: BaselineObservation[]; other: TextClaim[] };
  intensity: TextClaim | null;
  settingIds: string[];
  antecedents: TextClaim[];
  consequences: TextClaim[];
  function: BehaviorFunction;
  barriers: Claim<string[]> | null;
  risks: TextClaim[];
}

export interface GroupItem {
  id: string;
  behaviorIds: string[];
  nature: string;
  function: string | null;
  measure: string | null;
  reason: string;
  origin: string;
}

export interface RiskItem {
  id: string;
  behaviorIds: string[];
  what: TextClaim | null;
  evidence: TextClaim[];
  level: TextClaim | null;
}

export interface FactItem {
  id: string;
  text: TextClaim | null;
  /** The section of the 22-section template that tells it in full (rules/guide.md, the section map). */
  homeSection: number | null;
}

export interface OpenItem {
  id: string;
  kind: string;
  text: string;
  /** The map item it is about, if any. */
  itemRef: { part: string; itemId: string } | null;
  homeSection: number | null;
  status: string;
}

export interface ReportItem {
  id: string;
  kind: string;
  text: string;
  /** Her sections it is about, by id. */
  sections: string[];
  refs: MapRef[];
  status: string;
}

export interface MapItemByPart {
  client: ClientItem;
  caregivers: CaregiverItem;
  settings: SettingItem;
  deficits: DeficitItem;
  strengths: StrengthItem;
  behaviors: BehaviorItem;
  risks: RiskItem;
  facts: FactItem;
  openItems: OpenItem;
  report: ReportItem;
}
export type MapItem = MapItemByPart[MapPartId];

/** Every item as the interface gets it: its fields, and when she last changed it by hand. */
export type MapItemView<P extends MapPartId = MapPartId> = MapItemByPart[P] & { editedAt: string | null };

/**
 * A part's status (D2):
 * - "empty": nothing yet;
 * - "draft": the version shown is the AI's, not approved;
 * - "corrected": the version shown is hers (typed or corrected by hand), not approved;
 * - "approved": she approved the version shown.
 */
export type MapPartStatus = "empty" | "draft" | "corrected" | "approved";

/** How a part's version came to be: the AI's draft, her edit by hand, or the AI's update of a map that existed. */
export type MapVersionKind = "ai" | "edited" | "update";

export interface MapPartVersionInfo {
  number: number;
  kind: MapVersionKind;
  createdAt: string;
  updatedAt: string | null;
  basedOn: number | null;
  /** Items in it, and groups for the behaviors part. */
  itemCount: number;
  groupCount: number;
}

export interface MapPartView {
  id: MapPartId;
  status: MapPartStatus;
  currentVersion: number | null;
  approvedVersion: number | null;
  approvedAt: string | null;
  /** Why the part may no longer match the case, when something it was built from changed (D23). */
  outOfDate: { since: string; reasons: string[] } | null;
  /** Oldest first. */
  versions: MapPartVersionInfo[];
  /** The items of the version shown. */
  items: MapItemView[];
  groups: Array<GroupItem & { editedAt: string | null }>;
}

export interface CaseMapView {
  parts: Record<MapPartId, MapPartView>;
  /** The case's save time this was read at (see SectionDetail.revision). */
  revision: string;
}

/** For the sidebar: parts approved, out of parts with something in them. */
export interface CaseMapSummary {
  approved: number;
  withContent: number;
}

/** A part's status from its versions (D2). An unknown kind of version (a newer app's) counts as hers to review. */
export function mapPartStatus(versions: ReadonlyArray<{ number: number; kind: string }>, currentVersion: number | null, approvedVersion: number | null): MapPartStatus {
  if (versions.length === 0) return "empty";
  const current = versions.find((version) => version.number === currentVersion) ?? versions.at(-1);
  if (!current) return "empty";
  if (approvedVersion !== null && approvedVersion === current.number) return "approved";
  return current.kind === "ai" || current.kind === "update" ? "draft" : "corrected";
}

/**
 * The mean of a behavior's baseline observations, as section 8 gives it (D20): computed by
 * the app from the counts, decimals kept to two places. Null when any count is missing or
 * not a plain number, or there is none: the app never guesses.
 */
export function baselineMean(observations: ReadonlyArray<Pick<BaselineObservation, "value">>): number | null {
  if (observations.length === 0) return null;
  let sum = 0;
  for (const observation of observations) {
    const raw = observation.value?.value.trim() ?? "";
    if (!/^\d+(\.\d+)?$/.test(raw)) return null;
    sum += Number(raw);
  }
  return Math.round((sum / observations.length) * 100) / 100;
}

/* What the interface sends: values and [CHECK] texts only. Where each value came from is the main process's to record. */

/** A value she typed or kept, with its [CHECK: ...] text. */
export interface ClaimInput<T = string> {
  value: T;
  check: string | null;
}
