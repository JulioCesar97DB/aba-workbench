/*
 * The rubric, version 1: every item is scored 0 to 2 per section. Some items are scored by
 * code from the automatic checks (eval/checks/checks.ts), the rest by the judge (ChatGPT on
 * the owner's plan; src/lib/judge.ts). eval/RUBRIC.md is the same rubric for people to read;
 * tests/eval-rubric.test.ts keeps the two in step.
 *
 * A change to an item's meaning, anchors or scoring bumps RUBRIC_VERSION: runs are only
 * compared item by item when they share a version.
 */
import type { CheckId, Finding } from "./checks/checks.ts";
import type { ReportSectionId } from "../src/shared/report-sections.ts";

export const RUBRIC_VERSION = "1";

export type Score = 0 | 1 | 2;

/** The stages the pipeline will grow to (owner's decision, 2026-11-23). Only "body" is written by the AI today. */
export type Stage = "formulation" | "plan" | "body" | "review";

interface ItemBase {
  id: string;
  title: string;
  /** What 2, 1 and 0 mean. */
  anchors: { 2: string; 1: string; 0: string };
  /** The stage whose sections it applies to. */
  stage: Stage;
  /** The sections it applies to within that stage; "all" for every section of the stage. */
  sections: "all" | readonly ReportSectionId[];
}

export interface CodeItem extends ItemBase {
  scoredBy: "code";
  check: CheckId;
}

export interface JudgeItem extends ItemBase {
  scoredBy: "judge";
}

export type RubricItem = CodeItem | JudgeItem;

const countAnchors = (what: string) => ({ 2: `No ${what}.`, 1: `One or two (${what}).`, 0: `Three or more (${what}).` });

export const RUBRIC: readonly RubricItem[] = [
  // Scored by code, from the automatic checks.
  {
    id: "markers",
    title: "Markers correct",
    scoredBy: "code",
    check: "markers",
    stage: "body",
    sections: "all",
    anchors: {
      2: "Every planted gap this section must mark is marked, no section fills a planted gap, and every marker is well formed.",
      1: "Only malformed markers (a marker without its note or brackets, a placeholder).",
      0: "A planted gap left unmarked where it must be marked, or filled with something the sources do not say.",
    },
  },
  {
    id: "shape",
    title: "Shape within the section's limits",
    scoredBy: "code",
    check: "shape",
    stage: "body",
    sections: "all",
    anchors: {
      2: "Paragraphs and words within the limits (rules front matter, or her stated shape), plain paragraphs only.",
      1: "Slightly off: one paragraph, or within 15% of the word limit.",
      0: "Further off, or headings, lists, bold or tables.",
    },
  },
  { id: "numbers-sourced", title: "Every number exists in a source", scoredBy: "code", check: "numbers", stage: "body", sections: "all", anchors: countAnchors("numbers found in no source") },
  { id: "names", title: "Names match the case key", scoredBy: "code", check: "names", stage: "body", sections: "all", anchors: countAnchors("behavior, person or procedure names that drift from the key, or a caregiver called by a given name") },
  {
    id: "repetition",
    title: "No repetition beyond a reference",
    scoredBy: "code",
    check: "repetition",
    stage: "body",
    sections: "all",
    anchors: countAnchors("word sequences of 12 or more shared with another section, or incidents told outside their home in more sections than allowed"),
  },
  { id: "data-density", title: "No sentence lists numbers without meaning", scoredBy: "code", check: "data-density", stage: "body", sections: "all", anchors: countAnchors("sentences with 3 or more values, not dates or times, and no clause of meaning") },
  { id: "banned-patterns", title: "No banned patterns", scoredBy: "code", check: "banned-patterns", stage: "body", sections: "all", anchors: countAnchors("meta sentences, filler, sentences about the text, first person, or restraint or seclusion") },
  {
    id: "examples-not-copied",
    title: "No example sentence copied",
    scoredBy: "code",
    check: "examples",
    stage: "body",
    sections: "all",
    anchors: { 2: "No 10-word run of an example from the rules appears.", 1: "(not used)", 0: "Any 10-word run of an example appears." },
  },
  {
    id: "payer-readiness",
    title: "Payer items present",
    scoredBy: "code",
    check: "payer-readiness",
    stage: "body",
    sections: "all",
    anchors: { 2: "Every payer item that applies to this section is there.", 1: "One missing.", 0: "Two or more missing." },
  },
  // Scored by the judge.
  {
    id: "data-explained",
    title: "Data explained, not listed",
    scoredBy: "judge",
    stage: "body",
    sections: "all",
    anchors: {
      2: "Every score, count or duration is followed by what it means for this child (compared with peers, or what she or he cannot do, where, with whom); the most impairing data are argued with incidents.",
      1: "Mostly explained, with a run of numbers or a paragraph that reads as a list.",
      0: "Data mostly listed: counts and scores strung together with little or no meaning.",
    },
  },
  {
    id: "thread",
    title: "Thread with the rest of the assessment",
    scoredBy: "judge",
    stage: "body",
    sections: "all",
    anchors: {
      2: "The behaviors, deficits, people and numbers are the same ones the other sections use, by the same names; what this section argues connects to what the others define, measure or treat; nothing contradicts another section.",
      1: "Connected, with a loose end: a behavior or deficit argued elsewhere missing where this section needs it, or a different emphasis that weakens the chain.",
      0: "Reads on its own: different names, numbers or story from the other sections, or a contradiction.",
    },
  },
  {
    id: "ownership",
    title: "Stays in its own lane",
    scoredBy: "judge",
    stage: "body",
    sections: "all",
    anchors: {
      2: "Says in full only what this section owns (the section map); refers to what other sections own in a clause, by name.",
      1: "One passage retells what another section owns (a session note told again, another section's counts, the crisis plan inside the risk assessment).",
      0: "Large parts retell other sections.",
    },
  },
  {
    id: "attribution",
    title: "Every fact attributed in the sentence",
    scoredBy: "judge",
    stage: "body",
    sections: "all",
    anchors: {
      2: "Every fact names its source in the sentence, and the kind of evidence is clear (direct observation, standardized score, caregiver report, second-hand).",
      1: "A few facts unattributed, or second-hand evidence written as if observed.",
      0: "Attribution mostly missing, or a report presented as observation.",
    },
  },
  {
    id: "structure",
    title: "Her structure followed",
    scoredBy: "judge",
    stage: "body",
    sections: "all",
    anchors: {
      2: "Follows the structure she set for this section (the expectations below), in order.",
      1: "Mostly follows it, with a part missing or out of order.",
      0: "Does not follow it.",
    },
  },
  {
    id: "style",
    title: "Her style",
    scoredBy: "judge",
    stage: "body",
    sections: "all",
    anchors: {
      2: "Plain clinical English in the third person; past tense for what happened, present for current functioning; people by relation; length proportionate to what the section owns.",
      1: "One lapse (a caregiver by her given name, wordy or padded passages, a tense slip).",
      0: "Several lapses.",
    },
  },
  {
    id: "nothing-invented",
    title: "Nothing invented",
    scoredBy: "judge",
    stage: "body",
    sections: "all",
    anchors: {
      2: "Every clinical fact is in the sources or her inputs; no clinical proposal (a strategy, parameter, support or criterion) the sources do not give, unless marked.",
      1: "One small step beyond the sources (an inference stated as fact, an unmarked proposal).",
      0: "An invented clinical fact, or several unmarked proposals.",
    },
  },
  {
    id: "key-facts",
    title: "The facts this section must contain",
    scoredBy: "judge",
    stage: "body",
    sections: "all",
    anchors: {
      2: "Every fact the case key lists for this section is there (a partial one counts half): at least 90%.",
      1: "At least 70%.",
      0: "Less than 70%.",
    },
  },
  // Later stages: defined now so the rubric grows with the pipeline; not scored until the AI writes those sections.
  {
    id: "definition-topography",
    title: "Each behavior defined by what this child does",
    scoredBy: "judge",
    stage: "formulation",
    sections: "all",
    anchors: { 2: "Topography, onset and offset, examples and non-examples from this child's incidents.", 1: "Partly generic.", 0: "Generic definitions." },
  },
  {
    id: "strategies-traced",
    title: "Antecedent strategies traced to that function's antecedents",
    scoredBy: "judge",
    stage: "plan",
    sections: "all",
    anchors: { 2: "Every preventive strategy traces to a recorded antecedent of a behavior with that function.", 1: "Most do.", 0: "Generic strategies." },
  },
  {
    id: "one-consequence-per-group",
    title: "One consequence entry per behavior group",
    scoredBy: "judge",
    stage: "plan",
    sections: "all",
    anchors: { 2: "Every behavior has exactly one consequence entry, or one group entry; same-nature behaviors with the same function merged.", 1: "One missing or doubled.", 0: "Several." },
  },
  {
    id: "definition-then-implementation",
    title: "Definition first, then implementation with parameters",
    scoredBy: "judge",
    stage: "plan",
    sections: "all",
    anchors: { 2: "Every entry: one definition sentence, then this child's implementation with concrete parameters.", 1: "Some entries without parameters.", 0: "Definitions only, or generic." },
  },
];

/** The items scored on the sections written today. */
export function itemsFor(stage: Stage, section: ReportSectionId): RubricItem[] {
  return RUBRIC.filter((item) => item.stage === stage && (item.sections === "all" || item.sections.includes(section)));
}

export const JUDGE_ITEM_IDS = RUBRIC.filter((item) => item.scoredBy === "judge" && item.stage === "body").map((item) => item.id);

/**
 * A code item's score from its check's findings in one section. Markers, shape and
 * examples: no finding 2, only minor ones 1, any major one 0. The counted checks: no
 * finding 2, one or two 1, three or more 0 (so a section that improves from many findings
 * to a few shows it).
 */
export function codeScore(item: CodeItem, findings: readonly Finding[]): Score {
  const mine = findings.filter((finding) => finding.check === item.check);
  const major = mine.filter((finding) => finding.severity === "major").length;
  if (mine.length === 0) return 2;
  if (item.check === "examples") return major > 0 ? 0 : 1;
  if (item.check === "markers") return major > 0 ? 0 : 1;
  if (item.check === "shape") return major > 0 ? 0 : 1;
  return major <= 2 ? 1 : 0;
}

/** The key-facts score from the judge's answer for each fact: present 1, partial 0.5, absent 0. */
export function keyFactsScore(statuses: ReadonlyArray<"present" | "partial" | "absent">): Score {
  if (statuses.length === 0) return 2;
  const share = statuses.reduce((sum, status) => sum + (status === "present" ? 1 : status === "partial" ? 0.5 : 0), 0) / statuses.length;
  return share >= 0.9 ? 2 : share >= 0.7 ? 1 : 0;
}

/**
 * What she has set for each section's structure and shape (aba-assessment-template.md and
 * the section rules on dev), given to the judge for the "structure" item. Fixed with the
 * rubric's version, not taken from the rules under test, so a rules change cannot move the bar.
 */
export const SECTION_EXPECTATIONS: Record<ReportSectionId, readonly string[]> = {
  "background-information": [
    "Narrative covering, as the sources give them: the family, household and languages; the diagnosis as the CDE states it, by whom and when; medication; developmental and medical history; school and its plan; other therapies (school services under the IEP are part of the IEP, not separate services); prior ABA; the behaviors of concern that led to the referral, named briefly.",
    "Cites the CDE, the IEP and the parents for what it states.",
  ],
  "medical-necessity": [
    "Her own structure, in order: (1) an opening paragraph naming everything used to support the clinical need for ABA and the areas where deficits were found; (2) a Vineland-3 paragraph with the specific scores and percentiles; (3) one paragraph per deficit area, in the opening's order, each argued with what the CDE, the parents and direct observation say; (4) a closing paragraph saying all of this supports the medical necessity of ABA and how ABA strategies would improve the deficits.",
    "Each deficit paragraph: the score or report, a concrete incident from this child's life, why it limits independence or participation, then what ABA will do, naming the procedure or skill.",
    "Fluent and very specific; explains the data rather than listing it.",
  ],
  "strengths-and-weaknesses": ["Strengths concrete and sourced; a strength stated then qualified where it does not hold, the qualification a fact from the sources; weaknesses name the deficit areas briefly, in the same names Medical Necessity uses."],
  "environmental-changes": ["Each change in the child's environment (recent, current or coming): who reported it, when, how the child responds, and the supports planned; a support the sources do not name is marked missing."],
  "family-caregiver-involvement": ["Who takes part in caregiver training, their availability, languages and capacity; what training covers and why (the parent interview, the BASC-3 PRQ); limited participation, its impact and the mitigation; procedures named, not described."],
  "generalization-and-maintenance": [
    "Exactly two paragraphs, as she described them.",
    "Generalization: taught with the same SD, then practiced across this child's settings and people; the prompt hierarchy adjusted as proficiency grows; examples from this child's goals.",
    "Maintenance: weekly probes that the skill is still performed; reinforcement from continuous to intermittent; prompt fading; closes by saying that if performance drops, the removed reinforcement schedule and prompts are reinstated and removed again once the level is regained.",
  ],
  "discharge-and-service-fading-plan": ["Discharge criteria tied to this child's behaviors, skills and caregivers, objective; thresholds the sources do not give are marked missing; how services fade; the transition with other providers. The three-phase table is hers, not described."],
  "risk-assessment": ["Each documented risk with its evidence: the behavior, how often, how severe, where, who is exposed, injuries and near misses, with the source; no risk rating; no crisis responses (those are the Crisis Plan's)."],
  "crisis-plan": ["Early signs and times of risk, the family's current responses as reported, caregiver duties and monitoring; no invented de-escalation technique; no restraint or seclusion; what only the agency or the BCBA can give is marked missing."],
};

/**
 * Shapes she stated where the section's rules give none: Generalization and Maintenance is
 * exactly two paragraphs. The rules' own front matter wins where it has limits.
 */
export const FALLBACK_SHAPES: Partial<Record<ReportSectionId, { paragraphs: { min: number; max: number } | null; words: { min: number; max: number } | null }>> = {
  "generalization-and-maintenance": { paragraphs: { min: 2, max: 2 }, words: null },
};
