import type { CaseMapSummary } from "../../shared/case-map.ts";
import type { PlanSummary } from "../../shared/plan.ts";
import { REPORT_SECTIONS } from "../../shared/report-sections.ts";
import type { SectionSummary } from "../../shared/sections.ts";
import type { CaseStep } from "./steps.ts";

/*
 * How far each step of a case is, for the sidebar (owner's decision T18): computed from the
 * case's data, nothing stored. No React here, so the rules are tested on their own
 * (tests/step-states.test.ts).
 */

export type StepState = "done" | "in-progress" | "not-started" | "later";

/** What the steps' states are read from: the case's sources, its map, its plan and its sections. */
export interface StepInputs {
  sources: number;
  caseMap: CaseMapSummary;
  /** Its plan's items decided, out of its items; absent where it is not known (read as none). */
  plan?: PlanSummary;
  sections: ReadonlyArray<Pick<SectionSummary, "state" | "copied">>;
}

/** The sections that are hers or approved: ready to copy. */
export function readySections(sections: ReadonlyArray<Pick<SectionSummary, "state">>): number {
  return sections.filter((section) => section.state === "hers" || section.state === "approved").length;
}

/** The sections copied for ABA Matrix as they are now (owner's decision T8). */
export function copiedSections(sections: ReadonlyArray<Pick<SectionSummary, "copied">>): number {
  return sections.filter((section) => section.copied).length;
}

export function stepState(step: CaseStep, inputs: StepInputs): StepState {
  switch (step) {
    case "sources":
      return inputs.sources > 0 ? "done" : "not-started";
    case "case-map":
      if (inputs.caseMap.withContent === 0) return "not-started";
      return inputs.caseMap.approved === inputs.caseMap.withContent ? "done" : "in-progress";
    case "report":
      if (readySections(inputs.sections) === REPORT_SECTIONS.length) return "done";
      return inputs.sections.some((section) => section.state !== "not-started") ? "in-progress" : "not-started";
    case "review": {
      // Done once every section is copied as it is now; under way from the first copy.
      const copied = copiedSections(inputs.sections);
      if (copied === REPORT_SECTIONS.length) return "done";
      return copied > 0 ? "in-progress" : "not-started";
    }
    case "interventions": {
      // The plan (step 3): done once every item is decided (accepted or rejected), under way from the first item.
      const plan = inputs.plan ?? { decided: 0, total: 0 };
      if (plan.total === 0) return "not-started";
      return plan.decided === plan.total ? "done" : "in-progress";
    }
    default:
      return "later";
  }
}

/** The count shown after a step, or none. */
export function stepCount(step: CaseStep, inputs: StepInputs): { shown: string; spoken: { key: "sources" | "caseMap" | "plan" | "report" | "review"; values: Record<string, number> } } | null {
  if (step === "sources" && inputs.sources > 0) return { shown: String(inputs.sources), spoken: { key: "sources", values: { count: inputs.sources } } };
  // The case map: its parts approved, out of the parts with something in them.
  if (step === "case-map" && inputs.caseMap.withContent > 0) {
    return { shown: `${inputs.caseMap.approved}/${inputs.caseMap.withContent}`, spoken: { key: "caseMap", values: { approved: inputs.caseMap.approved, total: inputs.caseMap.withContent } } };
  }
  // The plan: its items decided, out of its items (mockup 03: "18/102").
  if (step === "interventions" && inputs.plan && inputs.plan.total > 0) {
    return { shown: `${inputs.plan.decided}/${inputs.plan.total}`, spoken: { key: "plan", values: { decided: inputs.plan.decided, total: inputs.plan.total } } };
  }
  if (step === "report") {
    const done = readySections(inputs.sections);
    return { shown: `${done}/${REPORT_SECTIONS.length}`, spoken: { key: "report", values: { done, total: REPORT_SECTIONS.length } } };
  }
  // Review and copy: the sections copied, once there is one to copy (mockup 10: "6/9").
  if (step === "review" && (readySections(inputs.sections) > 0 || copiedSections(inputs.sections) > 0)) {
    const copied = copiedSections(inputs.sections);
    return { shown: `${copied}/${REPORT_SECTIONS.length}`, spoken: { key: "review", values: { copied, total: REPORT_SECTIONS.length } } };
  }
  return null;
}
