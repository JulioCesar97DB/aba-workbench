/** The five steps of a case, in order. Their path is also their id. No React here: the step states' test reads it (tests/step-states.test.ts). */
export const CASE_STEPS = ["sources", "case-map", "interventions", "report", "review"] as const;
export type CaseStep = (typeof CASE_STEPS)[number];
