import type { CaseMapSummary, MapPartId } from "../../shared/case-map.ts";
import { REPORT_SECTIONS, type ReportSectionId } from "../../shared/report-sections.ts";
import type { SectionState } from "../../shared/sections.ts";
import { stepState, type StepState } from "./step-states.ts";
import { CASE_STEPS, type CaseStep } from "./steps.ts";

/*
 * "Lo siguiente": the one next thing to do in a case (owner's proposal §6, decisions T7 and
 * P8). Computed from the case's data each time it is shown, nothing stored: the case
 * summary's card, Home's "Sigue donde lo dejaste" and its "Continuar" all read it. No React
 * here, so the rule is tested case by case on its own (tests/next-thing.test.ts).
 *
 * In order, the first that applies:
 *   1. a change that could not be saved;
 *   2. no document;
 *   3. a section with an AI draft not approved (the first in ABA Matrix's order);
 *   4. a part of the case map with content, not approved (once the map has content);
 *   5. no case map and no section yet;
 *   6. the first section in ABA Matrix's order not started;
 *   7. (UX-7) approved sections not copied yet: copied marks do not exist yet (T8 arrives with
 *      Revisión y copia), so this rule is left out. UX-7 adds `copied` to the sections' inputs
 *      and one entry to RULES, between "start-section" and the end;
 *   8. everything done.
 */

export interface NextInputs {
  /** Whether a change to the case could not be saved (case-saves.tsx keeps it, with "Try again"). */
  unsaved: boolean;
  /** Its documents, not counting removed ones. */
  sources: number;
  caseMap: CaseMapSummary;
  /**
   * The first part of the map with content and not approved, when known. Null when there is
   * none, or when it is not known yet (the summary reads the map after the case): the rule
   * then still says to approve the map, without naming the part.
   */
  mapPartToApprove: MapPartId | null;
  /** The sections' states; a section missing here is not started. */
  sections: ReadonlyArray<{ id: ReportSectionId; state: SectionState }>;
}

export type NextThing =
  | { kind: "unsaved" }
  | { kind: "add-documents" }
  | { kind: "review-draft"; sectionId: ReportSectionId }
  | { kind: "approve-map"; part: MapPartId | null }
  | { kind: "build-map" }
  | { kind: "start-section"; sectionId: ReportSectionId }
  | { kind: "all-ready" };

function stateOf(inputs: NextInputs, id: ReportSectionId): SectionState {
  return inputs.sections.find((section) => section.id === id)?.state ?? "not-started";
}

/** The rules from 2 on, in order; each gives the next thing or passes. Rule 1 (unsaved) is applied by nextThing. */
const RULES: ReadonlyArray<(inputs: NextInputs) => NextThing | null> = [
  (inputs) => (inputs.sources === 0 ? { kind: "add-documents" } : null),
  (inputs) => {
    const draft = REPORT_SECTIONS.find((section) => stateOf(inputs, section.id) === "drafted");
    return draft ? { kind: "review-draft", sectionId: draft.id } : null;
  },
  (inputs) => {
    const { approved, withContent } = inputs.caseMap;
    if (inputs.mapPartToApprove !== null) return { kind: "approve-map", part: inputs.mapPartToApprove };
    return withContent > 0 && approved < withContent ? { kind: "approve-map", part: null } : null;
  },
  (inputs) => (inputs.caseMap.withContent === 0 && REPORT_SECTIONS.every((section) => stateOf(inputs, section.id) === "not-started") ? { kind: "build-map" } : null),
  (inputs) => {
    const first = REPORT_SECTIONS.find((section) => stateOf(inputs, section.id) === "not-started");
    return first ? { kind: "start-section", sectionId: first.id } : null;
  },
  // UX-7: rule 7, "Copia <section> a ABA Matrix", goes here.
];

/** The next thing to do in the case (§6). */
export function nextThing(inputs: NextInputs): NextThing {
  if (inputs.unsaved) return { kind: "unsaved" };
  return workThing(inputs);
}

/** The next piece of work, leaving a change not saved aside: what the case's step is. */
function workThing(inputs: NextInputs): NextThing {
  for (const rule of RULES) {
    const found = rule(inputs);
    if (found) return found;
  }
  return { kind: "all-ready" };
}

/** The step the case is at: the step of its next piece of work, or null once everything is done. */
export function currentStep(inputs: NextInputs): CaseStep | null {
  const thing = workThing(inputs);
  switch (thing.kind) {
    case "add-documents":
      return "sources";
    case "approve-map":
    case "build-map":
      return "case-map";
    case "review-draft":
    case "start-section":
      return "report";
    default:
      return null;
  }
}

/** Where the next thing is done: an address inside the case, or the case's summary itself for a change not saved. */
export function nextThingPath(caseId: string, thing: NextThing): string {
  const base = `/cases/${caseId}`;
  switch (thing.kind) {
    case "unsaved":
      return base;
    case "add-documents":
      return `${base}/sources`;
    case "review-draft":
    case "start-section":
      return `${base}/report/${thing.sectionId}`;
    case "approve-map":
      return thing.part ? `${base}/case-map?part=${thing.part}` : `${base}/case-map`;
    case "build-map":
      return `${base}/case-map`;
    case "all-ready":
      return `${base}/report`;
  }
}

/** Each step's state, in order, for Home's five-segment bar (the sidebar's states, step-states.ts). */
export function stepStates(inputs: Pick<NextInputs, "sources" | "caseMap" | "sections">): Array<{ step: CaseStep; state: StepState }> {
  return CASE_STEPS.map((step) => ({ step, state: stepState(step, inputs) }));
}

/** Whether every step built so far is done: the case's last "Lo siguiente" (rule 8). */
export function everythingDone(inputs: NextInputs): boolean {
  return workThing(inputs).kind === "all-ready";
}

/**
 * The case she worked on last, for Home's "Sigue donde lo dejaste": the one saved last (its
 * data file's updatedAt, which every save moves on). Nothing more is stored to know it (T7).
 * Of two saved at the same moment, the first listed (the newer).
 */
export function lastCase<T extends { updatedAt: string }>(cases: readonly T[]): T | null {
  let found: T | null = null;
  for (const item of cases) if (!found || Date.parse(item.updatedAt) > Date.parse(found.updatedAt)) found = item;
  return found;
}
