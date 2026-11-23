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
      2: "Paragraphs and words within her range for the section (from her own assessments), plain paragraphs only (a numbered protocol is allowed in the Crisis Plan).",
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
      2: "Says in full only what this section owns; refers to what other sections own in a clause, by name. Her deliberate repeats (the family's priorities, the safety response) are fine.",
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
      2: "Her habits (listed with the section): first name for the child, caregivers by relation, the BCBA in the third person, active plain clinical English, present for current functioning, past for history and observations, will for the plan, no blame, no promised outcomes.",
      1: "One lapse (a caregiver by her given name, a padded passage, a tense slip, a promised outcome).",
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
 * What she does in each section, from her decisions (aba-assessment-template.md) and from
 * her own recent assessments (patterns only, restated here in our words; nothing of them is
 * copied), given to the judge for the "structure" and "style" items. Fixed with the
 * rubric's version, never taken from the rules under test, so a rules change cannot move the bar.
 */
export const SECTION_EXPECTATIONS: Record<ReportSectionId, readonly string[]> = {
  "background-information": [
    "About six paragraphs, in this order: the household, languages, the parents' involvement and the family's priorities; then the diagnosis, medications, pregnancy and birth, medical history and specialists; then milestones and the history of communication; then school and its plan, past therapies, and prior ABA with why it ended; then the daily-living and behavior concerns, each by its source; then social life, play, sensory needs and transitions.",
    "Every claim names its source; where two sources disagree, both are given side by side. No severity level and no test scores in this section. Missing information is said plainly.",
    "School services under the IEP are part of the IEP, not separate services.",
  ],
  "medical-necessity": [
    "Her own structure, in order: (1) an opening that says the need for ABA is supported by the sources it names, then names the affected areas together; (2) the Vineland-3 composite and domain scores with percentiles, written as prose and tied at once to what the caregiver describes; (3) one paragraph per functional area (for example daily living, communication, flexibility and escape, safety, peers and community), each: the deficit, one concrete reported or observed example, its impact on the family, safety or participation, then what ABA will teach, by the program or procedure's name; (4) a paragraph on the direct observations; (5) a closing that individualized ABA is medically necessary, where and how it will be delivered, caregiver training, coordination with the school, and how effectiveness will be measured (fewer prompts, more independence, more access).",
    "About eight or nine paragraphs. Never hours. Fluent and very specific; explains the data rather than listing it.",
  ],
  "strengths-and-weaknesses": [
    "Prose, two or three paragraphs, no bullets. Strengths first, each sourced and tied to how it will help treatment; then the weaknesses, each sourced, by the names Medical Necessity uses; a closing sentence on how ABA will address the needs.",
    "Where a strength does not hold consistently, it is qualified by a fact from the sources, never a guess.",
  ],
  "environmental-changes": [
    "Two or three paragraphs. First how the child reacts to changes of place, routine or people, with sourced examples drawn together; then the changes reported (recent, current, coming: who reported them and when) and concrete supports for them.",
    "Her usual supports are standard ones (a predictable session routine, a visual schedule updated when plans change, advance notice and choices, the same start, break and finish cues, practicing small changes first, prompts to ask for help, a break or more time, the same cues at home and school, a record of staffing or schedule changes): writing them is her structure, not an invented fact. A support tied to a person, date or service the sources do not give is invented.",
  ],
  "family-caregiver-involvement": [
    "The narrative part only (ABA Matrix holds the caregiver goals): one to four paragraphs on the caregivers' involvement and priorities, who takes part and when, training through Behavioral Skills Training adapted to the home language, and the family's current responses described without blame; limited participation, its impact and the mitigation.",
    "Procedures named, not described.",
  ],
  "generalization-and-maintenance": [
    "Exactly two paragraphs, for the plan as a whole.",
    "Generalization: taught with the same SD, then practiced with varied people, settings, materials and routines of this child; prompts faded while visual supports stay; natural consequences; examples from this child's goals.",
    "Maintenance: probes after mastery (weekly); reinforcement thinned from continuous to intermittent; if performance drops, the removed reinforcement and prompts are reinstated and removed again once the level is regained. Coordination with other providers, with the caregiver's authorization, may appear here.",
  ],
  "discharge-and-service-fading-plan": [
    "Two or three paragraphs (the three-phase table is hers, in ABA Matrix, and is not described).",
    "Her standard criteria: discharge when the goals are substantially met, when there is no progress despite reasonable changes to the plan, or when circumstances prevent continuing; fading starts once the reduction goals have held for three consecutive months, the caregiver carries out the plan independently and the replacement skills are used consistently; services end after six consecutive months without clinically significant target behavior; fading pauses if skills slip. Tied to this child's behaviors, skills and caregivers, and to the transition with other providers.",
  ],
  "risk-assessment": [
    "Three or four paragraphs, no risk rating: first the risks to carrying out the plan (cues that differ across people and settings, prompt dependence); then the behavior risks in prose, from the most dangerous to those that only interfere, each with its evidence and source; then that least-restrictive, function-based procedures answer them, pointing to the Crisis Plan by name; then training, fidelity checks and how the plan is adjusted.",
    "No crisis responses (those are the Crisis Plan's).",
  ],
  "crisis-plan": [
    "The child-specific part scales with the risk: for the highest-risk behavior a numbered protocol; when no behavior needs one, a plain statement that no behavior-specific crisis plan is needed, the non-crisis responses and one safety scenario (supervision distance, when to call 911); or the scope (behaviors covered, teaching suspended, line-of-sight distance, when to call 911 or Poison Control, who is notified), one paragraph per dangerous behavior and the follow-up.",
    "No physical restraint or restrictive procedure. Monitoring: data per definition, weekly review of the data by the BCBA, fidelity observations of the RBT and the caregiver, whether the caregiver finds the plan practical, what changes when progress is slow, documentation. The family's current responses as reported. What only the agency gives is marked missing.",
  ],
};

/** Habits across every section (her assessments), for the judge's "style" item. */
export const STYLE_EXPECTATIONS: readonly string[] = [
  "The child by first name; caregivers by relation (his mother, her parents, the caregiver), rarely by their own names; the BCBA as \"the BCBA\".",
  "Third person, active voice, plain clinical English: present tense for current functioning, past for history and observations, \"will\" for the plan.",
  "Programs and strategies by the same exact names wherever they appear.",
  "Repeated on purpose only: the family's priorities and the safety response. Never a score table again.",
  "No bullets in narrative sections; no blame of the family; no promised outcomes; harmless movement is not a target; speech or eye contact never required.",
  "Missing or conflicting information is stated, never guessed.",
];

/**
 * The shape of each section in her own recent assessments (paragraphs and words, rounded
 * to her range). The rubric measures against her shape, not the rules under test; a
 * section whose length she does not keep steady has none.
 */
export const SECTION_SHAPES: Partial<Record<ReportSectionId, { paragraphs: { min: number; max: number } | null; words: { min: number; max: number } | null }>> = {
  "background-information": { paragraphs: { min: 5, max: 7 }, words: { min: 600, max: 850 } },
  "medical-necessity": { paragraphs: { min: 8, max: 9 }, words: { min: 950, max: 1150 } },
  "strengths-and-weaknesses": { paragraphs: { min: 2, max: 3 }, words: { min: 300, max: 450 } },
  "environmental-changes": { paragraphs: { min: 2, max: 3 }, words: { min: 300, max: 450 } },
  "family-caregiver-involvement": { paragraphs: { min: 1, max: 4 }, words: { min: 200, max: 400 } },
  "generalization-and-maintenance": { paragraphs: { min: 2, max: 2 }, words: { min: 200, max: 280 } },
  "discharge-and-service-fading-plan": { paragraphs: { min: 2, max: 3 }, words: null },
  "risk-assessment": { paragraphs: { min: 3, max: 4 }, words: { min: 300, max: 400 } },
};

/** Sections where her own text uses a numbered list (the crisis protocol): the shape check lets numbered lines through there. */
export const NUMBERED_LISTS_ALLOWED: readonly ReportSectionId[] = ["crisis-plan"];
