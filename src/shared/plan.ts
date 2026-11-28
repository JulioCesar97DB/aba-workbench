/*
 * The plan (step 3, "Plan"; owner's decisions of 2026-11-28 on the Plan step proposal,
 * D1 to D32). The plan lives in the case map (D1): six more parts inside caseMap.parts,
 * with the same versions, history, provenance, autosave and failed saves as the map's
 * parts, listed apart from the map's own (PLAN_PARTS) so the map's screen and counts do not
 * change. Plain data and plain functions only, shared by the main process and the interface.
 *
 * - strategies: every named strategy or teaching procedure, with its structured parameters
 *   (D13). An antecedent strategy names the function blocks it is preventive in.
 * - interventions: the management entries of the function blocks, one item each: the
 *   "Positive" paragraph of a block, or one "Maladaptive" entry per behavior or group.
 * - programs: the replacement and skills acquisition programs. A replacement belongs to the
 *   block of its own function.
 * - glossary: one entry per strategy, by its strategy's id; its name is the strategy's (D15).
 * - caregiverGoals: the goal blocks of Family/Caregiver Involvement (D9).
 * - planInputs: one item, "plan": the weekly hours she types (D10), and her override of the
 *   program target.
 *
 * The function blocks themselves are never stored: which blocks exist and which behaviors
 * each lists are computed by code from the map's primary and secondary functions, in her
 * order (D7). Every item carries a decision (D2): proposed, accepted or rejected. Editing an
 * item accepts it (D3); a rejected item stays, under "Rechazadas", and can be recovered (D4).
 */

import { FUNCTION_NAMES, type BehaviorItem, type CaseMapView, type FunctionName, type MapPartVersionInfo, type RiskItem, type TextClaim } from "./case-map.ts";

export const PLAN_PARTS = ["strategies", "interventions", "programs", "glossary", "caregiverGoals", "planInputs"] as const;
export type PlanPartId = (typeof PLAN_PARTS)[number];

export function isPlanPartId(value: unknown): value is PlanPartId {
  return typeof value === "string" && (PLAN_PARTS as readonly string[]).includes(value);
}

/** The id prefix of each plan part's items; planInputs has one item, "plan". */
export const PLAN_ID_PREFIX: Readonly<Record<PlanPartId, string>> = {
  strategies: "stg",
  interventions: "hbi",
  programs: "prg",
  glossary: "glo",
  caregiverGoals: "cgg",
  planInputs: "plan",
};

/** How many items each plan part may hold (proposal §3.3). */
export const PLAN_PART_LIMITS: Readonly<Record<PlanPartId, number>> = {
  strategies: 60,
  // Five blocks, each a Positive and up to 30 Maladaptive entries.
  interventions: 155,
  programs: 60,
  glossary: 80,
  caregiverGoals: 6,
  planInputs: 1,
};
/** Steps and targets of a program, parameters of a strategy or a program, sessions of a baseline. */
export const MAX_PROGRAM_STEPS = 20;
export const MAX_PROGRAM_TARGETS = 30;
export const MAX_PARAMETERS = 12;
export const MAX_BASELINE_SESSIONS = 10;

export const PLAN_DECISIONS = ["proposed", "accepted", "rejected"] as const;
export type PlanDecision = (typeof PLAN_DECISIONS)[number];

export const STRATEGY_KINDS = ["antecedent", "teaching", "consequence"] as const;
export const MANAGEMENT_KINDS = ["positive", "maladaptive"] as const;
export const PROGRAM_KINDS = ["replacement", "skill"] as const;
/** What a replacement gets the child (programs.md; proposal §5.2): a closed list. */
export const OUTCOMES = ["break", "help", "item", "waiting", "attention", "competing-activity", "other"] as const;
export type Outcome = (typeof OUTCOMES)[number];
export const PROGRAM_AREAS = ["communication", "daily-living", "toileting", "safety", "social-play", "waiting-tolerance", "community", "other"] as const;
export const PROGRAM_MEASURES = ["percent-opportunities", "task-analysis-steps", "duration"] as const;
/** The mastery categories (D12): 90%, 95% for safety skills, 100% for crossing the street. */
export const MASTERY_CATEGORIES = ["general", "safety", "street-crossing"] as const;
export type MasteryCategory = (typeof MASTERY_CATEGORIES)[number];
export const CAREGIVER_GOAL_KINDS = ["interventions", "programs", "reinforcement", "extra"] as const;

/**
 * What a parameter is for (coordinator's answer of 2026-11-28 to PR 1's question 3): a closed,
 * short list, so the clash check (D20) reads the role she or the AI chose and never guesses it
 * from the label's words.
 */
export const PARAMETER_ROLES = ["prompt-delay", "calm-before-delivery", "proximity", "interval", "duration", "count", "other"] as const;
export type ParameterRole = (typeof PARAMETER_ROLES)[number];
export const PARAMETER_UNITS = ["s", "min", "ft", "count", "%", "other"] as const;

/** Which outcomes are functionally equivalent for each function (proposal §5.2; programs.md). */
export const EQUIVALENT_OUTCOMES: Readonly<Record<FunctionName, readonly Outcome[]>> = {
  tangibles: ["item", "waiting"],
  attention: ["attention"],
  escape: ["break", "help"],
  sensory: ["competing-activity"],
  automatic: ["competing-activity"],
};

/* The items, as the interface gets them (every field filled in). */

export interface PlanDecisionFields {
  decision: string;
  decidedAt: string | null;
  /** Who wrote the item: "her" (added by hand) or "ai" (proposed by the AI, from PR 2 on). */
  by: string;
  editedAt: string | null;
}

export interface PlanParameter {
  label: string;
  role: string;
  value: TextClaim | null;
  unit: string;
}

export interface StrategyItem extends PlanDecisionFields {
  id: string;
  name: TextClaim | null;
  kind: string;
  /** The blocks it is preventive in (an antecedent strategy). */
  functions: string[];
  parameters: PlanParameter[];
  /** The map antecedents it answers. */
  tracesTo: Array<{ behaviorId: string; antecedent: TextClaim | null }>;
}

export interface ManagementItem extends PlanDecisionFields {
  id: string;
  function: string;
  kind: string;
  behaviorIds: string[];
  groupId: string | null;
  text: TextClaim | null;
  /** The strategies it names (for the glossary and the clash check). */
  strategyIds: string[];
  safetyFirst: boolean;
}

export interface BaselineSession {
  date: TextClaim | null;
  correct: TextClaim | null;
  opportunities: TextClaim | null;
}

export interface ProgramItem extends PlanDecisionFields {
  id: string;
  kind: string;
  title: TextClaim | null;
  function: string | null;
  outcome: string | null;
  area: string | null;
  answers: TextClaim[];
  definition: TextClaim | null;
  procedure: TextClaim[];
  targets: TextClaim[];
  measure: string;
  parameters: PlanParameter[];
  baseline: {
    sessions: BaselineSession[];
    /** The caregiver's report, quoted, when the sessions gave no opportunity. */
    caregiverReport: TextClaim | null;
    /** The percent that report gives. */
    caregiverPercent: TextClaim | null;
    /** Her value in place of the computed one (coordinator's answer of 2026-11-28). */
    override: TextClaim | null;
  };
  mastery: { category: string; override: TextClaim | null };
}

export interface GlossaryItem extends PlanDecisionFields {
  id: string;
  strategyId: string;
  definition: TextClaim | null;
  implementation: TextClaim | null;
  /** The strategy's fingerprint when the entry was last written: a changed strategy marks the entry out of date. */
  writtenFrom: string | null;
}

export interface CaregiverGoalItem extends PlanDecisionFields {
  id: string;
  kind: string;
  title: TextClaim | null;
  procedure: TextClaim | null;
  baselinePercent: TextClaim | null;
  masteryOverride: TextClaim | null;
}

export interface PlanInputsItem extends PlanDecisionFields {
  id: "plan";
  weeklyHours: TextClaim | null;
  targetOverride: TextClaim | null;
}

export interface PlanItemByPart {
  strategies: StrategyItem;
  interventions: ManagementItem;
  programs: ProgramItem;
  glossary: GlossaryItem;
  caregiverGoals: CaregiverGoalItem;
  planInputs: PlanInputsItem;
}

export interface PlanPartView<P extends PlanPartId = PlanPartId> {
  id: P;
  currentVersion: number | null;
  outOfDate: { since: string; reasons: string[] } | null;
  versions: MapPartVersionInfo[];
  items: Array<PlanItemByPart[P]>;
}

/** A field copied for ABA Matrix (D23): when, the plan parts' versions then, and a fingerprint of the text copied. */
export interface PlanCopiedMark {
  copiedAt: string;
  fingerprint: string;
  versions: Record<string, number | null>;
}

export interface PlanView {
  parts: { [P in PlanPartId]: PlanPartView<P> };
  copied: Record<string, PlanCopiedMark>;
  revision: string;
}

/** For the sidebar: items decided (accepted or rejected), out of the plan's items (planInputs not counted). */
export interface PlanSummary {
  decided: number;
  total: number;
}

/** Her plan standing instructions (D17) and the HBI intro (D16), from instructions.json. */
export interface PlanInstructionsView {
  text: string;
  /** The intro she confirmed, or null while it is still our draft. */
  hbiIntro: { text: string; confirmedAt: string } | null;
}

/**
 * Our draft of the two fixed sentences at the top of section 14 (D16; reading 15): not her
 * confirmed practice, so it shows as a proposal until she confirms or replaces it once.
 */
export const HBI_INTRO_DRAFT =
  "The interventions below are organized by the hypothesized function of each maladaptive behavior identified in this assessment. For each function, preventive strategies, replacement skills and management strategies are described, so that every behavior is addressed by what maintains it.";

/** Items that count for the decisions: every plan part but planInputs. */
export const DECIDED_PARTS = ["strategies", "interventions", "programs", "glossary", "caregiverGoals"] as const satisfies readonly PlanPartId[];
export type DecidedPart = (typeof DECIDED_PARTS)[number];

export function planSummary(parts: { [P in PlanPartId]: { items: ReadonlyArray<{ decision: string }> } }): PlanSummary {
  let decided = 0;
  let total = 0;
  for (const part of DECIDED_PARTS) {
    for (const item of parts[part].items) {
      total++;
      if (item.decision === "accepted" || item.decision === "rejected") decided++;
    }
  }
  return { decided, total };
}

/** A decision as written; one this version does not know (a newer app's) counts as proposed: hers to decide. */
export function decisionOf(item: { decision: string }): PlanDecision {
  return item.decision === "accepted" || item.decision === "rejected" ? item.decision : "proposed";
}

export const isRejected = (item: { decision: string }) => decisionOf(item) === "rejected";
export const isAccepted = (item: { decision: string }) => decisionOf(item) === "accepted";

/** FNV-1a, 32 bits, as hex: a short fingerprint of a text (the same in both processes). */
export function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** What a glossary entry is written from: the strategy's name and parameters. */
export function strategyFingerprint(strategy: { name?: { value: string } | null; parameters?: ReadonlyArray<{ label?: string; value?: { value: string } | null; unit?: string }> } | undefined): string {
  if (!strategy) return "";
  const parameters = (strategy.parameters ?? []).map((parameter) => [parameter.label ?? "", parameter.value?.value ?? "", parameter.unit ?? ""]);
  return fingerprint(JSON.stringify([strategy.name?.value ?? "", parameters]));
}

/* The function blocks (D7), computed from the map. */

/** A behavior as the blocks read it from the map. */
export interface BlockBehavior {
  id: string;
  name: string;
  primary: string[];
  secondary: string[];
  dangerous: boolean;
}

/** What a block's management entries cover: one behavior, or a group of the map (one entry per group). */
export interface BlockUnit {
  key: string;
  behaviorIds: string[];
  groupId: string | null;
  name: string;
  dangerous: boolean;
}

export interface FunctionBlock {
  function: FunctionName;
  behaviors: BlockBehavior[];
  units: BlockUnit[];
}

/** The map's behaviors and groups, as the plan reads them. */
export interface PlanMapInput {
  behaviors: ReadonlyArray<{
    id: string;
    name: { value: string } | null;
    function: { primary: readonly string[]; secondary: readonly string[] };
    risks?: ReadonlyArray<{ value: string }>;
    barriers?: { value: readonly string[] } | null;
  }>;
  groups: ReadonlyArray<{ id: string; behaviorIds: readonly string[]; nature: string; function: string | null }>;
  /** The map's risks part: a behavior it names is dangerous (reading 13). */
  risks: ReadonlyArray<{ behaviorIds: readonly string[] }>;
}

/** The map's behaviors (the version shown), groups and risks, for the blocks, the checks and the copy. */
export function planMapInputOf(map: Pick<CaseMapView, "parts">) {
  return {
    behaviors: map.parts.behaviors.items as unknown as BehaviorItem[],
    groups: map.parts.behaviors.groups,
    risks: (map.parts.risks.items as unknown as RiskItem[]).map((risk) => ({ behaviorIds: risk.behaviorIds })),
  };
}

export function blockBehaviors(map: PlanMapInput): BlockBehavior[] {
  const risky = new Set(map.risks.flatMap((risk) => risk.behaviorIds));
  return map.behaviors.map((behavior) => ({
    id: behavior.id,
    name: behavior.name?.value.trim() || behavior.id,
    primary: [...behavior.function.primary],
    secondary: [...behavior.function.secondary],
    dangerous: risky.has(behavior.id) || (behavior.risks ?? []).some((risk) => risk.value.trim() !== "") || (behavior.barriers?.value ?? []).includes("safety"),
  }));
}

/**
 * One block for each of her five functions that is primary or secondary for at least one
 * behavior, in her order (D7). A behavior sits in every block of its functions. Its units:
 * a group of the map whose members are all in the block is one unit (one management entry
 * per group); every other behavior is its own unit.
 */
export function functionBlocks(map: PlanMapInput): FunctionBlock[] {
  const behaviors = blockBehaviors(map);
  const blocks: FunctionBlock[] = [];
  for (const fn of FUNCTION_NAMES) {
    const members = behaviors.filter((behavior) => behavior.primary.includes(fn) || behavior.secondary.includes(fn));
    if (members.length === 0) continue;
    const inBlock = new Set(members.map((behavior) => behavior.id));
    const units: BlockUnit[] = [];
    const covered = new Set<string>();
    for (const group of map.groups) {
      const ids = group.behaviorIds.filter((id) => inBlock.has(id));
      if (ids.length < 2 || ids.length !== group.behaviorIds.length) continue;
      const names = ids.map((id) => members.find((behavior) => behavior.id === id)!.name);
      units.push({ key: group.id, behaviorIds: ids, groupId: group.id, name: names.join("; "), dangerous: ids.some((id) => members.find((behavior) => behavior.id === id)!.dangerous) });
      for (const id of ids) covered.add(id);
    }
    for (const behavior of members) {
      if (covered.has(behavior.id)) continue;
      units.push({ key: behavior.id, behaviorIds: [behavior.id], groupId: null, name: behavior.name, dangerous: behavior.dangerous });
    }
    blocks.push({ function: fn, behaviors: members, units });
  }
  return blocks;
}

/** Whether a management entry covers a unit of its block. */
export function entryCovers(entry: Pick<ManagementItem, "behaviorIds" | "groupId">, unit: BlockUnit): boolean {
  if (unit.groupId !== null && entry.groupId === unit.groupId) return true;
  return unit.behaviorIds.length > 0 && unit.behaviorIds.every((id) => entry.behaviorIds.includes(id)) && entry.behaviorIds.every((id) => unit.behaviorIds.includes(id));
}

/** What a block holds, from the plan's items: its preventive strategies, replacements and management entries, rejected ones left out. */
export function blockContent(plan: PlanView, fn: string) {
  const live = <T extends { decision: string }>(items: readonly T[]) => items.filter((item) => !isRejected(item));
  return {
    preventive: live(plan.parts.strategies.items).filter((strategy) => strategy.kind === "antecedent" && strategy.functions.includes(fn)),
    replacements: live(plan.parts.programs.items).filter((program) => program.kind === "replacement" && program.function === fn),
    positive: live(plan.parts.interventions.items).filter((entry) => entry.function === fn && entry.kind === "positive"),
    maladaptive: live(plan.parts.interventions.items).filter((entry) => entry.function === fn && entry.kind === "maladaptive"),
  };
}

/**
 * What leaves the plan (proposal §3.2): the accepted items of the version shown, with the
 * references pruned. A management entry keeps only accepted strategies; a glossary entry goes
 * only when its strategy is accepted too. The copy view, and later the report and the
 * evaluation, read only this.
 */
export function acceptedPlan(plan: PlanView) {
  const strategies = plan.parts.strategies.items.filter(isAccepted);
  const accepted = new Set(strategies.map((strategy) => strategy.id));
  return {
    strategies,
    management: plan.parts.interventions.items.filter(isAccepted).map((entry) => ({ ...entry, strategyIds: entry.strategyIds.filter((id) => accepted.has(id)) })),
    programs: plan.parts.programs.items.filter(isAccepted),
    glossary: plan.parts.glossary.items.filter((entry) => isAccepted(entry) && accepted.has(entry.strategyId)),
    caregiverGoals: plan.parts.caregiverGoals.items.filter(isAccepted),
  };
}
export type AcceptedPlan = ReturnType<typeof acceptedPlan>;
