import type { CaseMapSummary } from "../../shared/case-map.ts";
import { REPORT_SECTIONS } from "../../shared/report-sections.ts";
import type { SectionSummary } from "../../shared/sections.ts";
import type { CaseStep } from "./steps.ts";

/*
 * How far each step of a case is, for the sidebar (owner's decision T18): computed from the
 * case's data, nothing stored. No React here, so the rules are tested on their own
 * (tests/step-states.test.ts).
 */

export type StepState = "done" | "in-progress" | "not-started" | "later";

/** What the steps' states are read from: the case's sources, its map and its sections. */
export interface StepInputs {
  sources: number;
  caseMap: CaseMapSummary;
  sections: ReadonlyArray<Pick<SectionSummary, "state">>;
}

/** The sections that are hers or approved: ready to copy. */
export function readySections(sections: StepInputs["sections"]): number {
  return sections.filter((section) => section.state === "hers" || section.state === "approved").length;
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
    default:
      // Interventions, and Review and copy: not built yet, said so (owner's decision P3).
      return "later";
  }
}

/** The count shown after a step, or none. */
export function stepCount(step: CaseStep, inputs: StepInputs): { shown: string; spoken: { key: "sources" | "caseMap" | "report"; values: Record<string, number> } } | null {
  if (step === "sources" && inputs.sources > 0) return { shown: String(inputs.sources), spoken: { key: "sources", values: { count: inputs.sources } } };
  // The case map: its parts approved, out of the parts with something in them.
  if (step === "case-map" && inputs.caseMap.withContent > 0) {
    return { shown: `${inputs.caseMap.approved}/${inputs.caseMap.withContent}`, spoken: { key: "caseMap", values: { approved: inputs.caseMap.approved, total: inputs.caseMap.withContent } } };
  }
  if (step === "report") {
    const done = readySections(inputs.sections);
    return { shown: `${done}/${REPORT_SECTIONS.length}`, spoken: { key: "report", values: { done, total: REPORT_SECTIONS.length } } };
  }
  return null;
}
