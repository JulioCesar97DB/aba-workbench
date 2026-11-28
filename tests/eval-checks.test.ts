import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  checkBannedPatterns,
  checkDatesNames,
  checkQuotes,
  checkWording,
  checkDataDensity,
  checkExamples,
  checkMarkers,
  checkNames,
  checkNumbers,
  checkPayerReadiness,
  checkRepetition,
  checkShape,
  extractExamples,
  numberIndex,
  PAYER_ITEMS,
  runChecks,
} from "../eval/checks/checks.ts";
import { lookupKey, sentences, statedNumbers } from "../eval/checks/text.ts";
import { CaseKeySchema, keyProblems, loadCase, type CaseKey } from "../eval/key.ts";
import { REPORT_SECTIONS } from "../src/shared/report-sections.ts";

const CASES = path.join(import.meta.dirname, "..", "fixtures", "cases");
const caseB = loadCase(path.join(CASES, "case-b-sofia"));
const caseA = loadCase(path.join(CASES, "case-a-mateo"));

/** A small key for the tests that need one. */
function testKey(overrides: Partial<CaseKey> = {}): CaseKey {
  return CaseKeySchema.parse({
    keyVersion: "t",
    caseId: "t",
    child: { firstName: "Ana", fullName: "Ana Prueba" },
    sources: [{ id: "s", type: "other" }],
    behaviors: [{ id: "elopement", name: "elopement", drift: ["\\bleaving the area\\b"], functions: { primary: ["escape"] } }],
    people: [{ id: "mother", role: "mother", name: "her mother", givenName: { pattern: "\\bRosa\\b", use: "avoid" } }],
    payer: { settings: [{ name: "home", pattern: "\\bhome\\b" }, { name: "school", pattern: "\\bschool\\b" }], caregivers: [{ name: "mother", pattern: "\\bmother\\b" }] },
    sectionFacts: {},
    ...overrides,
  });
}

test("sentences: split after a period, not after Dr., M.S. or p.m.", () => {
  const found = sentences("Dr. Supuesta, Ph.D., saw her at 3:00 p.m. on 10/07/2026. She left. Then 2 more.\n\nNew paragraph here.").map((s) => [s.text, s.paragraph]);
  assert.deepEqual(found, [
    ["Dr. Supuesta, Ph.D., saw her at 3:00 p.m. on 10/07/2026.", 0],
    ["She left.", 0],
    ["Then 2 more.", 0],
    ["New paragraph here.", 1],
  ]);
});

test("statedNumbers: dates, times and values made comparable; instrument names are not numbers", () => {
  const keys = statedNumbers("On October 7, 2026 (10/07/2026) at 3:30 p.m., the Vineland-3 and DSM-5 gave 1,000 and 4.5 and the 1st percentile; F84.0; 40%.").map(lookupKey);
  assert.deepEqual(keys, ["date:10-07:2026", "date:10-07:2026", "time:3:30", "value:1000", "value:4.5", "value:1", "qty:40:percent"]);
  assert.deepEqual(statedNumbers("from 3:00 to 5:30 p.m.").map(lookupKey), ["time:3:00", "time:5:30"]);
  assert.deepEqual(statedNumbers("15:00").map(lookupKey), ["time:3:00"], "a 24-hour time is the same clock as 3:00 p.m.");
  assert.deepEqual(statedNumbers("CDE (2026-07-30); el 20/09/2026").map(lookupKey), ["date:07-30:2026", "date:09-20:2026"], "an ISO date, and a Spanish day/month date");
});

test("numbers: a duration, an interval or a percentage needs its unit in a source (review S6)", () => {
  const index = numberIndex(["Diego (6) was hit 3 times. Outbursts lasted 6 to 15 minutes; a 2-hour observation. Embarazo de 38 semanas. Age equivalent 7:2."]);
  const unsourced = (text: string) => checkNumbers("discharge-and-service-fading-plan", text, index).map((f) => f.message);
  assert.deepEqual(unsourced("A DRO interval of 3 minutes will be used, reset after 6 seconds."), ['"3" is in no source.', '"6" is in no source.']);
  assert.deepEqual(unsourced("Services end after 3 consecutive months."), ['"3" is in no source.']);
  assert.deepEqual(unsourced("She hit 3 times; outbursts of 6 minutes and 15 minutes over a 2-hour visit; Diego, 6 years old, at 38 weeks."), []);
  assert.deepEqual(unsourced("An age equivalent of 7 years 2 months."), [], "a score report's years:months supports it");
});

test("numbers: a number in no source is found; dates, times and values in the sources are not", () => {
  const index = numberIndex(["Observed 10/07/2026 from 3:30 to 5:30 p.m.; 6 episodes; standard score 81."]);
  assert.deepEqual(checkNumbers("medical-necessity", "On October 7, 2026 she had 6 episodes between 3:30 and 5:30; her score was 81.", index), []);
  const findings = checkNumbers("medical-necessity", "She had 7 episodes on 10/08/2026; 911 was never called.", index);
  assert.deepEqual(findings.map((f) => f.message), ['"10/08/2026" is in no source.', '"7" is in no source.']);
});

test("markers: a planted gap unmarked or filled is major; a malformed marker is minor", () => {
  const gap = caseB.key;
  // Since her answers of 2026-11-27 no section marks the severity level: she never states it.
  assert.deepEqual(checkMarkers("medical-necessity", "She was diagnosed with Autism Spectrum Disorder.", gap), []);
  const percentile = checkMarkers("medical-necessity", "Her Socialization standard score was 64.", caseA.key);
  assert.equal(percentile.length, 1, "a planted gap a section must mark is still found unmarked (case A's percentile)");
  assert.equal(percentile[0].severity, "major");
  const filled = checkMarkers("background-information", "She has Autism Spectrum Disorder, Level 1, requiring support.", gap);
  assert.match(filled[0].message, /severity-level.*filled/);
  assert.deepEqual(checkMarkers("background-information", "The CDE does not state a severity level 1 or otherwise.", gap), [], "a negated mention is not filling the gap");
  const malformed = checkMarkers("risk-assessment", "The date is MISSING: unknown and [TBD].", gap);
  assert.deepEqual(malformed.map((f) => f.severity), ["minor", "minor"]);
});

test("markers: no school observation by the BCBA (case B)", () => {
  const key = caseB.key;
  assert.equal(checkMarkers("risk-assessment", "During the school observation, the BCBA observed her in the classroom pushing a peer.", key).length, 1);
  assert.deepEqual(checkMarkers("risk-assessment", "The BCBA did not observe her at school because district approval was pending.", key), []);
});

test("shape: limits from the rules, minor when slightly off, formatting always major", () => {
  const shape = { paragraphs: { min: 2, max: 2 }, words: { min: 10, max: 20 } };
  assert.deepEqual(checkShape("generalization-and-maintenance", "One two three four five six.\n\nSeven eight nine ten eleven.", shape), []);
  const three = checkShape("generalization-and-maintenance", "One two three four.\n\nFive six seven.\n\nEight nine ten.", shape);
  assert.deepEqual(three.map((f) => f.severity), ["minor"]);
  const list = checkShape("generalization-and-maintenance", "- a list item one two three four five\n\nSix seven eight nine ten.", shape);
  assert.ok(list.some((f) => f.severity === "major" && /heading, list/.test(f.message)));
});

test("names: drift names and a caregiver's given name are found; quoted speech is not", () => {
  const key = testKey();
  const findings = checkNames("risk-assessment", 'Rosa said the leaving the area happened twice. She said "Rosa is mean."', key);
  assert.deepEqual(findings.map((f) => [f.message, f.provisional ?? false]), [
    ['Behavior "elopement" called "leaving the area".', false],
    ["The mother is called by her or his given name (1 times); she never names a caregiver (her answers of 2026-11-27).", false],
  ]);
  assert.deepEqual(checkNames("risk-assessment", "Her mother reported elopement.", key), []);
});

test("repetition: a 12-word run shared by two sections, both told; allowed phrases are not", () => {
  const key = testKey({ allowedRepeats: ["Autism Spectrum Disorder without accompanying intellectual impairment with accompanying language impairment in pragmatic language"] });
  const shared = "she pulled her wrist out of her mother's hand and ran across the street without looking";
  const findings = checkRepetition({ "medical-necessity": `On 10/10 ${shared}.`, "risk-assessment": `In the community ${shared}.` }, key, new Set());
  assert.deepEqual(findings.map((f) => f.section).sort(), ["medical-necessity", "risk-assessment"]);
  const diagnosis = "She has Autism Spectrum Disorder without accompanying intellectual impairment with accompanying language impairment in pragmatic language and ADHD.";
  assert.deepEqual(checkRepetition({ "background-information": diagnosis, "medical-necessity": diagnosis }, key, new Set()), []);
});

test("repetition: an incident is a retelling only with its own details, never in its home or where a key fact requires it, and only beyond the allowance (review S7)", () => {
  const key = caseB.key;
  const loaded = new Set(["notes", "observations"]);
  const note = "On 11/20/2026 the mother confirmed that the YMCA program accepted Sofía.";
  const told = (texts: Record<string, string>) => checkRepetition(texts as never, key, loaded).filter((f) => /Retells/.test(f.message)).map((f) => f.section);
  assert.deepEqual(told({ "environmental-changes": note, "family-caregiver-involvement": "The YMCA staff will learn her cues.", "generalization-and-maintenance": "Practice continues at the YMCA program." }), [], "naming the program is not retelling the note");
  assert.deepEqual(told({ "environmental-changes": note, "family-caregiver-involvement": note, "discharge-and-service-fading-plan": note, "risk-assessment": note }), ["discharge-and-service-fading-plan", "risk-assessment"], "one reference allowed (the first in report order); the later ones are flagged");
  const street = "On 10/10/2026 she pulled her wrist free and ran across the street.";
  assert.deepEqual(told({ "medical-necessity": street, "risk-assessment": street, "crisis-plan": "If Sofía runs toward the street, the adult follows the protocol.", "discharge-and-service-fading-plan": "Safe street crossing instead of running into the street." }), [], "Medical Necessity must tell it; a plan for the street is not the incident");
  assert.deepEqual(told({ "environmental-changes": "YMCA accepted her.", "risk-assessment": "YMCA accepted her.", "crisis-plan": "YMCA accepted her." }).length, 1);
  assert.deepEqual(checkRepetition({ "environmental-changes": note, "risk-assessment": note, "crisis-plan": note }, key, new Set()).filter((f) => /Retells/.test(f.message)), [], "a note that was not given is not checked");
});

test("data density: three values with no clause of meaning, in that sentence or the next (review S4)", () => {
  assert.equal(checkDataDensity("medical-necessity", "She had 3, 1 and 2 episodes of aggression.").length, 1);
  assert.deepEqual(checkDataDensity("medical-necessity", "Her standard score of 66 places her well below most same-age peers, at 1 in 100, with 3 more below."), []);
  const hers = "On the Vineland-3, Sofía obtained an Adaptive Behavior Composite of 72, a Communication score of 75 and a Socialization score of 68. These findings are reflected in her mother's account of mornings.";
  assert.deepEqual(checkDataDensity("medical-necessity", hers), [], "her pattern: the scores, then what they show");
  assert.equal(checkDataDensity("medical-necessity", "She scored 72, 75 and 68 and does not like tests.").length, 1, "'does not' anywhere is not an interpretation");
  assert.equal(checkDataDensity("medical-necessity", "She scored 72, 75 and 68.\n\nThese findings are reflected in her day.").length, 1, "the next paragraph does not explain this one");
});

test("banned patterns: meta sentences, filler, first person, hours, promises and restraint; markers and quotes are not prose", () => {
  const found = (text: string) => checkBannedPatterns("discharge-and-service-fading-plan", text).map((f) => f.message.replace(/^Banned pattern \(([^)]+)\).*$/, "$1"));
  assert.deepEqual(found("These are school goals, not evidence that Sofía has met them."), ["meta-not-evidence"]);
  assert.deepEqual(found("It is important to note that she improved."), ["filler-important"]);
  assert.deepEqual(found("We will teach her to wait."), ["first-person"]);
  assert.deepEqual(found("Fading begins in Phase I, then Tier I supports end."), [], "a Roman numeral is not the first person (review M9)");
  assert.deepEqual(found("Staff will use a physical hold if needed."), ["restraint"]);
  assert.deepEqual(found("If Sofía does not stop hitting, staff will use a basket hold until she is calm."), ["restraint"], "a negation elsewhere in the sentence does not excuse it (review S5)");
  assert.deepEqual(found("No restraint or seclusion is used."), []);
  assert.deepEqual(found("The RBT will not hesitate to use a basket hold if she runs."), ["restraint"], "the negation governs another verb (review round 2, m2)");
  assert.deepEqual(found("Without hesitation, staff will use a basket hold."), ["restraint"]);
  assert.deepEqual(found("Staff will not use a basket hold or any restraint."), [], "a real prohibition");
  assert.deepEqual(found("No physical restraint or restrictive procedure is authorized."), []);
  assert.deepEqual(found("She is never restrained or secluded."), []);
  assert.deepEqual(found("ABA services of 25 hours per week will be delivered at home and school."), ["hours"], "review S5");
  assert.deepEqual(found("The CDE recommended 25 to 30 hours per week of ABA."), []);
  assert.deepEqual(found("ABA will eliminate her aggression."), ["promise"]);
  assert.deepEqual(found("The RBT will ensure the door is locked."), [], "procedural, not a promise (review M9)");
  assert.deepEqual(found('She said "I hate you, we are done."'), [], "her quoted words are hers");
  assert.deepEqual(found("[MISSING: please confirm the date we agreed.]"), []);
});

test("examples: extracted by convention, and a copied run of 10 words found", () => {
  const rules = [
    "---\nid: x\nversion: 1\n---",
    "# Rules",
    "Write like this: \"Although [name] can ..., [he/she] does not yet ...\".",
    "## Invented example: a Medical Necessity paragraph",
    "Lucas Ejemplo scored 70 on Daily Living Skills, which places him well below most children his age.",
    "## Other heading",
    "Not an example at all, just a rule sentence that is long enough to count here.",
    "> A blockquoted invented example sentence that runs for more than ten words in total.",
    'Example: "The scatterplot shows hand flapping in most afternoon blocks of the school day."',
  ].join("\n");
  const examples = extractExamples(rules);
  assert.equal(examples.length, 3);
  assert.ok(examples[0].startsWith("Lucas Ejemplo"));
  const copied = checkExamples("medical-necessity", "Sofía scored 72 on Daily Living Skills, which places him well below most children his age.", examples);
  assert.equal(copied.length, 1);
  assert.deepEqual(checkExamples("medical-necessity", "Sofía scored 72 on Daily Living Skills, below most peers.", examples), []);
});

test("payer readiness: the items of a section, each found in the prose (not in a marker) or listed as missing (review S11)", () => {
  const key = testKey();
  const findings = checkPayerReadiness("medical-necessity", "Autism Spectrum Disorder limits her at home and gets her attention.", key);
  const ids = findings.map((f) => /\(([^)]+)\)/.exec(f.message)?.[1]);
  assert.deepEqual(ids, ["mn-settings", "mn-functions", "mn-caregiver-training", "mn-measurement"], "'attention' alone is not a function");
  const complete = "Autism Spectrum Disorder limits her at home and at school. Her aggression serves escape. Caregiver training will teach her mother. Progress will be measured with session data.";
  assert.deepEqual(checkPayerReadiness("medical-necessity", complete, key), []);
  assert.equal(checkPayerReadiness("medical-necessity", complete.replace("Caregiver training will teach her mother.", "[MISSING: caregiver training plan]"), key).length, 1, "a marker is not the item");
  const gm = (text: string) => checkPayerReadiness("generalization-and-maintenance", text, key).map((f) => /\(([^)]+)\)/.exec(f.message)?.[1]);
  assert.deepEqual(gm("Skills generalize. Weekly probes. The team keeps thinking about it."), ["gm-thinning"], "'thinking' is not thinning");
  const fci = (text: string) => checkPayerReadiness("family-caregiver-involvement", text, key).map((f) => /\(([^)]+)\)/.exec(f.message)?.[1]);
  assert.deepEqual(fci("Her mother is available on evenings for training; her body language is tense."), ["fci-language"], "'body language' is not the language of training");
  const dc = "Her mother will carry out the safety protocol during the routines she manages with [MISSING: required level of independent, correct implementation for each caregiver].";
  assert.ok(!checkPayerReadiness("discharge-and-service-fading-plan", dc, key).some((f) => /dc-caregiver/.test(f.message)), "the caregiver criterion's number may be a marker (step 3)");
  for (const item of PAYER_ITEMS) assert.ok(REPORT_SECTIONS.some((s) => s.id === item.section), item.id);
});

test("planted gaps: a sentence with the BCBA's observation and, after a semicolon, the IEP's school incident fills nothing (step 3)", () => {
  const sentence = "The BCBA observed Property destruction 3 times in 6 hours; at school, the teacher documented in the IEP that Sofía threw a chair and the class evacuated.";
  assert.deepEqual(checkMarkers("risk-assessment", sentence, caseB.key), []);
});

test("runChecks runs every check on every section", () => {
  const key = testKey();
  const findings = runChecks(
    { "medical-necessity": "We saw 7 episodes.", "risk-assessment": "Her mother reported elopement at home." },
    { key, numbers: numberIndex(["2 episodes"]), shapes: {}, examples: [], loadedSources: new Set(["s"]) },
  );
  const checks = new Set(findings.map((f) => `${f.section}:${f.check}`));
  assert.ok(checks.has("medical-necessity:numbers"));
  assert.ok(checks.has("medical-necessity:banned-patterns"));
  assert.ok(checks.has("medical-necessity:payer-readiness"));
});

test("case keys: every case folder with a key loads, and its key matches its case", () => {
  const folders = readdirSync(CASES, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.join(CASES, entry.name));
  const withKeys = folders.filter((folder) => existsSync(path.join(folder, "key.json")));
  assert.deepEqual(withKeys.map((folder) => path.basename(folder)).sort(), ["case-a-mateo", "case-b-sofia"]);
  for (const folder of withKeys) {
    const { key } = loadCase(folder);
    for (const source of key.extraSources) assert.ok(existsSync(path.join(folder, source.file)), `${source.file} is in ${folder}`);
    for (const source of key.sources) if (source.textOf) assert.ok(existsSync(path.join(folder, source.textOf)), `${source.textOf} is in ${folder}`);
    for (const section of REPORT_SECTIONS) assert.ok((key.sectionFacts[section.id] ?? []).length > 0, `${key.caseId} has facts for ${section.id}`);
  }
});

test("case keys: a gap that must be marked needs a marker pattern (review M1)", () => {
  const gap = { id: "g", gap: "A gap.", mustMarkIn: ["medical-necessity"] };
  assert.equal(CaseKeySchema.safeParse({ ...caseA.key, plantedGaps: [gap] }).success, false);
  assert.equal(CaseKeySchema.safeParse({ ...caseA.key, plantedGaps: [{ ...gap, marker: "date" }] }).success, true);
});

test("case keys: a key that names a source the case lacks is refused", () => {
  const problems = keyProblems(caseA.caseFile, { ...caseA.key, incidents: [{ ...caseA.key.incidents[0], from: ["iep"] }] });
  assert.deepEqual(problems, [`incident ${caseA.key.incidents[0].id} comes from unknown source iep`]);
});

/** The text a source gives the number check: a Markdown file as it is, a score report's HTML without its tags. */
function sourceText(folder: string, file: string): string {
  const raw = readFileSync(path.join(folder, file), "utf8");
  return file.endsWith(".html") ? raw.replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ") : raw;
}

test("case keys: the numbers in each key's facts are in that case's sources", () => {
  for (const loaded of [caseA, caseB]) {
    // A provisional fact rests on her standard practice, which no source gives yet.
    const files = [
      ...loaded.caseFile.sources.map((source) => loaded.key.sources.find((s) => s.id === source.id)?.textOf ?? source.file).filter((file) => !file.endsWith(".pdf")),
      ...loaded.key.extraSources.map((source) => source.file),
    ];
    const index = numberIndex([...files.map((file) => sourceText(loaded.folder, file)), loaded.key.inputs.notes ?? ""]);
    for (const [section, facts] of Object.entries(loaded.key.sectionFacts)) {
      for (const fact of (facts ?? []).filter((f) => !f.provisional)) {
        const findings = checkNumbers(section as never, fact.fact, index);
        assert.deepEqual(findings.map((f) => f.message), [], `${loaded.key.caseId} ${fact.id}`);
      }
    }
  }
});

/* Her answers of 2026-11-27 ------------------------------------------------------------ */

const ids = (findings: ReadonlyArray<{ message: string }>) => findings.map((f) => /^(?:Her wording \()?([a-z-]+)/.exec(f.message)?.[1]);

test("wording: long dashes, her banned words, the BCBA as observer, hypothesized, a severity level (markers included)", () => {
  assert.deepEqual(ids(checkWording("medical-necessity", "She ran — fast. Staff will utilize prompts. The BCBA observed her twice. Elopement is hypothesized to be maintained by escape.")), ["long-dash", "banned-word", "bcba-observed", "hypothesized"]);
  assert.deepEqual(ids(checkWording("risk-assessment", "The plan will facilitate access. Tasks leveraging her interest. She was observed by the BCBA.")), ["banned-word", "banned-word", "bcba-observed"]);
  assert.deepEqual(ids(checkWording("medical-necessity", "Autism Spectrum Disorder [MISSING: severity level, not in the CDE].")), ["severity-level"], "a marker asking for the level counts too");
  assert.deepEqual(ids(checkWording("background-information", "ASD, Level 2, requiring substantial support.")), ["severity-level"]);
  const clean = "During direct observation, Nadia was observed leaving the table 3 times in 3–5 minutes. Elopement is maintained by escape from demands. The BCBA will review the data weekly.";
  assert.deepEqual(checkWording("medical-necessity", clean), [], "an unspaced en dash in a range, 'is maintained by' and the BCBA's plan are fine");
  assert.deepEqual(checkWording("medical-necessity", 'Her mother said "they utilize a chart".'), [], "words inside a quote are the quote check's");
});

test("quotes: every quoted span outside a marker, straight or curly", () => {
  assert.equal(checkQuotes("risk-assessment", 'She said "I will hurt you" and then “no more”.').length, 2);
  assert.deepEqual(checkQuotes("risk-assessment", "She threatened to hurt her brother."), []);
  assert.deepEqual(checkQuotes("risk-assessment", 'Her mother reported threats [CHECK: the notes give "kill" in Spanish; keep it?].'), [], "a marker may quote its source");
  assert.deepEqual(checkQuotes("risk-assessment", 'A count of "3" is not speech: "12".'), [], "digits alone are not quoted speech");
});

test("dates and names: numeric dates, dates outside a coming change, professionals and caregivers by name", () => {
  const found = (text: string) => ids(checkDatesNames("medical-necessity", text));
  assert.deepEqual(found("During the observation on 10/05/2026, she ran."), ["numeric-date"]);
  assert.deepEqual(found("On October 10, 2026, she ran across the street."), ["full-date"]);
  assert.deepEqual(found("Her grandmother will travel from December 15, 2026 to January 20, 2027."), [], "the day a coming change starts may be given");
  assert.deepEqual(found("She has taken it since March 2026, and in September 2026 she needed urgent care."), [], "a month and year is not a date");
  assert.deepEqual(found("Dr. Supuesta completed the CDE."), ["doctor-name"]);
  assert.deepEqual(found("The CDE by Marta Supuesta, Ph.D., gives the diagnosis."), ["credentials"]);
  assert.deepEqual(found("Ms. Inventada reported it."), ["honorific-name"]);
  assert.deepEqual(found("According to the CDE, completed by the evaluating psychologist, her psychiatrist prescribes it."), []);
  assert.deepEqual(found("The BCBA will review the data. Each BCBA visit is logged."), [], "\"The BCBA\" is the form she requires, not a name with credentials");
});

test("numbers: a sibling aged 21 or older is her rule, not a number in need of a source", () => {
  const index = numberIndex(["Nothing with that number."]);
  assert.deepEqual(checkNumbers("crisis-plan", "A sibling aged 21 or older may be the designated caregiver.", index), []);
  assert.equal(checkNumbers("crisis-plan", "She hit 21 times.", index).length, 1);
});

test("payer readiness in the Crisis Plan: the dangerous behaviors, not early signs (her answers of 2026-11-27)", () => {
  const item = PAYER_ITEMS.find((p) => p.id === "cp-dangerous");
  assert.ok(item);
  assert.equal(PAYER_ITEMS.some((p) => p.id === "cp-signs"), false);
  assert.deepEqual(checkPayerReadiness("crisis-plan", "Physical aggression, property destruction and hand biting can be dangerous to her brother. The RBT or caregiver calls 911 when the situation gets out of control.", caseB.key), []);
});

test("runChecks runs her three new checks on every section", () => {
  const checks = new Set(runChecks({ "risk-assessment": 'Dr. Ejemplar said "no" — twice.' }, { key: testKey(), numbers: new Set(), shapes: {}, examples: [], loadedSources: new Set() }).map((f) => f.check));
  for (const check of ["wording", "quotes", "dates-names"] as const) assert.ok(checks.has(check), check);
});

test("payer readiness in Medical Necessity: the same criteria in other words (fix round 1 of T1)", () => {
  const item = (id: string) => PAYER_ITEMS.find((p) => p.id === id)!;
  const key = caseB.key;
  for (const text of ["ABA will address functioning outside school rather than duplicate the IEP.", "ABA does not duplicate the IEP's services.", "ABA complements the IEP."]) assert.equal(item("mn-complements").test(text, key).ok, true, text);
  assert.equal(item("mn-complements").test("The family repeats the routine.", key).ok, false);
  for (const text of ["Progress will be judged by direct data on target behaviors.", "The BCBA will judge progress from direct data.", "Progress will be measured with direct data."]) assert.equal(item("mn-measurement").test(text, key).ok, true, text);
  assert.equal(item("mn-measurement").test("Progress will be reviewed with the family.", key).ok, false);
});

test("review round 1 (findings 6 and 13): her wording and quotes let the sources' terms and the child's target phrases through", () => {
  const ids = (findings: ReturnType<typeof checkWording>) => findings.map((f) => /\((\S+)\)/.exec(f.message)?.[1]);
  for (const ok of [
    "The IEP gives support facilitation in the classroom.",
    "Services end when the frequency and severity of maladaptive behaviors no longer pose a barrier.",
    "The severity of the injuries increased over the last month.",
    "Sofia completed Level 1 milestones of the VB-MAPP.",
  ]) assert.deepEqual(checkWording("discharge-and-service-fading-plan", ok), [], ok);
  assert.deepEqual(ids(checkWording("background-information", "Autism Spectrum Disorder, Level 2.")), ["severity-level"]);
  assert.deepEqual(ids(checkWording("background-information", "The CDE gives a severity level.")), ["severity-level"]);
  assert.deepEqual(ids(checkWording("risk-assessment", "The plan will facilitate access.")), ["banned-word"]);
  assert.deepEqual(checkQuotes("medical-necessity", 'ABA will teach Sofia to say "break" when work is hard.'), []);
  assert.deepEqual(checkQuotes("medical-necessity", 'She will learn to request "all done" at the end of a task.'), []);
  assert.equal(checkQuotes("risk-assessment", 'She said "I will hurt you".').length, 1, "what someone said is still a quote");
  assert.equal(checkQuotes("risk-assessment", 'She will learn to say "I do not want to do this work right now".').length, 1, "a long quoted span is not a target phrase");
});

test("review round 1 (finding 7): dates and names leave fractions, 24/7 and credential lists alone, and exempt only a governed coming date", () => {
  const found = (text: string) => checkDatesNames("discharge-and-service-fading-plan", text).map((f) => f.message.split(":")[0]);
  for (const ok of [
    "She answered correctly on 2/10 opportunities.",
    "An adult supervises her 24/7 near the pool.",
    "Direct hours will be faded from the RBT, BCaBA, and BCBA levels as goals are met.",
    "Services will start on December 15, 2026.",
    "Her grandmother will travel from December 15, 2026.",
  ]) assert.deepEqual(found(ok), [], ok);
  assert.deepEqual(found("The CDE completed on March 3, 2026 found that ABA will be needed."), ["full-date"], "a past date is not exempt because the sentence also says will");
  assert.deepEqual(found("Services will start on December 15, 2026, after the evaluation of March 3, 2026."), ["full-date"], "the governed date is exempt, the other one is not");
});

test("review round 1 (findings 8 and 9): mn-measurement needs progress, cp-dangerous needs the behaviors by name", () => {
  const key = caseB.key;
  const item = (id: string) => PAYER_ITEMS.find((p) => p.id === id)!;
  for (const text of ["The Comprehensive Diagnostic Evaluation (CDE) is consistent with the direct data from the home.", "The findings of this assessment rest on the data gathered in the home and the community."]) {
    assert.equal(item("mn-measurement").test(text, key).ok, false, text);
  }
  assert.equal(item("cp-dangerous").test("Sofia has no history of crisis, and no harm has come to anyone.", key).ok, false);
  assert.equal(item("cp-dangerous").test("Physical aggression, property destruction and hand biting can be dangerous.", key).ok, true);
  assert.equal(item("cp-dangerous").test("Physical aggression and self-injury toward her hand can occur, and she may destroy property.", key).ok, true, "accepted forms count");
  assert.equal(item("cp-dangerous").test("Elopement, physical aggression and head hitting can put him at risk.", caseA.key).ok, true);
});

test("review round 2 (finding 1): a quote after saying or requesting is reported speech, flagged; a target phrase after to say or to request is not", () => {
  for (const speech of [
    'Her mother reported that Sofia screams, saying "leave me alone".',
    'When asked to do homework, she kept saying "no way".',
    'The teacher reported her requesting "my tablet now" during class.',
  ]) assert.equal(checkQuotes("risk-assessment", speech).length, 1, speech);
  assert.deepEqual(checkQuotes("medical-necessity", 'ABA will teach Sofia to say "break" when work is hard.'), []);
  assert.deepEqual(checkQuotes("medical-necessity", 'She will learn to request "all done" at the end of a task.'), []);
});

test("review round 2 (finding 2): only a future verb exempts a date; a bare from, to, until or through never does", () => {
  const found = (text: string) => checkDatesNames("risk-assessment", text).map((f) => f.message.split(":")[0]);
  for (const past of [
    "Prior to October 10, 2026, she had never left the home without an adult.",
    "Her grandmother traveled to Colombia from December 15, 2025 to January 20, 2026.",
    "Starting October 10, 2026, she refused school.",
    "From December 15, 2026, her grandmother will travel.",
  ]) assert.deepEqual(found(past), ["full-date"], past);
  for (const coming of [
    "Her grandmother will travel from December 15, 2026 to January 20, 2027.",
    "Services will start on December 15, 2026.",
    "The new school year starts on August 10, 2027.",
    "Her grandmother will be away from December 15, 2026, to January 20, 2027.",
    "Her mother confirmed that the program had accepted Sofía beginning December 15, 2026.",
  ]) assert.deepEqual(found(coming), [], coming);
});

test("review round 2 (nit 5): a curriculum level with adult support is not a severity level", () => {
  assert.deepEqual(checkWording("strengths-and-weaknesses", "Sofia completed Level 2 of the VB-MAPP with adult support."), []);
  assert.equal(checkWording("background-information", "ASD, Level 2, requiring substantial support.").length, 1);
  assert.equal(checkWording("background-information", "Autism Spectrum Disorder, Level 2.").length, 1);
});
