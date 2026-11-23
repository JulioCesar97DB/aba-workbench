/*
 * The evaluation's automatic checks: pure functions over a section's text and the case's
 * key, run on every saved version. Each returns findings; the rubric (eval/rubric.ts)
 * turns a check's findings into a 0 to 2 score. Nothing here reads a file or calls a
 * model, so all of it is unit-tested (tests/eval-checks.test.ts).
 */
import { checkStructure, findMarkers, type SectionShape } from "../../src/shared/section-text.ts";
import type { ReportSectionId } from "../../src/shared/report-sections.ts";
import type { CaseKey, CaseKeyName } from "../key.ts";
import { lookupKey, normalize, numberIndex, sentences, splitParagraphs, statedNumbers, words } from "./text.ts";

export const CHECK_IDS = ["markers", "shape", "numbers", "names", "repetition", "data-density", "banned-patterns", "examples", "payer-readiness"] as const;
export type CheckId = (typeof CHECK_IDS)[number];

export interface Finding {
  check: CheckId;
  section: ReportSectionId;
  /** What is wrong, in a line. */
  message: string;
  /** The words of the text it is about, when there are some. */
  excerpt?: string;
  /**
   * "major" counts fully in the score; "minor" only lowers 2 to 1 (a malformed marker, a
   * shape a little off). Every finding is listed in the results either way.
   */
  severity: "major" | "minor";
}

const rx = (pattern: string) => new RegExp(pattern, "iu");
const rxg = (pattern: string) => new RegExp(pattern, "giu");
const clip = (text: string, length = 160) => (text.length > length ? `${text.slice(0, length - 1)}…` : text);

/** The text with every [MISSING: ...] and [CHECK: ...] marker taken out (what the marker says is not the section's prose). */
export function withoutMarkers(text: string): string {
  return text.replace(/\[(?:MISSING|CHECK)\s*:[^\]]*\]/gu, " ");
}

/** The text with quoted speech taken out ("I'll kill you"): the child's words are not the writer's. */
export function withoutQuotes(text: string): string {
  return text.replace(/"[^"\n]{0,300}"|“[^”\n]{0,300}”/gu, ' "" ');
}

/* 1. Markers ------------------------------------------------------------------------- */

const MALFORMED_MARKERS: Array<{ pattern: RegExp; what: string }> = [
  { pattern: /\[(?:MISSING|CHECK)\]/gu, what: "a marker with nothing after it" },
  { pattern: /(?<!\[)\b(?:MISSING|CHECK)\s*:/gu, what: "a marker without its brackets" },
  { pattern: /\[(?:TBD|TODO|INSERT|PLACEHOLDER|NAME|DATE|X+)[^\]]*\]/giu, what: "a placeholder that is not a [MISSING: ...] or [CHECK: ...] marker" },
  { pattern: /\b(?:XX\/XX|_{3,})/gu, what: "a blank left to fill in" },
];

/**
 * Markers are well formed, every planted gap that applies to this section is marked, and
 * no section fills a planted gap with something the sources do not say.
 */
export function checkMarkers(section: ReportSectionId, text: string, key: CaseKey): Finding[] {
  const findings: Finding[] = [];
  for (const { pattern, what } of MALFORMED_MARKERS) {
    for (const match of text.matchAll(pattern)) findings.push({ check: "markers", section, severity: "minor", message: `Malformed marker: ${what}.`, excerpt: match[0] });
  }
  const markers = findMarkers(text);
  for (const gap of key.plantedGaps) {
    if (gap.mustMarkIn.includes(section)) {
      const marker = gap.marker ? rx(gap.marker) : null;
      const marked = markers.some((m) => (marker ? marker.test(m.note) : true));
      if (!marked) findings.push({ check: "markers", section, severity: "major", message: `Planted gap "${gap.id}" is not marked: ${gap.gap}` });
    }
    for (const forbid of gap.forbid) {
      for (const sentence of sentences(text)) {
        if (!rx(forbid.pattern).test(sentence.text)) continue;
        if (forbid.unless && rx(forbid.unless).test(sentence.text)) continue;
        findings.push({ check: "markers", section, severity: "major", message: `Planted gap "${gap.id}" filled: ${forbid.what}.`, excerpt: clip(sentence.text) });
      }
    }
  }
  return findings;
}

/* 2. Shape --------------------------------------------------------------------------- */

/**
 * Paragraphs and words within the section's limits (from its rules' front matter, or the
 * rubric's fallback where her decisions set one), and plain paragraphs only. Within 15%
 * of a word limit, or one paragraph off, is minor.
 */
export function checkShape(section: ReportSectionId, text: string, shape: SectionShape): Finding[] {
  return checkStructure(text, shape).map((issue): Finding => {
    if (issue.kind === "formatting") return { check: "shape", section, severity: "major", message: `Paragraph ${issue.paragraph + 1} has a heading, list, bold or table; ABA Matrix takes plain paragraphs.` };
    const off = issue.count < issue.min ? issue.min - issue.count : issue.count - issue.max;
    const minor = issue.kind === "paragraphs" ? off <= 1 : off <= Math.ceil(0.15 * (issue.count < issue.min ? issue.min : issue.max));
    return { check: "shape", section, severity: minor ? "minor" : "major", message: `${issue.count} ${issue.kind}; the limit is ${issue.min} to ${issue.max}.` };
  });
}

/* 3. Number provenance ---------------------------------------------------------------- */

/** Numbers that need no source: emergency services and the ABA billing codes. */
export const ALWAYS_ALLOWED_NUMBERS = ["911", "97151", "97152", "97153", "97154", "97155", "97156", "97157", "97158"];

/**
 * Every number in the text exists in a source or in her inputs (notes, instructions,
 * her sections). Numbers inside a [MISSING: ...] or [CHECK: ...] marker are checked too: a
 * marker quotes the sources. Spelled-out numbers ("three") are not checked.
 */
export function checkNumbers(section: ReportSectionId, text: string, index: ReadonlySet<string>): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>();
  for (const sentence of sentences(text)) {
    for (const number of statedNumbers(sentence.text)) {
      const lookup = lookupKey(number);
      if (number.kind === "value" && ALWAYS_ALLOWED_NUMBERS.includes(number.value)) continue;
      if (index.has(lookup) || seen.has(lookup)) continue;
      // A date written without its year is found by month and day; a dated one needs its year to match too.
      seen.add(lookup);
      findings.push({ check: "numbers", section, severity: "major", message: `"${number.raw}" is in no source.`, excerpt: clip(sentence.text) });
    }
  }
  return findings;
}

/** The index the number check looks numbers up in: every source text and her inputs. */
export { numberIndex };

/* 4. Names ---------------------------------------------------------------------------- */

function nameFindings(section: ReportSectionId, text: string, entries: readonly CaseKeyName[], kind: string): Finding[] {
  const findings: Finding[] = [];
  const prose = withoutQuotes(withoutMarkers(text));
  for (const entry of entries) {
    for (const drift of entry.drift) {
      for (const match of prose.matchAll(rxg(drift))) {
        findings.push({
          check: "names",
          section,
          severity: "major",
          message: `${kind} "${entry.name}" called "${match[0]}"${entry.note ? ` (${entry.note})` : ""}.`,
        });
      }
    }
  }
  return findings;
}

/** Behavior, caregiver and procedure names as the case key gives them; a caregiver's given name where her style avoids it. */
export function checkNames(section: ReportSectionId, text: string, key: CaseKey): Finding[] {
  const findings = [
    ...nameFindings(section, text, key.behaviors, "Behavior"),
    ...nameFindings(section, text, key.people, "Person"),
    ...nameFindings(section, text, key.procedures, "Procedure"),
  ];
  const prose = withoutQuotes(withoutMarkers(text));
  for (const person of key.people) {
    if (person.givenName?.use !== "avoid") continue;
    const count = [...prose.matchAll(rxg(person.givenName.pattern))].length;
    if (count > 0) findings.push({ check: "names", section, severity: "major", message: `The ${person.role} is called by her or his given name (${count} times); her style refers to caregivers by relation (provisional, pending her answer).` });
  }
  return findings;
}

/* 5. Repetition across sections -------------------------------------------------------- */

/** The length of a shared word sequence that counts as repetition. */
export const SHARED_WORDS = 12;

function sharedSequences(a: string[], b: string[], n: number): string[] {
  const grams = new Set<string>();
  for (let i = 0; i + n <= a.length; i++) grams.add(a.slice(i, i + n).join(" "));
  const shared: string[] = [];
  let last = -n;
  for (let i = 0; i + n <= b.length; i++) {
    const gram = b.slice(i, i + n).join(" ");
    if (!grams.has(gram)) continue;
    // One finding per run of overlapping windows.
    if (i - last >= n) shared.push(gram);
    last = i;
  }
  return shared;
}

/**
 * Across the sections of one assessment: long word sequences two sections share (the
 * same sentence told twice), and each incident or note told outside its home section in
 * more sections than its references allow. Phrases the key allows (the diagnosis as the
 * CDE words it, instrument names) and markers are left out first.
 */
export function checkRepetition(texts: Partial<Record<ReportSectionId, string>>, key: CaseKey, loadedSources: ReadonlySet<string>, n = SHARED_WORDS): Finding[] {
  const findings: Finding[] = [];
  const allowed = key.allowedRepeats.map((phrase) => words(phrase).join(" ")).filter((phrase) => phrase !== "");
  const prepared = Object.entries(texts).map(([section, text]) => {
    let flat = words(withoutMarkers(text ?? "")).join(" ");
    for (const phrase of allowed) flat = flat.split(phrase).join(" ¶ ");
    return { section: section as ReportSectionId, words: flat.split(" ").filter((w) => w !== "") };
  });
  for (let i = 0; i < prepared.length; i++) {
    for (let j = i + 1; j < prepared.length; j++) {
      for (const gram of sharedSequences(prepared[i].words, prepared[j].words, n)) {
        if (gram.includes("¶")) continue;
        for (const [section, other] of [
          [prepared[i].section, prepared[j].section],
          [prepared[j].section, prepared[i].section],
        ]) {
          findings.push({ check: "repetition", section, severity: "major", message: `Shares ${n}+ words with ${other}.`, excerpt: gram });
        }
      }
    }
  }
  for (const incident of key.incidents) {
    if (!incident.from.every((id) => loadedSources.has(id))) continue;
    const telling = Object.entries(texts)
      .filter(([, text]) => sentences(withoutMarkers(text ?? "")).some((sentence) => incident.mentions.some((all) => all.every((pattern) => rx(pattern).test(sentence.text)))))
      .map(([section]) => section as ReportSectionId);
    const outside = telling.filter((section) => section !== incident.home);
    if (outside.length <= incident.references) continue;
    for (const section of outside) {
      findings.push({
        check: "repetition",
        section,
        severity: "major",
        message: `Retells "${incident.description}", whose home is ${incident.home}; ${outside.length} sections outside it tell it (${outside.join(", ")}), ${incident.references} allowed.`,
      });
    }
  }
  return findings;
}

/* 6. Data density ---------------------------------------------------------------------- */

/** Words that make a clause say what numbers mean (a comparison, a consequence, an explanation). */
const MEANING = new RegExp(
  [
    "because", "which (?:means|shows|indicates|places|puts|limits|reflects|suggests)", "meaning", "means", "so that", "therefore", "as a result", "thus",
    "indicat\\w*", "suggest\\w*", "reflect\\w*", "show(?:s|ed|ing)? that", "compared (?:with|to)", "than (?:most|same-age|peers|other|typical|expected)",
    "below (?:average|what|the|expected|same)", "above (?:average|the)", "same-age", "peers", "in a group of", "out of (?:every )?\\d+ children", "would be expected",
    "limit\\w*", "interfer\\w*", "prevent\\w*", "keep\\w* (?:her|him|them) from", "unable", "cannot", "could not", "does not", "did not", "affect\\w*", "impact\\w*",
    "risk", "danger\\w*", "injur\\w*", "miss(?:es|ed|ing)?", "lost", "needs?", "requir\\w*", "so (?:she|he|they|the)", "leaving (?:her|him)", "for (?:her|his) age",
  ].join("|"),
  "iu",
);

/** How many numbers a sentence needs before it must also say what they mean. */
export const DENSE_NUMBERS = 3;

/** Sentences with three or more values (not dates or times) and no clause saying what they mean: a list, not an argument. */
export function checkDataDensity(section: ReportSectionId, text: string): Finding[] {
  const findings: Finding[] = [];
  for (const sentence of sentences(withoutMarkers(text))) {
    // Data are values (scores, counts, durations); dates, years and clock times say when, not how much.
    const count = statedNumbers(sentence.text).filter((number) => number.kind === "value" && !/^(?:19|20)\d\d$/.test(number.value)).length;
    if (count >= DENSE_NUMBERS && !MEANING.test(sentence.text)) {
      findings.push({ check: "data-density", section, severity: "major", message: `${count} numbers and no clause of meaning.`, excerpt: clip(sentence.text) });
    }
  }
  return findings;
}

/* 7. Banned patterns ------------------------------------------------------------------- */

/** Patterns she would not write (rules/style.md on step 0, the quality runs' findings), checked outside markers and quotes. */
export const BANNED_PATTERNS: Array<{ id: string; pattern: RegExp; what: string; unless?: RegExp }> = [
  { id: "meta-not-evidence", pattern: /\bthese are\b[^.]{0,100}\bnot evidence\b/iu, what: "a comment on the evidence (meta sentence)" },
  { id: "meta-depend", pattern: /\bwill depend on whether\b[^.]{0,160}\bnot on\b/iu, what: "a comment on the evidence (meta sentence)" },
  { id: "meta-section", pattern: /\b(?:this|the following|the present) (?:section|paragraph|report)s? (?:describes?|outlines?|presents?|summarizes?|will|is intended|addresses|provides?)\b/iu, what: "a sentence about the text" },
  { id: "meta-as-mentioned", pattern: /\bas (?:mentioned|noted|stated|described|discussed) (?:above|earlier|previously|before|in (?:the )?(?:previous|prior) sections?)\b/iu, what: "a sentence about the text" },
  { id: "meta-see", pattern: /\b(?:see|refer to) (?:above|below|section \d+)\b/iu, what: "a sentence about the text" },
  { id: "filler-important", pattern: /\bit (?:is|should be) (?:important|worth) (?:to note|noting)\b|\bit should be noted\b/iu, what: "filler" },
  { id: "filler-conclusion", pattern: /\b(?:in conclusion|in summary|to summarize)\b/iu, what: "filler" },
  { id: "filler-overall", pattern: /(?:^|[.!?]\s+)overall,/iu, what: "filler" },
  { id: "hedge-stack", pattern: /\b(?:may|might|could) (?:possibly|potentially|perhaps)\b/iu, what: "a hedging stack" },
  { id: "superlative", pattern: /\bextremely\b|\bvery significant(?:ly)?\b/iu, what: "a superlative" },
  { id: "first-person", pattern: /\b(?:I|[Ww]e|[Oo]ur|us)\b(?!['’])/u, what: "the first person (the BCBA is written in the third person)" },
  { id: "addressed", pattern: /\b(?:please|you (?:should|may|can|will)|the reader)\b/iu, what: "a sentence addressed to her or the reader" },
  { id: "ai-voice", pattern: /\bas an (?:AI|language model)\b|\bI (?:cannot|can't|don't have)\b/iu, what: "the model speaking as itself" },
  {
    id: "restraint",
    pattern: /\b(?:restrain\w*|restraint|seclusion|secluded|physical hold\w*|prone hold|basket hold)\b/iu,
    unless: /\b(?:no|not|never|without|prohibit\w*|avoid\w*)\b/iu,
    what: "restraint or seclusion proposed (Florida Medicaid policy 5.2)",
  },
];

/** Meta sentences, filler, sentences about the text, the first person, and restraint or seclusion. */
export function checkBannedPatterns(section: ReportSectionId, text: string): Finding[] {
  const findings: Finding[] = [];
  for (const sentence of sentences(withoutQuotes(withoutMarkers(text)))) {
    for (const banned of BANNED_PATTERNS) {
      if (!banned.pattern.test(sentence.text)) continue;
      if (banned.unless?.test(sentence.text)) continue;
      findings.push({ check: "banned-patterns", section, severity: "major", message: `Banned pattern (${banned.id}): ${banned.what}.`, excerpt: clip(sentence.text) });
    }
  }
  return findings;
}

/* 8. Example sentences ----------------------------------------------------------------- */

/** How many consecutive words of an example an output may share. */
export const EXAMPLE_WORDS = 10;

/**
 * The invented examples in the rules files, by the convention the rules use: text under a
 * heading that names an example ("## Example", "### Invented example: ..."), blockquotes,
 * and a quotation right after "Example:". Template phrases with "..." or [brackets] are
 * patterns to follow, not examples, and are left out.
 */
export function extractExamples(markdown: string): string[] {
  const examples: string[] = [];
  const body = markdown.replace(/\r\n/g, "\n").replace(/^---\n[\s\S]*?\n---\n/, "");
  let underExample: number | null = null;
  let current: string[] = [];
  const flush = () => {
    if (current.length > 0) examples.push(current.join(" "));
    current = [];
  };
  for (const line of body.split("\n")) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      const level = heading[1].length;
      if (underExample !== null && level <= underExample) underExample = null;
      if (/\bexamples?\b/i.test(heading[2])) underExample = level;
      continue;
    }
    if (/^>\s?/.test(line)) {
      current.push(line.replace(/^>\s?/, ""));
      continue;
    }
    if (underExample !== null && line.trim() !== "") {
      current.push(line.replace(/^\s*(?:[-*]|\d+[.)])\s+/, ""));
      continue;
    }
    flush();
  }
  flush();
  for (const match of body.matchAll(/\bExample:\s*"([^"]{20,})"/g)) examples.push(match[1]);
  return examples.filter((example) => !/\.\.\.|…/.test(example)).map((example) => example.replace(/\[[^\]]*\]/g, " ").trim()).filter((example) => words(example).length >= EXAMPLE_WORDS);
}

/** No run of EXAMPLE_WORDS words of an example appears in the output. */
export function checkExamples(section: ReportSectionId, text: string, examples: readonly string[], n = EXAMPLE_WORDS): Finding[] {
  const findings: Finding[] = [];
  const output = words(text);
  for (const example of examples) {
    const shared = sharedSequences(words(example), output, n);
    for (const gram of shared) findings.push({ check: "examples", section, severity: "major", message: "Copies an example from the rules.", excerpt: gram });
  }
  return findings;
}

/* 9. Payer readiness -------------------------------------------------------------------- */

export interface PayerItem {
  id: string;
  section: ReportSectionId;
  /** What the payer's reviewer looks for (Florida Medicaid policy 4.2.1, 6.2.2; Molina 2 to 5 and 8). */
  what: string;
  /** Whether the text shows it; given the text without quotes. */
  test: (text: string, key: CaseKey) => { ok: boolean; detail?: string };
}

const has = (pattern: RegExp) => (text: string) => ({ ok: pattern.test(text) });
const hasMarkerOr = (pattern: RegExp, marker: RegExp) => (text: string) => ({ ok: pattern.test(withoutMarkers(text)) || findMarkers(text).some((m) => marker.test(m.note)) });
function allOf(names: Array<{ name: string; pattern: string }>, text: string, atLeast = names.length) {
  const missing = names.filter((entry) => !rx(entry.pattern).test(text)).map((entry) => entry.name);
  return { ok: names.length - missing.length >= atLeast, detail: missing.length > 0 ? `not found: ${missing.join(", ")}` : undefined };
}

/** The payer items that apply to the nine narrative sections today. */
export const PAYER_ITEMS: PayerItem[] = [
  { id: "bi-diagnosis", section: "background-information", what: "The diagnosis as the CDE states it", test: has(/\bautism spectrum disorder\b/iu) },
  { id: "bi-other-services", section: "background-information", what: "Every other service the child receives", test: (text, key) => allOf(key.payer.otherServices, text) },
  { id: "bi-prior-aba", section: "background-information", what: "Prior ABA, or that there was none", test: has(/\b(?:prior|previous|never|no)\b[^.]{0,60}\b(?:ABA|applied behavior analysis)\b|\b(?:ABA|applied behavior analysis)\b[^.]{0,40}\b(?:before|previously|never)\b/iu) },
  { id: "mn-diagnosis", section: "medical-necessity", what: "The diagnosis as the CDE states it", test: has(/\bautism spectrum disorder\b/iu) },
  { id: "mn-settings", section: "medical-necessity", what: "Impairment shown in two or more settings", test: (text, key) => allOf(key.payer.settings, text, Math.min(2, key.payer.settings.length)) },
  { id: "mn-functions", section: "medical-necessity", what: "The hypothesized functions of the behaviors", test: has(/\b(?:function\w*|escape|avoid\w*|attention|tangible|access to (?:preferred )?(?:items|activities|the tablet)|automatic|sensory)\b/iu) },
  {
    id: "mn-complements",
    section: "medical-necessity",
    what: "ABA complements, and does not duplicate, the other services",
    test: (text, key) => ({ ok: key.payer.otherServices.length === 0 || /\b(?:complement\w*|not duplicat\w*|does not duplicate|without duplicating|in addition to|coordinat\w*)\b/iu.test(text) }),
  },
  { id: "mn-caregiver-training", section: "medical-necessity", what: "Caregiver training as part of the treatment", test: has(/\b(?:caregiver|parent|family)\s+training\b|\b(?:train\w*|coach\w*)\b[^.]{0,80}\b(?:mother|father|grandmother|parents?|caregivers?)\b|\b(?:mother|father|grandmother|parents?|caregivers?)\b[^.]{0,80}\b(?:train\w*|coach\w*|rehears\w*)\b/iu) },
  { id: "mn-measurement", section: "medical-necessity", what: "How progress will be measured", test: has(/\b(?:measur\w*|monitor\w*|track\w*|data collection|collect\w* data|record\w* (?:data|each|every|the number|counts?|frequency|duration))\b/iu) },
  { id: "sw-strengths", section: "strengths-and-weaknesses", what: "Strengths documented from the sources", test: has(/\bstrength\w*|\b(?:enjoys|likes|loves|interest\w*)\b/iu) },
  { id: "ec-supports", section: "environmental-changes", what: "Supports planned for the changes, or a marker where none is named", test: hasMarkerOr(/\bsupport\w*\b/iu, /\bsupport/iu) },
  { id: "fci-caregivers", section: "family-caregiver-involvement", what: "Each caregiver who takes part, named by role", test: (text, key) => allOf(key.payer.caregivers, text) },
  { id: "fci-availability", section: "family-caregiver-involvement", what: "The caregivers' availability for training", test: has(/\b(?:availab\w*|evenings?|weekends?|saturdays?|after \d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?)\b/iu) },
  { id: "fci-language", section: "family-caregiver-involvement", what: "The language training is delivered in", test: has(/\b(?:spanish|english|language|bilingual|interpret\w*)\b/iu) },
  { id: "fci-training", section: "family-caregiver-involvement", what: "What caregiver training covers", test: has(/\btrain(?:ing|ed)?\b/iu) },
  { id: "gm-across", section: "generalization-and-maintenance", what: "Generalization across settings and people", test: has(/\bgeneraliz\w*\b|\b(?:across|different|other|new) (?:settings|people|environments)\b|\bsettings and people\b|\bpeople and (?:in )?(?:different )?settings\b/iu) },
  { id: "gm-probes", section: "generalization-and-maintenance", what: "Maintenance probes", test: has(/\bprob(?:e|es|ed|ing)\b/iu) },
  { id: "gm-thinning", section: "generalization-and-maintenance", what: "Reinforcement thinned from continuous to intermittent", test: has(/\bintermittent\b|\bthin\w*\b/iu) },
  {
    id: "dc-objective",
    section: "discharge-and-service-fading-plan",
    what: "Objective, individualized discharge criteria (or markers where her numbers are missing)",
    test: hasMarkerOr(/\b\d+\s*(?:%|percent|consecutive|weeks?|months?|sessions?|instances|episodes|or fewer|or less|of \d+)\b/iu, /\b(?:criteri\w*|threshold\w*|discharge|mastery)\b/iu),
  },
  { id: "dc-caregiver", section: "discharge-and-service-fading-plan", what: "Caregiver criteria: implementing the strategies on their own", test: has(/\b(?:caregiver|parent|mother|father|grandmother)s?\b[^.]{0,120}\b(?:fidelity|independent\w*|implement\w*|accura\w*|consistent\w*)\b/iu) },
  { id: "dc-fading", section: "discharge-and-service-fading-plan", what: "How services step down", test: has(/\b(?:fad\w*|reduc\w*|titrat\w*|step\w* down|decreas\w*|tapered?)\b/iu) },
  { id: "dc-transition", section: "discharge-and-service-fading-plan", what: "The transition: coordination with other providers or community supports", test: has(/\b(?:transition\w*|coordinat\w*|refer\w*|community (?:resources|supports?)|lower level of care)\b/iu) },
  { id: "ra-behaviors", section: "risk-assessment", what: "Every target behavior's risk", test: (text, key) => allOf(key.behaviors.map((b) => ({ name: b.name, pattern: [escape(b.name), ...b.accepted].join("|") })), text) },
  { id: "ra-injury", section: "risk-assessment", what: "Injuries and near misses as the sources give them", test: has(/\b(?:injur\w*|urgent care|bruis\w*|marks?|near miss|cut)\b/iu) },
  { id: "cp-emergency", section: "crisis-plan", what: "When emergency services are called (or a marker)", test: hasMarkerOr(/\b(?:911|emergency services|emergency)\b/iu, /\b(?:911|emergency)\b/iu) },
  { id: "cp-signs", section: "crisis-plan", what: "Early signs of escalation", test: has(/\b(?:early|warning|precursor\w*|signs?|escalat\w*)\b/iu) },
];

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The payer readiness items that apply to this section, each one present. */
export function checkPayerReadiness(section: ReportSectionId, text: string, key: CaseKey): Finding[] {
  const prose = withoutQuotes(text);
  return PAYER_ITEMS.filter((item) => item.section === section).flatMap((item): Finding[] => {
    const result = item.test(prose, key);
    return result.ok ? [] : [{ check: "payer-readiness", section, severity: "major", message: `Missing payer item (${item.id}): ${item.what}${result.detail ? `; ${result.detail}` : ""}.` }];
  });
}

/* All of them ------------------------------------------------------------------------- */

export interface CheckContext {
  key: CaseKey;
  /** The number index of the case's sources and her inputs (numberIndex). */
  numbers: ReadonlySet<string>;
  /** The shape each section must have. */
  shapes: Partial<Record<ReportSectionId, SectionShape>>;
  /** The invented examples of the rules the run used. */
  examples: readonly string[];
  /** The ids of the sources loaded for the run (an incident from a source not loaded is not checked). */
  loadedSources: ReadonlySet<string>;
}

/** Every check on every section of one assessment. */
export function runChecks(texts: Partial<Record<ReportSectionId, string>>, context: CheckContext): Finding[] {
  const findings: Finding[] = [];
  for (const [id, text] of Object.entries(texts) as Array<[ReportSectionId, string]>) {
    findings.push(
      ...checkMarkers(id, text, context.key),
      ...checkShape(id, text, context.shapes[id] ?? { paragraphs: null, words: null }),
      ...checkNumbers(id, text, context.numbers),
      ...checkNames(id, text, context.key),
      ...checkDataDensity(id, text),
      ...checkBannedPatterns(id, text),
      ...checkExamples(id, text, context.examples),
      ...checkPayerReadiness(id, text, context.key),
    );
  }
  findings.push(...checkRepetition(texts, context.key, context.loadedSources));
  return findings;
}

/** Paragraph count of a text, for the results. */
export function paragraphCount(text: string): number {
  return splitParagraphs(text).length;
}

export { normalize };
