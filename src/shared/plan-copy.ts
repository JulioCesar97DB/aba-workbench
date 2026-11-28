/*
 * Copy for ABA Matrix, field by field (D22, D23; proposal §1): plain text that code renders
 * from her accepted plan only (acceptedPlan), in the order she pastes:
 *
 * - 11 Replacement Behaviors Info and 12 Skills Acquisition Info: per program, its name,
 *   definition, procedure (numbered steps, then its targets) and baseline; its measure and
 *   mastery criterion are shown as values she enters;
 * - 14 Hypothesis Based Interventions: the intro, then per function block one field per
 *   column (Behaviors, Preventive Strategies, Replacement Skills, Management Strategies),
 *   and "the whole block" (reading 5, until her paste test says how ABA Matrix's fields are);
 * - 15 Interventions: the glossary, alphabetical, one field;
 * - 16 Family/Caregiver Involvement: per goal, its title, procedure and baseline.
 *
 * Tables 9 and the STO/LTO ladders are never written: ABA Matrix builds them. No markdown.
 * The same function runs in the main process (what goes to the clipboard, and the copied
 * marks' fingerprints) and in the interface (what it shows), so the two always agree.
 */

import { FUNCTION_NAMES, type FunctionName } from "./case-map.ts";
import { byName, caregiverBaseline, masteryPercent, CAREGIVER_MASTERY, skillBaseline } from "./plan-compute.ts";
import { acceptedPlan, entryCovers, fingerprint, functionBlocks, HBI_INTRO_DRAFT, isAccepted, type PlanMapInput, type PlanView, type ProgramItem } from "./plan.ts";

/** Her functions' names as ABA Matrix writes them. */
export const FUNCTION_TITLES: Readonly<Record<FunctionName, string>> = {
  tangibles: "Tangibles",
  attention: "Attention",
  escape: "Escape",
  sensory: "Sensory",
  automatic: "Automatic Reinforcement",
};

const MEASURE_TITLES: Readonly<Record<string, string>> = {
  "percent-opportunities": "Percentage of opportunities",
  "task-analysis-steps": "Percentage of task analysis steps completed independently",
  duration: "Duration",
};

export interface CopyField {
  /** Stable id: what the copied mark is stored under. */
  id: string;
  /** Its name in ABA Matrix ("Definition", "Management Strategies"). */
  label: string;
  text: string;
  /** [MISSING: ...] and [CHECK: ...] markers in it. */
  markers: number;
}

export interface CopyGroup {
  id: string;
  /** The ABA Matrix section number: 11, 12, 14, 15 or 16. */
  section: 11 | 12 | 14 | 15 | 16;
  /** Its name, in English (a program's title, a function's name, "Glossary"). */
  label: string;
  fields: CopyField[];
  /** Values she types in ABA Matrix herself (a program's measure and mastery criterion). */
  values: Array<{ label: string; value: string }>;
  /** A function block: all its fields in one text ("Copiar el bloque entero"). */
  whole: string | null;
}

export interface PlanCopyInput {
  plan: PlanView;
  map: PlanMapInput;
  /** The HBI intro she confirmed, or null: our draft is used, marked to confirm. */
  hbiIntro: string | null;
}

const MARKER = /\[(?:MISSING|CHECK):/gu;
const markersIn = (value: string) => value.match(MARKER)?.length ?? 0;
const value = (claim: { value: string } | null | undefined) => claim?.value.trim() ?? "";
const or = (text: string, missing: string) => (text === "" ? `[MISSING: ${missing}]` : text);
const field = (id: string, label: string, text: string): CopyField => ({ id, label, text, markers: markersIn(text) });

/** A program's baseline as the sentence she pastes. */
export function baselineSentence(program: ProgramItem): string {
  const baseline = skillBaseline(program.baseline);
  if (baseline.percent === null) return baseline.unreadable ? "[MISSING: baseline; a session's counts are not plain numbers]" : "[MISSING: baseline]";
  if (baseline.source === "caregiver") return `A baseline of ${baseline.percent}%, per the caregiver's report. [CHECK: not measured in session]`;
  return `A baseline of ${baseline.percent}%.`;
}

function procedureText(program: ProgramItem): string {
  const steps = program.procedure.map(value).filter((step) => step !== "");
  const targets = program.targets.map(value).filter((target) => target !== "");
  const lines = steps.map((step, index) => `${index + 1}. ${step}`);
  if (targets.length > 0) lines.push(`Targets: ${targets.join("; ")}.`);
  return or(lines.join("\n"), "procedure");
}

export function planCopy(input: PlanCopyInput): CopyGroup[] {
  const accepted = acceptedPlan(input.plan);
  const groups: CopyGroup[] = [];

  for (const kind of ["replacement", "skill"] as const) {
    for (const program of accepted.programs.filter((item) => item.kind === kind)) {
      const mastery = masteryPercent(program.mastery.category, program.mastery.override?.value);
      groups.push({
        id: program.id,
        section: kind === "replacement" ? 11 : 12,
        label: value(program.title) || program.id,
        fields: [
          field(`${program.id}:name`, "Name", or(value(program.title), "name")),
          field(`${program.id}:definition`, "Definition", or(value(program.definition), "definition")),
          field(`${program.id}:procedure`, "Procedure", procedureText(program)),
          field(`${program.id}:baseline`, "Baseline", baselineSentence(program)),
        ],
        values: [
          { label: "Measure", value: MEASURE_TITLES[program.measure] ?? MEASURE_TITLES["percent-opportunities"] },
          { label: "Mastery criterion", value: `${mastery.percent}%` },
        ],
        whole: null,
      });
    }
  }

  const blocks = functionBlocks(input.map);
  const intro = input.hbiIntro?.trim() || `${HBI_INTRO_DRAFT} [CHECK: confirm the intro]`;
  const blockGroups: CopyGroup[] = [];
  const strategyName = new Map(accepted.strategies.map((strategy) => [strategy.id, value(strategy.name) || strategy.id]));
  for (const block of blocks) {
    const fn = block.function;
    const preventive = accepted.strategies.filter((strategy) => strategy.kind === "antecedent" && strategy.functions.includes(fn));
    const replacements = accepted.programs.filter((program) => program.kind === "replacement" && program.function === fn);
    const positive = accepted.management.filter((entry) => entry.function === fn && entry.kind === "positive");
    const maladaptive = accepted.management.filter((entry) => entry.function === fn && entry.kind === "maladaptive");
    if (preventive.length + replacements.length + positive.length + maladaptive.length === 0) continue;
    // Entries in the order of the block's behaviors and groups; any other after them.
    const ordered = [
      ...block.units.flatMap((unit) => maladaptive.filter((entry) => entryCovers(entry, unit)).map((entry) => ({ entry, name: unit.name }))),
      ...maladaptive.filter((entry) => !block.units.some((unit) => entryCovers(entry, unit))).map((entry) => ({ entry, name: entry.behaviorIds.map((id) => block.behaviors.find((behavior) => behavior.id === id)?.name ?? id).join("; ") })),
    ];
    const management: string[] = [];
    if (positive.length > 0) management.push(`Positive:\n${positive.map((entry) => or(value(entry.text), "Positive")).join("\n")}`);
    if (ordered.length > 0) management.push(`Maladaptive:\n${ordered.map(({ entry, name }) => `${name}: ${or(value(entry.text), "management")}`).join("\n\n")}`);
    const fields = [
      field(`hbi:${fn}:behaviors`, "Behaviors", block.behaviors.map((behavior) => behavior.name).join(", ")),
      field(`hbi:${fn}:preventive`, "Preventive Strategies", or(preventive.map((strategy) => strategyName.get(strategy.id)!).join("\n"), "preventive strategies")),
      field(`hbi:${fn}:replacement`, "Replacement Skills", or(replacements.map((program) => value(program.title) || program.id).join("\n"), "replacement skills")),
      field(`hbi:${fn}:management`, "Management Strategies", or(management.join("\n\n"), "management strategies")),
    ];
    blockGroups.push({ id: `hbi:${fn}`, section: 14, label: FUNCTION_TITLES[fn], fields, values: [], whole: fields.map((item) => `${item.label}:\n${item.text}`).join("\n\n") });
  }
  if (blockGroups.length > 0) {
    groups.push({ id: "hbi-intro", section: 14, label: "Introduction", fields: [field("hbi-intro", "Introduction", intro)], values: [], whole: null });
    groups.push(...blockGroups.sort((a, b) => FUNCTION_NAMES.indexOf(a.id.slice(4) as FunctionName) - FUNCTION_NAMES.indexOf(b.id.slice(4) as FunctionName)));
  }

  const entries = byName(accepted.glossary, (entry) => strategyName.get(entry.strategyId) ?? "");
  if (entries.length > 0) {
    const glossary = entries.map((entry) => `${strategyName.get(entry.strategyId)}: ${[value(entry.definition), value(entry.implementation)].filter((part) => part !== "").join(" ") || "[MISSING: entry]"}`).join("\n\n");
    groups.push({ id: "glossary", section: 15, label: "Glossary", fields: [field("glossary", "Interventions", glossary)], values: [], whole: null });
  }

  for (const goal of accepted.caregiverGoals) {
    const baseline = caregiverBaseline(goal.baselinePercent?.value);
    const mastery = masteryPercent("general", goal.masteryOverride?.value ?? String(CAREGIVER_MASTERY));
    groups.push({
      id: goal.id,
      section: 16,
      label: value(goal.title) || goal.id,
      fields: [
        field(`${goal.id}:title`, "Title", or(value(goal.title), "title")),
        field(`${goal.id}:procedure`, "Procedure", or(value(goal.procedure), "procedure")),
        field(`${goal.id}:baseline`, "Baseline", baseline === null ? "[MISSING: baseline]" : `A baseline of ${baseline.percent}%.${baseline.check ? " [CHECK: the caregivers were trained before]" : ""}`),
      ],
      values: [{ label: "Mastery criterion", value: `${mastery.percent}%` }],
      whole: null,
    });
  }
  return groups;
}

/** Whether a field is copied as it is now: its mark's fingerprint is the text's. */
export function isCopied(plan: PlanView, item: CopyField): boolean {
  return plan.copied[item.id]?.fingerprint === fingerprint(item.text);
}

/** Items she has not decided yet: they are not copied, and the copy view says how many. */
export function undecidedCount(plan: PlanView): number {
  let count = 0;
  for (const part of ["strategies", "interventions", "programs", "glossary", "caregiverGoals"] as const) {
    for (const item of plan.parts[part].items) if (!isAccepted(item) && item.decision !== "rejected") count++;
  }
  return count;
}
