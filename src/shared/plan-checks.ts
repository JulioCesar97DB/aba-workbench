/*
 * The plan's code checks (proposal §5; D19 to D21): what the code catches in the plan before
 * her agency's QA does. Free, run on every plan item that is not rejected, hers included,
 * after every change, and soft: they only flag, she can accept with them open, and nothing is
 * ever rewritten. The AI review (PR 2) catches the subtle cases.
 *
 * Kept cautious on purpose (the T2 and T3 lesson): when the code cannot read a number, a
 * threshold or a role plainly, it says nothing.
 *
 * - Clash (D20): a prompt delay or wait shorter than a behavior's latency (the behavior could
 *   never be scored), a delivery after calm shorter than its offset (the episode is not over),
 *   a proximity distance larger than its elopement distance; only for items linked to the
 *   behavior through its blocks, and only parameters whose role says what they are.
 * - Replacement (§5.2): a block with no functionally equivalent replacement, or one whose
 *   outcome is "other" (check it).
 * - Extinction and punishment (D21): her never-list plus the names of extinction and
 *   punishment, in English and in Spanish, on every plan text; a name inside a negation ("no
 *   extinction is used", "instead of time-out") is not flagged.
 * - The cheap ones of §5.4: management entries per behavior or group, the safety step first,
 *   glossary coverage and numbers, the "Implementation:" label, varied openings, task
 *   analyses of 4 to 6 steps, baselines in multiples of 10.
 */

import { FUNCTION_NAMES, type FunctionName } from "./case-map.ts";
import { thresholdPairs } from "./case-map-thresholds.ts";
import { plainNumber, parameterFeet, parameterSeconds } from "./plan-compute.ts";
import {
  EQUIVALENT_OUTCOMES,
  blockContent,
  entryCovers,
  functionBlocks,
  isRejected,
  strategyFingerprint,
  type PlanMapInput,
  type PlanParameter,
  type PlanPartId,
  type PlanView,
} from "./plan.ts";

export interface ItemRef {
  part: PlanPartId;
  id: string;
}

/** Where a finding is looked at: a function's block, the programs, the glossary or the caregiver goals. */
export type PlanViewId = `fn:${FunctionName}` | "programs" | "glossary" | "goals";

export type PlanFinding = { view: PlanViewId; function: FunctionName | null } & (
  | { kind: "prompt-before-latency"; behaviorName: string; latency: number; item: ItemRef; itemName: string; label: string; seconds: number }
  | { kind: "delivery-before-offset"; behaviorName: string; offset: number; item: ItemRef; itemName: string; label: string; seconds: number }
  | { kind: "proximity-beyond-elopement"; behaviorName: string; elopementFeet: number; item: ItemRef; itemName: string; label: string; feet: number }
  | { kind: "no-replacement" }
  | { kind: "no-equivalent-replacement"; programs: Array<{ item: ItemRef; name: string; outcome: string | null }> }
  | { kind: "replacement-outcome-other"; item: ItemRef; itemName: string }
  | { kind: "aversive"; item: ItemRef; itemName: string; term: string }
  | { kind: "no-management"; unitName: string }
  | { kind: "two-management"; unitName: string; items: ItemRef[] }
  | { kind: "safety-first-missing"; unitName: string; item: ItemRef }
  | { kind: "glossary-missing"; item: ItemRef; itemName: string }
  | { kind: "glossary-orphan"; item: ItemRef }
  | { kind: "glossary-number"; item: ItemRef; itemName: string; number: string }
  | { kind: "glossary-stale"; item: ItemRef; itemName: string }
  | { kind: "implementation-label"; item: ItemRef; itemName: string }
  | { kind: "few-openings"; distinct: number; total: number }
  | { kind: "task-analysis-steps"; item: ItemRef; itemName: string; steps: number }
  | { kind: "baseline-not-ten"; item: ItemRef; itemName: string; percent: number }
);

export type PlanFindingKind = PlanFinding["kind"];

/** The four groups of the "Antes de QA" view, in its order. */
export const FINDING_GROUPS = ["clash", "replacement", "aversive", "other"] as const;
export type FindingGroup = (typeof FINDING_GROUPS)[number];

export function findingGroup(kind: PlanFindingKind): FindingGroup {
  if (kind === "prompt-before-latency" || kind === "delivery-before-offset" || kind === "proximity-beyond-elopement") return "clash";
  if (kind === "no-replacement" || kind === "no-equivalent-replacement" || kind === "replacement-outcome-other") return "replacement";
  if (kind === "aversive") return "aversive";
  return "other";
}

/** The items a finding is about, so the item's card can show it. */
export function findingItems(finding: PlanFinding): ItemRef[] {
  if ("item" in finding) return [finding.item];
  if ("items" in finding) return finding.items;
  if (finding.kind === "no-equivalent-replacement") return finding.programs.map((program) => program.item);
  return [];
}

/** A behavior as the checks read it from the map: its name and the texts its thresholds are in. */
export interface CheckedMapBehavior {
  id: string;
  name: { value: string } | null;
  definition: { value: string } | null;
  onset: { value: string } | null;
  offset: { value: string } | null;
}

export interface PlanCheckInput {
  plan: PlanView;
  map: Omit<PlanMapInput, "behaviors"> & { behaviors: ReadonlyArray<PlanMapInput["behaviors"][number] & CheckedMapBehavior> };
  /** The HBI intro she confirmed, when she did: her text is checked too. */
  hbiIntro?: string | null;
}

const text = (claim: { value: string } | null | undefined) => claim?.value ?? "";

/* Thresholds of a behavior, read only when plain */

const LATENCY_CUE =
  /(?:\b(?:within|after|in)\s+\d|\bwithout\s+(?:starting|beginning|responding|initiating|complying)|\b(?:does\s+not|doesn't|did\s+not|fails?\s+to|no)\s+(?:begin|start|respond|initiat|comply)|\blatency\b|\bdentro\s+de\b|\ben\s+(?:los\s+)?\d|\bsin\s+(?:empezar|iniciar|responder|comenzar)|\bno\s+(?:empieza|inicia|comienza|responde))/iu;
const OFFSET_CUE = /\b(?:stopped|stops|ceased|ceases|no\s+longer|has\s+not\s+occurred|without\s+the\s+behavior|in\s+a\s+row|consecutive|ends?\s+when|termina|ha\s+parado|sin\s+la\s+conducta|seguidos)\b/iu;
const ELOPEMENT = /\b(?:elop\w*|runs?\s+away|running\s+away|ran\s+away|bolt\w*|fuga\w*|se\s+escapa|escaparse)\b/iu;

/** The one value in seconds the clauses give, or null when none or more than one. */
function oneSeconds(clauses: readonly string[]): number | null {
  const values = new Set<number>();
  for (const clause of clauses) {
    for (const pair of thresholdPairs(clause)) {
      if (pair.unit === "s") values.add(Number(pair.value));
      if (pair.unit === "min") values.add(Number(pair.value) * 60);
    }
  }
  return values.size === 1 ? [...values][0] : null;
}

const clausesOf = (value: string) => value.split(/[.;\n]/u).filter((clause) => clause.trim() !== "");

/** The behavior's latency: seconds without starting, from its onset or its definition, when the text says so plainly. */
export function latencySeconds(behavior: CheckedMapBehavior): number | null {
  const clauses = [...clausesOf(text(behavior.onset)), ...clausesOf(text(behavior.definition))].filter((clause) => LATENCY_CUE.test(clause));
  return oneSeconds(clauses);
}

/** The behavior's offset: seconds without the behavior that end an episode, from its offset (or its definition's ending clause). */
export function offsetSeconds(behavior: CheckedMapBehavior): number | null {
  const offset = clausesOf(text(behavior.offset));
  if (offset.length > 0) return oneSeconds(offset);
  return oneSeconds(clausesOf(text(behavior.definition)).filter((clause) => OFFSET_CUE.test(clause)));
}

/** An elopement's distance in feet, from its definition or onset, when the behavior is an elopement and gives one distance. */
export function elopementFeet(behavior: CheckedMapBehavior): number | null {
  if (!ELOPEMENT.test(`${text(behavior.name)} ${text(behavior.definition)}`)) return null;
  const values = new Set<number>();
  for (const clause of [...clausesOf(text(behavior.definition)), ...clausesOf(text(behavior.onset))]) {
    for (const pair of thresholdPairs(clause)) {
      if (pair.unit === "ft") values.add(Number(pair.value));
      if (pair.unit === "m") values.add(Math.round(Number(pair.value) * 3.281 * 10) / 10);
    }
  }
  return values.size === 1 ? [...values][0] : null;
}

/* Extinction and punishment (D21) */

const B = "(?<!\\p{L})";
const E = "(?!\\p{L})";
/** Her never-list (rules/interventions.md) and the names of extinction and punishment, English then Spanish. */
const AVERSIVE_TERMS: ReadonlyArray<{ term: string; pattern: RegExp }> = [
  ["extinction", `(?:escape\\s+|sensory\\s+|attention\\s+|automatic\\s+)?extinction`],
  ["punishment", `punish(?:ment|ments|ing|ed|es)?`],
  ["time-out", `time[\\s-]?outs?`],
  ["response cost", `response[\\s-]+cost`],
  ["overcorrection", `over[\\s-]?correct(?:ion|ing|ed)?`],
  ["planned ignoring", `planned[\\s-]+ignoring`],
  ["response blocking", `response[\\s-]+blocking`],
  ["hand-over-hand", `hand[\\s-]+over[\\s-]+hand`],
  ["physical guidance to force", `physical(?:ly)?\\s+guid(?:e|ed|es|ing|ance)[^.;:]{0,40}?\\bforc(?:e|es|ed|ing)`],
  ["restraint", `(?<!self[\\s-])restrain(?:t|ts|ed|ing|s)?`],
  ["seclusion", `seclu(?:sion|de|ded)`],
  ["reprimand", `reprimand(?:s|ed|ing)?`],
  ["ignore the behavior", `ignor(?:e|es|ed|ing)\\s+(?:the|his|her|their|this)\\s+(?:behavior|tantrums?|crying|screaming|whining)`],
  ["do not allow escape", `(?:do(?:es)?\\s+not|don't|doesn't|never)\\s+(?:allow|permit|let)\\b[^.;:]{0,30}?\\bescap(?:e|ing)`],
  ["remove the privilege", `(?:remov|tak)(?:e|es|ed|ing)\\s+(?:away\\s+)?(?:a|the|his|her|their)?\\s*privileges?|loss\\s+of\\s+privileges?`],
  ["extinción", `extinci[oó]n`],
  ["castigo", `castig(?:o|os|ar|a|ado)`],
  ["tiempo fuera", `tiempo[\\s-]+fuera`],
  ["costo de respuesta", `cost[oe]\\s+de\\s+(?:la\\s+)?respuesta`],
  ["sobrecorrección", `sobre[\\s-]?correcci[oó]n`],
  ["ignorar planificado", `ignor(?:ar|ado)\\s+(?:planificado|planeado|de\\s+forma\\s+planificada)`],
  ["bloqueo de respuesta", `bloqueo\\s+de\\s+(?:la\\s+)?respuesta`],
  ["mano sobre mano", `mano\\s+sobre\\s+mano`],
  ["restricción física", `(?:restricci[oó]n|contenci[oó]n|sujeci[oó]n)\\s+f[ií]sica`],
  ["aislamiento", `aislamiento`],
  ["reprimenda", `reprimenda|rega[nñ](?:o|os|ar|arlo|arla)`],
  ["ignorar la conducta", `ignorar\\s+(?:la|su)\\s+(?:conducta|rabieta|berrinche)`],
  ["no permitir el escape", `no\\s+(?:permitir|dejar)\\b[^.;:]{0,30}?\\bescap\\p{L}*`],
  ["quitar privilegios", `(?:quit|retir)(?:ar|a|an|ó|aron|ará|arán)(?:le|les)?\\s+(?:el|los|un|sus)?\\s*privilegios?|p[eé]rdida\\s+de\\s+privilegios?`],
].map(([term, source]) => ({ term, pattern: new RegExp(`${B}(?:${source})${E}`, "giu") }));

/** A negation just before a name in its clause: the name is said not to be used. */
const NEGATION_BEFORE =
  /(?:\b(?:no|not|never|without|avoid|avoids|avoided|avoiding|instead\s+of|rather\s+than|other\s+than|excluding|except|nor|neither|nunca|sin|ni|evita|evitar|evitando|en\s+lugar\s+de|en\s+vez\s+de|excepto)\b|n't)[^.;:!?]{0,40}$/iu;
/** A negation right after it: "extinction is not used", "time-out will never be used", "no se usa". */
const NEGATION_AFTER = /^[\s,)"']*(?:(?:is|are|was|were|will|would|should|shall|must|can|may)\s+)?(?:not|never|no)\s+(?:be\s+)?(?:used|implemented|applied|included|recommended|part|an?\s+option|considered)|^[\s,)"']*(?:is|are)\s+(?:never|not)\b|^[\s,)"']*(?:no|nunca)\s+(?:se\s+)?(?:usa|utiliza|aplica|emplea|incluye|recomienda)/iu;

/** The first name of her never-list a text uses, not inside a negation; null when none. */
export function aversiveTerm(value: string): string | null {
  for (const { term, pattern } of AVERSIVE_TERMS) {
    pattern.lastIndex = 0;
    for (const match of value.matchAll(pattern)) {
      const at = match.index ?? 0;
      const before = value.slice(0, at);
      const clauseStart = Math.max(before.lastIndexOf("."), before.lastIndexOf(";"), before.lastIndexOf(":"), before.lastIndexOf("\n"), before.lastIndexOf("!"), before.lastIndexOf("?"));
      const clause = before.slice(clauseStart + 1);
      // "Do not allow escape" carries its own "not": only what comes before it can negate it.
      if (NEGATION_BEFORE.test(clause)) continue;
      if (NEGATION_AFTER.test(value.slice(at + match[0].length))) continue;
      return term;
    }
  }
  return null;
}

/* The checks */

const nameOf = (claim: { value: string } | null | undefined, fallback: string) => claim?.value.trim() || fallback;

export function planChecks(input: PlanCheckInput): PlanFinding[] {
  const { plan, map } = input;
  const findings: PlanFinding[] = [];
  const blocks = functionBlocks(map);
  const strategies = plan.parts.strategies.items.filter((item) => !isRejected(item));
  const strategyById = new Map(strategies.map((strategy) => [strategy.id, strategy]));
  const programs = plan.parts.programs.items.filter((item) => !isRejected(item));
  const glossary = plan.parts.glossary.items.filter((item) => !isRejected(item));
  const behaviorsById = new Map(map.behaviors.map((behavior) => [behavior.id, behavior]));
  const strategyName = (id: string) => nameOf(strategyById.get(id)?.name, id);

  for (const block of blocks) {
    const fn = block.function;
    const view = `fn:${fn}` as const;
    const content = blockContent(plan, fn);

    // Clashes (D20): the block's preventive strategies, the strategies of the entries that cover the behavior, and the block's replacements.
    for (const behavior of block.behaviors) {
      const checked = behaviorsById.get(behavior.id);
      if (!checked) continue;
      const latency = latencySeconds(checked);
      const offset = offsetSeconds(checked);
      const elopement = elopementFeet(checked);
      if (latency === null && offset === null && elopement === null) continue;
      const linked: Array<{ item: ItemRef; name: string; parameters: readonly PlanParameter[] }> = [];
      const seen = new Set<string>();
      const link = (part: PlanPartId, id: string, name: string, parameters: readonly PlanParameter[]) => {
        if (seen.has(id)) return;
        seen.add(id);
        linked.push({ item: { part, id }, name, parameters });
      };
      for (const strategy of content.preventive) link("strategies", strategy.id, nameOf(strategy.name, strategy.id), strategy.parameters);
      for (const entry of [...content.positive, ...content.maladaptive]) {
        if (entry.kind === "maladaptive" && !entry.behaviorIds.includes(behavior.id)) continue;
        for (const id of entry.strategyIds) {
          const strategy = strategyById.get(id);
          if (strategy) link("strategies", id, nameOf(strategy.name, id), strategy.parameters);
        }
      }
      for (const program of content.replacements) link("programs", program.id, nameOf(program.title, program.id), program.parameters);
      for (const { item, name, parameters } of linked) {
        for (const parameter of parameters) {
          if (parameter.role === "prompt-delay" && latency !== null) {
            const seconds = parameterSeconds(parameter);
            if (seconds !== null && seconds < latency) findings.push({ view, function: fn, kind: "prompt-before-latency", behaviorName: behavior.name, latency, item, itemName: name, label: parameter.label, seconds });
          }
          if (parameter.role === "calm-before-delivery" && offset !== null) {
            const seconds = parameterSeconds(parameter);
            if (seconds !== null && seconds < offset) findings.push({ view, function: fn, kind: "delivery-before-offset", behaviorName: behavior.name, offset, item, itemName: name, label: parameter.label, seconds });
          }
          if (parameter.role === "proximity" && elopement !== null) {
            const feet = parameterFeet(parameter);
            if (feet !== null && feet > elopement) findings.push({ view, function: fn, kind: "proximity-beyond-elopement", behaviorName: behavior.name, elopementFeet: elopement, item, itemName: name, label: parameter.label, feet });
          }
        }
      }
    }

    // A functionally equivalent replacement for every function (§5.2).
    const fitting = content.replacements.filter((program) => program.outcome !== null && (EQUIVALENT_OUTCOMES[fn] as readonly string[]).includes(program.outcome));
    if (content.replacements.length === 0) findings.push({ view, function: fn, kind: "no-replacement" });
    else if (fitting.length === 0) {
      const others = content.replacements.filter((program) => program.outcome !== "other");
      if (others.length > 0)
        findings.push({ view, function: fn, kind: "no-equivalent-replacement", programs: others.map((program) => ({ item: { part: "programs", id: program.id }, name: nameOf(program.title, program.id), outcome: program.outcome })) });
    }
    for (const program of content.replacements) {
      if (program.outcome === "other") findings.push({ view, function: fn, kind: "replacement-outcome-other", item: { part: "programs", id: program.id }, itemName: nameOf(program.title, program.id) });
    }

    // One management entry per behavior or group, the safety step first for a dangerous one (§5.4).
    for (const unit of block.units) {
      const entries = content.maladaptive.filter((entry) => entryCovers(entry, unit));
      if (entries.length === 0) findings.push({ view, function: fn, kind: "no-management", unitName: unit.name });
      if (entries.length > 1) findings.push({ view, function: fn, kind: "two-management", unitName: unit.name, items: entries.map((entry) => ({ part: "interventions", id: entry.id })) });
      if (unit.dangerous) for (const entry of entries) if (!entry.safetyFirst) findings.push({ view, function: fn, kind: "safety-first-missing", unitName: unit.name, item: { part: "interventions", id: entry.id } });
    }
  }

  // Extinction and punishment, on every plan text (D21).
  const scan = (part: PlanPartId, id: string, name: string, view: PlanViewId, fn: FunctionName | null, texts: ReadonlyArray<string>) => {
    for (const value of texts) {
      const term = aversiveTerm(value);
      if (term) {
        findings.push({ view, function: fn, kind: "aversive", item: { part, id }, itemName: name, term });
        return;
      }
    }
  };
  const paramTexts = (parameters: readonly PlanParameter[]) => parameters.flatMap((parameter) => [parameter.label, text(parameter.value)]);
  const blockOf = (fn: string | null): { view: PlanViewId; fn: FunctionName | null } =>
    fn && (FUNCTION_NAMES as readonly string[]).includes(fn) ? { view: `fn:${fn as FunctionName}`, fn: fn as FunctionName } : { view: "glossary", fn: null };
  for (const strategy of strategies) {
    const where = strategy.kind === "antecedent" && strategy.functions.length > 0 ? blockOf(strategy.functions[0]) : { view: "glossary" as const, fn: null };
    scan("strategies", strategy.id, nameOf(strategy.name, strategy.id), where.view, where.fn, [text(strategy.name), ...paramTexts(strategy.parameters)]);
  }
  for (const entry of plan.parts.interventions.items.filter((item) => !isRejected(item))) {
    const where = blockOf(entry.function);
    const unitName = entry.behaviorIds.map((id) => nameOf(behaviorsById.get(id)?.name, id)).join("; ") || "Positive";
    scan("interventions", entry.id, entry.kind === "positive" ? "Positive" : unitName, where.view, where.fn, [text(entry.text)]);
  }
  for (const program of programs) {
    scan("programs", program.id, nameOf(program.title, program.id), "programs", null, [text(program.title), text(program.definition), ...program.procedure.map(text), ...program.targets.map(text), ...paramTexts(program.parameters)]);
  }
  for (const entry of glossary) scan("glossary", entry.id, strategyName(entry.strategyId), "glossary", null, [text(entry.definition), text(entry.implementation)]);
  for (const goal of plan.parts.caregiverGoals.items.filter((item) => !isRejected(item))) scan("caregiverGoals", goal.id, nameOf(goal.title, goal.id), "goals", null, [text(goal.title), text(goal.procedure)]);
  if (input.hbiIntro) {
    const term = aversiveTerm(input.hbiIntro);
    if (term) findings.push({ view: "glossary", function: null, kind: "aversive", item: { part: "planInputs", id: "plan" }, itemName: "Hypothesis Based Interventions", term });
  }

  // The glossary (D13, D15; §5.4).
  const entryFor = new Map<string, (typeof glossary)[number]>();
  for (const entry of glossary) if (!entryFor.has(entry.strategyId)) entryFor.set(entry.strategyId, entry);
  for (const strategy of strategies) {
    if (!entryFor.has(strategy.id)) findings.push({ view: "glossary", function: null, kind: "glossary-missing", item: { part: "strategies", id: strategy.id }, itemName: nameOf(strategy.name, strategy.id) });
  }
  const openings = new Set<string>();
  let written = 0;
  for (const entry of glossary) {
    const strategy = strategyById.get(entry.strategyId);
    const item = { part: "glossary" as const, id: entry.id };
    if (!strategy) {
      findings.push({ view: "glossary", function: null, kind: "glossary-orphan", item });
      continue;
    }
    const itemName = nameOf(strategy.name, strategy.id);
    const body = `${text(entry.definition)} ${text(entry.implementation)}`;
    if (/(?:^|\n|\.\s+)\s*implementation\s*:/iu.test(body)) findings.push({ view: "glossary", function: null, kind: "implementation-label", item, itemName });
    if (entry.writtenFrom !== null && entry.writtenFrom !== strategyFingerprint(strategy)) findings.push({ view: "glossary", function: null, kind: "glossary-stale", item, itemName });
    const allowed = strategy.parameters.flatMap((parameter) => {
      const value = plainNumber(text(parameter.value));
      return value === null ? [] : [{ value, unit: parameter.unit }];
    });
    for (const pair of thresholdPairs(body)) {
      const unit = pair.unit === "m" ? null : pair.unit;
      if (unit === null) continue;
      if (!allowed.some((allow) => allow.value === Number(pair.value) && allow.unit === unit)) {
        findings.push({ view: "glossary", function: null, kind: "glossary-number", item, itemName, number: `${pair.value} ${unit}` });
        break;
      }
    }
    const implementation = text(entry.implementation).trim();
    if (implementation !== "") {
      written++;
      openings.add(implementation.split(/\s+/u).slice(0, 2).join(" ").toLowerCase().replace(/[^\p{L}\p{N} ]/gu, ""));
    }
  }
  // Fewer than three openings only matters once the glossary has a few entries.
  if (written >= 5 && openings.size < 3) findings.push({ view: "glossary", function: null, kind: "few-openings", distinct: openings.size, total: written });

  // Programs (§5.4).
  for (const program of programs) {
    const item = { part: "programs" as const, id: program.id };
    const itemName = nameOf(program.title, program.id);
    const steps = program.procedure.filter((step) => step.value.trim() !== "").length;
    if (program.measure === "task-analysis-steps" && steps > 0 && (steps < 4 || steps > 6)) findings.push({ view: "programs", function: null, kind: "task-analysis-steps", item, itemName, steps });
    for (const claim of [program.baseline.caregiverPercent, program.baseline.override]) {
      const percent = plainNumber(claim?.value, { percent: true });
      if (percent !== null && percent % 10 !== 0) {
        findings.push({ view: "programs", function: null, kind: "baseline-not-ten", item, itemName, percent });
        break;
      }
    }
  }
  for (const goal of plan.parts.caregiverGoals.items.filter((item) => !isRejected(item))) {
    const percent = plainNumber(goal.baselinePercent?.value, { percent: true });
    if (percent !== null && percent % 10 !== 0) findings.push({ view: "goals", function: null, kind: "baseline-not-ten", item: { part: "caregiverGoals", id: goal.id }, itemName: nameOf(goal.title, goal.id), percent });
  }
  return findings;
}
