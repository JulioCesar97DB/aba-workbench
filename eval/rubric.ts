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

/**
 * Version 2 (review round 1): Medical Necessity's "ABA will…" names what the child needs to
 * learn, never a procedure before her plan is approved (B1); her standard practice counts
 * only when her standing instructions give it (S2); the caregiver given-name rule is not
 * scored until she answers (S1); payer readiness is scored as its anchor says (S11); the
 * judge sees the payer facts of each section.
 *
 * Version 3 (the BCBA's questionnaire answers of 2026-11-27): three code items for her
 * wording, quoted speech, and dates and names in narrative; a caregiver called by a name is
 * scored now that she has answered; the judge's anchors, her structure for each section and
 * her habits follow her answers.
 */
export const RUBRIC_VERSION = "3";

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
    id: "her-wording",
    title: "Her wording",
    scoredBy: "code",
    check: "wording",
    stage: "body",
    sections: "all",
    anchors: countAnchors("long dashes, utilize, facilitate or leverage, \"the BCBA observed\" or \"saw\", \"hypothesized\", or a severity level, in any section, markers included for the severity level"),
  },
  { id: "no-quoted-speech", title: "No quoted speech", scoredBy: "code", check: "quotes", stage: "body", sections: "all", anchors: countAnchors("quoted spans: she always paraphrases") },
  {
    id: "no-dates-or-names",
    title: "No dates or names in narrative",
    scoredBy: "code",
    check: "dates-names",
    stage: "body",
    sections: "all",
    anchors: countAnchors("numeric dates, dates other than the day a coming change starts, or people named by Dr., credentials or Mr. or Ms. and a surname"),
  },
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
      2: "Every fact names its source in the sentence, by the source and not by a date (\"During the parent interview\", \"During direct observation, ... was observed\"), and the kind of evidence is clear (direct observation, standardized score, caregiver report, second-hand).",
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
      2: "Her habits (listed with the section): first name for the child; caregivers by relation and professionals by role, never by name; the BCBA in the third person and never as the one who observed; written for a technical reviewer, no term explained; short plain clinical sentences, no generic, sales-like or translated-sounding text; present for current functioning, past for history and observations, will for the plan; no blame, no promised outcomes.",
      1: "One lapse (a padded passage, a tense slip, a promised outcome, a generic sentence, a term explained).",
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
      2: "Every clinical fact is in the sources, the session notes or her standing instructions; text the payer requires of the section (its payer facts) is not invented; no clinical proposal (a named procedure, parameter, program title, support or criterion) that none of them gives, unless marked.",
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
  // A finding under a rule pending her answer is listed but never scored (review S1).
  const mine = findings.filter((finding) => finding.check === item.check && !finding.provisional);
  const major = mine.filter((finding) => finding.severity === "major").length;
  if (mine.length === 0) return 2;
  if (item.check === "examples") return major > 0 ? 0 : 1;
  if (item.check === "markers") return major > 0 ? 0 : 1;
  if (item.check === "shape") return major > 0 ? 0 : 1;
  // As its anchor says: one missing 1, two or more 0 (review S11).
  if (item.check === "payer-readiness") return major === 1 ? 1 : 0;
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
    "The first paragraph also gives who cares for the child, who works and supports the household, the family's culture, and a request for therapy in another language when there is one. Sensitive family matters only when they affect treatment, in neutral terms.",
    "Every claim names its source, without dates; where two sources disagree, both are given side by side (the only section that does). No severity level, no test scores and no names of the CDE's tests. The reason for referral and who referred are the agency's: not written. Missing information is said plainly.",
    "School services under the IEP are part of the IEP, not separate services.",
  ],
  "medical-necessity": [
    "Her own structure, in order: (1) an opening that says the need for ABA is supported by the sources it names (by source, with no dates or names), then names the affected areas together; (2) the Vineland-3 composite and domain scores with percentiles, the subdomain v-scale scores, the descriptive levels, the Maladaptive Behavior Index with Internalizing and Externalizing and the critical items when reported, written as prose with a plain explanation and tied at once to what the caregiver describes; (3) one paragraph per functional area (for example daily living, communication, flexibility and escape, safety, peers and community), each: the deficit, one concrete reported or observed example (one per paragraph), its impact on the family, safety or participation, then what ABA will do, said as what the child needs to learn (the reverse of the documented deficit) and the general approach; (4) a paragraph on what the direct observations showed; (5) a closing that individualized ABA is medically necessary, where and how it will be delivered, caregiver training, how it always complements rather than duplicates the other services, and how effectiveness will be measured (fewer prompts, more independence, more access).",
    "No FAST or MAS results and no BASC-3 PRQ scores here: the BASC-3 PRQ only as what it shows that supports the need, in words. Functions as \"is maintained by\". With no school data, impairment at home (primary setting) and in the community (secondary). The Florida definition of medical necessity is never cited. No extinction or punishment named.",
    "Before her plan is approved, a named procedure, parameter, program title or support (DRA, FCT, DRO, Premack, high-p requests, NCR, BST, a warning, a visual schedule) is a proposal: it belongs here only where her sections, standing instructions, notes or a source give it (owner's decision, 2026-11-23). The diagnosis is given by its name as the CDE writes it, never with a severity level and never with a marker for one.",
    "About eight or nine paragraphs. Never hours. Fluent and very specific; explains the data rather than listing it.",
  ],
  "strengths-and-weaknesses": [
    "Prose, two or three paragraphs, no bullets, no scores or score levels. Strengths first, each sourced and tied to how it will help treatment: emerging and preferred skills, preferences and reinforcers, a good BASC-3 PRQ result in words, and the family's involvement as a strength for carrying out and generalizing the plan; then the weaknesses, each sourced, by the names Medical Necessity uses, preferably with other examples than its own; a closing sentence on how ABA will address the needs.",
    "Where a strength does not hold consistently, it is qualified by a fact from the sources, never a guess.",
  ],
  "environmental-changes": [
    "Two or three paragraphs. First how the child reacts to changes of place, routine or people, with sourced examples drawn together; then the changes reported (a school or grade, who cares for the child, a new sibling, medication, the RBT or BCBA, a move: who reported them and when) and the supports, written even when no change is coming.",
    "Supports for the changes as her plan, her standing instructions, her notes or a source give them. When her standing instructions give her standard supports, writing them is her structure; otherwise a support none of them names is marked missing, not proposed. (Her standard supports are pending her confirmation.)",
  ],
  "family-caregiver-involvement": [
    "The narrative part only (ABA Matrix holds the caregiver goals, one set for all caregivers): one to four paragraphs on the caregivers' involvement and priorities, who takes part and when, training through Behavioral Skills Training in person (never by telehealth) in the home language, what it covers and why, the family's current everyday responses described without blame, and that training increases as fading nears; limited participation, its impact and the mitigation.",
    "\"The caregiver\" or the relation, never a name. The BASC-3 PRQ only when it bears directly on training, without scores. Procedures named, not described.",
  ],
  "generalization-and-maintenance": [
    "Exactly two paragraphs, for the plan as a whole.",
    "Generalization: taught with the same SD, then practiced with varied people, settings, materials and routines of this child; prompts faded while visual supports stay; natural consequences; examples from this child's goals.",
    "Maintenance: probes after mastery (weekly); reinforcement thinned from continuous to intermittent; if performance drops, the removed reinforcement and prompts are reinstated and removed again once the level is regained. Care coordination has its own field in ABA Matrix.",
  ],
  "discharge-and-service-fading-plan": [
    "Two or three paragraphs (the phases are only in her table in ABA Matrix and are not described). The criteria's numbers in the text, as her inputs give them; zero only for dangerous behaviors; caregiver training that increases as fading nears; community resources only when the sources name some (no marker otherwise).",
    "Discharge grounds as the payer gives them (see the payer facts), then criteria tied to this child's behaviors, skills and caregivers, how services step down, and the transition with other providers. When her standing instructions give her standard criteria and thresholds, they are her structure; otherwise a number none of the inputs gives is marked missing. (Her standard criteria are pending her confirmation.)",
  ],
  "risk-assessment": [
    "Three or four paragraphs, no risk rating: first the risks to carrying out the plan (cues that differ across people and settings, prompt dependence); then the behavior risks in prose, from the most dangerous to those that only interfere, each with its evidence and source, and the non-behavioral risks the sources report (pica, seizures, allergies, water, a very limited diet, medication side effects); then what the family does today in a crisis, as reported, in ABA terms, and that least-restrictive, function-based procedures answer the risks, pointing to the Crisis Plan by name; then training, fidelity checks and how the plan is adjusted.",
    "The protocol from now on is the Crisis Plan's; the family's current crisis responses belong here.",
  ],
  "crisis-plan": [
    "Always a child-specific text: the behaviors that can be dangerous; the antecedent strategies staff follow at all times (named from her plan, or marked missing while there is none); an adult always present in the home during sessions, and who may be the designated caregiver (a parent, a grandparent, a sibling aged 21 or older, a listed home health aide or babysitter); the RBT or caregiver calls 911 when the situation gets out of control; incidents reported as soon as possible. A protocol for mouthing, physical aggression, property destruction, self-injury or elopement, even with no past crisis.",
    "Never restraint, seclusion or a physical hold. Early signs only as the caregivers report them, never from other sources and never marked missing. The family's current crisis responses are Risk Assessment's. The template blocks are not written. Monitoring as her standing instructions give it, otherwise marked missing; protocol steps, distances and de-escalation she has not given are marked missing.",
  ],
};

/**
 * What the payer requires of each narrative section, in our words (Florida Medicaid policy
 * 4.2.1 and 6.2.2; the Molina guide, sections 2 to 5 and 8), given to the judge: text the
 * payer requires is not invented, and a section that leaves it out is incomplete. Fixed with
 * the rubric's version, never taken from the rules under test.
 */
export const SECTION_PAYER_FACTS: Record<ReportSectionId, readonly string[]> = {
  "background-information": ["The diagnosis as the CDE states it, every other service the child receives, and any earlier ABA are documented."],
  "medical-necessity": [
    "Medical necessity rests on behavior that impairs a major life activity, shown across settings (home, school, community), with the behaviors' hypothesized functions.",
    "ABA complements, and does not duplicate, the child's other services; caregiver training is part of the treatment; how progress will be measured is stated.",
  ],
  "strengths-and-weaknesses": ["Strengths and needs are documented from the sources."],
  "environmental-changes": ["Changes in the child's environment and the supports for them are documented."],
  "family-caregiver-involvement": ["Caregiver participation is documented (who, availability, language); when a caregiver cannot take part, the reason and the mitigation are given. Caregiver training covers the plan's strategies."],
  "generalization-and-maintenance": ["Each skill has a plan for generalization across settings and people and for maintenance."],
  "discharge-and-service-fading-plan": [
    "Discharge grounds (AHCA, as Molina lists them): the child no longer meets medical necessity criteria; no longer engages in the maladaptive behaviors; data show the behaviors no longer stand in the way of major life activities; the level of impairment no longer justifies services; or the parent or guardian withdraws consent.",
    "A transition plan has objective, individualized criteria for a lower level of care that include the caregiver, hours that step down as goals are met, community resources that keep the gains, and caregiver training that increases as the transition nears.",
  ],
  "risk-assessment": ["Each behavior's risk is documented with its evidence (frequency, severity, injuries); restraint and seclusion are never part of the plan."],
  "crisis-plan": ["The crisis plan says how a crisis is handled and when emergency services are called; restraint and seclusion are never used."],
};

/** Habits across every section (her assessments), for the judge's "style" item. */
export const STYLE_EXPECTATIONS: readonly string[] = [
  "The child by first name; caregivers by relation or as \"the caregiver\", never by name; other professionals by role, never by name; the BCBA as \"the BCBA\", never as the one who observed (\"During direct observation, ... was observed\").",
  "Third person, active voice, plain clinical English for a technical reviewer, no term explained in parentheses: present tense for current functioning, past for history and observations, \"will\" for the plan. Short sentences; nothing generic, sales-like or translated-sounding; no long dashes; never utilize, facilitate or leverage. Data in digits.",
  "No dates in narrative: the source instead (\"During the parent interview\"). No quotes: paraphrase. Functions as \"is maintained by\", never \"hypothesized\". No severity level anywhere. An abbreviation spelled out the first time in each section, except BCBA, FAST, MAS, STO, LTO, BASC-3 and ABLLS-R.",
  "Programs and strategies by the same exact names wherever they appear. Repeated on purpose only: the family's priorities and the safety response. Never a score table again.",
  "No bullets in narrative sections; no blame of the family; no promised outcomes; harmless movement is not a target; speech or eye contact never required.",
  "Missing information is stated, never guessed. Outside Background Information, two sources that disagree are not set side by side: a [CHECK] asks her which to keep.",
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
