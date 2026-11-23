/*
 * The thresholds she uses in behavior definitions, as we read them from her assessments
 * (the owner's notes on three of them, 2026-11-23), written in our own words (D16). They
 * are offered to her once, on the case map's screen: she changes what she wants and
 * confirms them, and only then do they become the case map's standing instructions, sent
 * with every behaviors request. Until then the AI leaves each threshold as [MISSING].
 */
export const THRESHOLDS_DRAFT = [
  "The thresholds I use in behavior definitions, unless a source or one of my sections gives another for this child:",
  "- Following an instruction: the child starts what was asked within 5 seconds; no start within 5 seconds counts as not following it.",
  "- Leaving the supervising adult (elopement): more than 6 feet away from the supervising adult without permission.",
  "- Leaving the task area: more than 3 feet from the assigned spot without permission.",
  "- Off task: 3 seconds or more without attending to the task.",
  "- End of an episode: the behavior has stopped for 10 seconds in a row; 3 seconds for brief vocal bursts and for self-injury; 30 seconds for crying.",
  "- Tantrum and screaming: screaming that lasts more than 30 seconds together with other tantrum behaviors is scored as a tantrum, not as screaming.",
  "- Repetitive movements: counted only when they interrupt a task, a transition or play with others for 3 seconds or longer; during free time, when they interrupt nothing, they are not counted.",
].join("\n");
