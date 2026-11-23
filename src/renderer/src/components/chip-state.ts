/**
 * A step's or a section's state, as its chip says it (StateChip, layout rule 12). Apart
 * from the component so that rules without React (section-view.ts) and their tests use it.
 */
export type ChipState = "not-started" | "hers" | "ai-draft" | "corrected" | "approved" | "copied" | "writing";
