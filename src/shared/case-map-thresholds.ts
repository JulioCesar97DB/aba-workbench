/*
 * Her default thresholds for behavior definitions, from her questionnaire answers of
 * 2026-11-27, in our own words. By the owner's decision of 2026-11-28 they are the default
 * for every user: rules/behaviors.md lists them word for word (tests/rules.test.ts keeps the
 * two in step), and the case map's check lets an AI-drafted behavior value take its numbers
 * from them. On the case map's screen she may write her own (D16): saved, they become the
 * case map's standing instructions, sent with every behaviors request, and override these.
 */
export const DEFAULT_THRESHOLDS: readonly string[] = [
  "Following an instruction: the child starts what was asked within 5 seconds; no start within 5 seconds counts as not following it.",
  "Leaving the supervising adult (elopement): more than 6 feet away from the supervising adult without permission.",
  "Off task: 3 seconds or more without attending to the task.",
  "Repetitive movements (stereotypy): counted only when they interrupt a task, a transition or play with others for 3 seconds or longer; when they interrupt nothing, they are not counted.",
  "End of an episode: the behavior has stopped for 10 seconds in a row; for a tantrum, 30 seconds.",
];

/** What the screen offers her to start from: her defaults, which hers replace once saved. */
export const THRESHOLDS_DRAFT = [
  "The thresholds I use in behavior definitions, unless a source or one of my sections gives another for this child, adapted to the child's age and level of functioning:",
  ...DEFAULT_THRESHOLDS.map((line) => `- ${line}`),
].join("\n");
