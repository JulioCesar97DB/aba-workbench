import type { TFunction } from "i18next";
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

/** The steps' own names, in the screen's language (owner's decision P1): Documents, Case map, Plan, Report, Review and copy. Their paths stay as they are (T13). */
const STEP_KEYS = {
  sources: "sources",
  "case-map": "caseMap",
  interventions: "plan",
  report: "report",
  review: "review",
} as const satisfies Record<CaseStep, string>;

export function stepTitle(t: TFunction, step: CaseStep): string {
  return t(`steps.${STEP_KEYS[step]}`);
}

/** What the step holds, in a few words, under its name in the sidebar. */
export function stepSubtitle(t: TFunction, step: CaseStep): string {
  return t(`steps.subtitles.${STEP_KEYS[step]}`);
}
