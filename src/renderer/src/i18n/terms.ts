/*
 * Clinical terms that stay in English whichever screen language is chosen, because that
 * is how the clinician and her forms name them. The section names are in
 * src/shared/report-sections.ts. Render them with <Term> (lang="en").
 */
export const TERMS = {
  behaviors: "Behaviors",
  interventions: "Interventions",
} as const;

/**
 * The case map's clinical lists, English on both screens as her forms and ABA Matrix name
 * them: the functions (in her Hypothesis Based Interventions order), the barrier tags of
 * her behavior blocks, the measures and the intensity.
 */
export const MAP_TERMS = {
  functions: { tangibles: "Tangibles", attention: "Attention", escape: "Escape", sensory: "Sensory", automatic: "Automatic Reinforcement" },
  barriers: {
    safety: "Safety",
    communication: "Communication",
    "social-interaction": "Social Interaction",
    "following-instructions": "Following Instructions",
    "learning-and-task-engagement": "Learning and Task Engagement",
    "daily-living-skills": "Daily Living Skills",
    "community-participation": "Community Participation",
    "transitions-and-flexibility": "Transitions and Flexibility",
    "emotional-regulation": "Emotional Regulation",
  },
  measures: { frequency: "Frequency", duration: "Duration", latency: "Latency", intensity: "Intensity" },
  tools: { fast: "FAST", mas: "MAS", abc: "ABC data", observation: "Direct observation", interview: "Interview", "her-section": "BCBA's section" },
  intensities: { "1": "1", "2": "2", "3": "3" },
} as const satisfies Record<string, Record<string, string>>;
