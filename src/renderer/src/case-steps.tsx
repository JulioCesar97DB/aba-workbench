import type { TFunction } from "i18next";
import type { ReactNode } from "react";
import { Term } from "./components/Term.tsx";
import { TERMS } from "./i18n/terms.ts";

import { CASE_STEPS, type CaseStep } from "./steps.ts";

export { CASE_STEPS, type CaseStep };

export function casePath(caseId: string, step: CaseStep = "sources", sectionId?: string): string {
  return sectionId ? `/cases/${caseId}/${step}/${sectionId}` : `/cases/${caseId}/${step}`;
}

/** A pasted text of the case, to read and edit. */
export function sourceTextPath(caseId: string, sourceId: string): string {
  return `/cases/${caseId}/sources/text/${sourceId}`;
}

/** A new pasted text of a type. */
export function newTextPath(caseId: string, type: string): string {
  return `/cases/${caseId}/sources/new/${type}`;
}

/** Interventions is a clinical term: English in both languages. The case map is named in the screen's language ("Mapa del caso"). */
const ENGLISH_STEPS: Partial<Record<CaseStep, string>> = {
  interventions: TERMS.interventions,
};

export function stepTitle(t: TFunction, step: CaseStep): string {
  const english = ENGLISH_STEPS[step];
  if (english) return english;
  if (step === "case-map") return t("steps.caseMap");
  return t(`steps.${step as "sources" | "report" | "review"}`);
}

/** The language of a step's title, for its lang attribute (undefined: the screen's). */
export function stepTitleLang(step: CaseStep): "en" | undefined {
  return ENGLISH_STEPS[step] ? "en" : undefined;
}

export function StepLabel({ t, step }: { t: TFunction; step: CaseStep }): ReactNode {
  return stepTitleLang(step) ? <Term>{stepTitle(t, step)}</Term> : stepTitle(t, step);
}
