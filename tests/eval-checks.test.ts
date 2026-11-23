import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  checkBannedPatterns,
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
  assert.deepEqual(keys, ["date:10-07:2026", "date:10-07:2026", "time:3:30", "value:1000", "value:4.5", "value:1", "value:40"]);
  assert.deepEqual(statedNumbers("from 3:00 to 5:30 p.m.").map(lookupKey), ["time:3:00", "time:5:30"]);
  assert.deepEqual(statedNumbers("15:00").map(lookupKey), ["time:3:00"], "a 24-hour time is the same clock as 3:00 p.m.");
});

test("numbers: a number in no source is found; dates, times and values in the sources are not", () => {
  const index = numberIndex(["Observed 10/07/2026 from 3:30 to 5:30 p.m.; 6 episodes; standard score 81."]);
  assert.deepEqual(checkNumbers("medical-necessity", "On October 7, 2026 she had 6 episodes between 3:30 and 5:30; her score was 81.", index), []);
  const findings = checkNumbers("medical-necessity", "She had 7 episodes on 10/08/2026; 911 was never called.", index);
  assert.deepEqual(findings.map((f) => f.message), ['"10/08/2026" is in no source.', '"7" is in no source.']);
});

test("markers: a planted gap unmarked or filled is major; a malformed marker is minor", () => {
  const gap = caseB.key;
  const marked = "Autism Spectrum Disorder [MISSING: DSM-5 autism severity level from the CDE.] was diagnosed.";
  assert.deepEqual(checkMarkers("medical-necessity", marked, gap), []);
  const unmarked = checkMarkers("medical-necessity", "She was diagnosed with Autism Spectrum Disorder.", gap);
  assert.equal(unmarked.length, 1);
  assert.equal(unmarked[0].severity, "major");
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
  assert.deepEqual(findings.map((f) => f.message), [
    'Behavior "elopement" called "leaving the area".',
    "The mother is called by her or his given name (1 times); her style refers to caregivers by relation (provisional, pending her answer).",
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

test("repetition: an incident told outside its home in more sections than allowed", () => {
  const key = caseB.key;
  const loaded = new Set(["notes"]);
  const ymca = "The mother confirmed that the YMCA program accepted her.";
  const two = checkRepetition({ "environmental-changes": ymca, "family-caregiver-involvement": ymca.replace("confirmed", "said") }, key, loaded);
  assert.deepEqual(two.filter((f) => /YMCA/.test(f.message)), [], "home plus one reference is allowed");
  const three = checkRepetition({ "environmental-changes": "YMCA one.", "family-caregiver-involvement": "YMCA two.", "discharge-and-service-fading-plan": "YMCA three." }, key, loaded);
  assert.deepEqual(three.map((f) => f.section).sort(), ["discharge-and-service-fading-plan", "family-caregiver-involvement"]);
  assert.deepEqual(checkRepetition({ "environmental-changes": "YMCA.", "risk-assessment": "YMCA.", "crisis-plan": "YMCA." }, key, new Set()), [], "a note that was not given is not checked");
});

test("data density: three numbers with no clause of meaning", () => {
  assert.equal(checkDataDensity("medical-necessity", "She had 3, 1 and 2 episodes of aggression.").length, 1);
  assert.deepEqual(checkDataDensity("medical-necessity", "She had 3, 1 and 2 episodes of aggression, which limits her time with peers."), []);
  assert.deepEqual(checkDataDensity("medical-necessity", "Her standard score of 66 places her below 99 of 100 same-age peers."), []);
});

test("banned patterns: meta sentences, filler, first person and restraint; markers and quotes are not prose", () => {
  const found = (text: string) => checkBannedPatterns("discharge-and-service-fading-plan", text).map((f) => f.message.replace(/^Banned pattern \(([^)]+)\).*$/, "$1"));
  assert.deepEqual(found("These are school goals, not evidence that Sofía has met them."), ["meta-not-evidence"]);
  assert.deepEqual(found("It is important to note that she improved."), ["filler-important"]);
  assert.deepEqual(found("We will teach her to wait."), ["first-person"]);
  assert.deepEqual(found("Staff will use a physical hold if needed."), ["restraint"]);
  assert.deepEqual(found("No restraint or seclusion is used."), []);
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

test("payer readiness: the items of a section, each found or listed as missing", () => {
  const key = testKey();
  const findings = checkPayerReadiness("medical-necessity", "Autism Spectrum Disorder limits her at home.", key);
  const ids = findings.map((f) => /\(([^)]+)\)/.exec(f.message)?.[1]);
  assert.deepEqual(ids, ["mn-settings", "mn-functions", "mn-caregiver-training", "mn-measurement"]);
  const complete = "Autism Spectrum Disorder limits her at home and at school. Her aggression serves escape. Caregiver training will teach her mother. Progress will be measured with session data.";
  assert.deepEqual(checkPayerReadiness("medical-necessity", complete, key), []);
  for (const item of PAYER_ITEMS) assert.ok(REPORT_SECTIONS.some((s) => s.id === item.section), item.id);
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
    const files = [
      ...loaded.caseFile.sources.map((source) => loaded.key.sources.find((s) => s.id === source.id)?.textOf ?? source.file).filter((file) => !file.endsWith(".pdf")),
      ...loaded.key.extraSources.map((source) => source.file),
    ];
    const index = numberIndex([...files.map((file) => sourceText(loaded.folder, file)), loaded.key.inputs.notes ?? ""]);
    for (const [section, facts] of Object.entries(loaded.key.sectionFacts)) {
      for (const fact of facts ?? []) {
        const findings = checkNumbers(section as never, fact.fact, index);
        assert.deepEqual(findings.map((f) => f.message), [], `${loaded.key.caseId} ${fact.id}`);
      }
    }
  }
});
