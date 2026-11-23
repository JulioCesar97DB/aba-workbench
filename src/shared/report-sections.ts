/*
 * The sections of the initial assessment, in the order the report shows them. Their titles
 * are the ones the clinician's forms use, in English in both screen languages, and are
 * never translated. Only "medical-necessity" has writing rules so far (src/lib/rules.ts).
 */
export const REPORT_SECTIONS = [
  { id: "background-information", title: "Background Information" },
  { id: "medical-necessity", title: "Medical Necessity Criteria" },
  { id: "strengths-and-weaknesses", title: "Strengths and Weaknesses" },
  { id: "environmental-changes", title: "Environmental Changes" },
  { id: "family-caregiver-involvement", title: "Family/Caregiver Involvement" },
  { id: "generalization-and-maintenance", title: "Generalization and Maintenance" },
  { id: "discharge-and-service-fading-plan", title: "Discharge and Service Fading Plan" },
  { id: "risk-assessment", title: "Risk Assessment" },
  { id: "crisis-plan", title: "Crisis Plan" },
] as const;

export type ReportSection = (typeof REPORT_SECTIONS)[number];
export type ReportSectionId = ReportSection["id"];

export function findReportSection(id: string | undefined): ReportSection | undefined {
  return REPORT_SECTIONS.find((section) => section.id === id);
}
