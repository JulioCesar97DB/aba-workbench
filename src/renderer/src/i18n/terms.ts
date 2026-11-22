/*
 * Clinical terms that stay in English whichever screen language is chosen, because that
 * is how the clinician and her forms name them. The section names are in
 * src/shared/report-sections.ts. Render them with <Term> (lang="en").
 */
export const TERMS = {
  behaviors: "Behaviors",
  interventions: "Interventions",
} as const;
