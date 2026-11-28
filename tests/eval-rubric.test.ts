import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { checkBannedPatterns, checkShape, CHECK_IDS, type Finding } from "../eval/checks/checks.ts";
import { adoptRubricWhenRescored, baselineCaseLabel, rejudgedBaselineName, rescoredBaselineNote, reusableBaselineJudge, type SavedBaselineJudge, baselineCopy, caseMedians, compareRuns, exitCodeFor, failsInMost, incompleteParts, keepsEarlierJudge, localPathsIn, medianAnswer, medianScore, noiseOf, normalizeRun, rescoreRun, scoreSection, summaryMarkdown, verdictLine, type CaseRun, type JudgeRecord, type RunResult, type SectionResult } from "../eval/results.ts";
import { codeScore, keyFactsScore, RUBRIC, RUBRIC_VERSION, SECTION_EXPECTATIONS, SECTION_PAYER_FACTS, SECTION_SHAPES, STYLE_EXPECTATIONS, type CodeItem } from "../eval/rubric.ts";
import { buildJudgePrompt, JudgeInputSchema, judgeAnswerSchema, parseJudgeAnswer, type JudgeInput } from "../src/lib/judge.ts";
import { REPORT_SECTIONS, type ReportSectionId } from "../src/shared/report-sections.ts";

const finding = (check: Finding["check"], severity: Finding["severity"] = "major"): Finding => ({ check, section: "medical-necessity", message: "x", severity });

test("rubric: ids unique, every check scored by one code item, every section has her expectations; RUBRIC.md lists every item", () => {
  const ids = RUBRIC.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length);
  const checks = RUBRIC.filter((item): item is CodeItem => item.scoredBy === "code").map((item) => item.check);
  assert.deepEqual([...checks].sort(), [...CHECK_IDS].sort());
  for (const section of REPORT_SECTIONS) assert.ok(SECTION_EXPECTATIONS[section.id].length > 0, section.id);
  // The judge input takes at most 10 expectations per section (JudgeInputSchema): hers plus her habits.
  for (const section of REPORT_SECTIONS) assert.ok(SECTION_EXPECTATIONS[section.id].length + STYLE_EXPECTATIONS.length <= 10, `${section.id}: too many expectations for the judge input`);
  const doc = readFileSync(path.join(import.meta.dirname, "..", "eval", "RUBRIC.md"), "utf8");
  assert.match(doc, new RegExp(`^version: ${RUBRIC_VERSION}$`, "m"));
  for (const id of ids) assert.match(doc, new RegExp("`" + id + "`"), id);
  for (const [section, shape] of Object.entries(SECTION_SHAPES)) {
    if (shape?.words) assert.match(doc, new RegExp(`${shape.words.min}.{1,3}${shape.words.max}`), `${section} words in RUBRIC.md`);
  }
});

test("rubric: code scores from findings", () => {
  const item = (check: string) => RUBRIC.find((i) => i.scoredBy === "code" && i.check === check) as CodeItem;
  assert.equal(codeScore(item("numbers"), []), 2);
  assert.equal(codeScore(item("numbers"), [finding("numbers"), finding("numbers")]), 1);
  assert.equal(codeScore(item("numbers"), [finding("numbers"), finding("numbers"), finding("numbers")]), 0);
  assert.equal(codeScore(item("markers"), [finding("markers", "minor")]), 1);
  assert.equal(codeScore(item("markers"), [finding("markers")]), 0);
  assert.equal(codeScore(item("examples"), [finding("examples")]), 0);
  assert.equal(codeScore(item("numbers"), [finding("names")]), 2, "another check's findings do not count");
  assert.equal(codeScore(item("names"), [{ ...finding("names"), provisional: true }]), 2, "a provisional finding is not scored (review S1)");
  assert.equal(codeScore(item("payer-readiness"), [finding("payer-readiness")]), 1);
  assert.equal(codeScore(item("payer-readiness"), [finding("payer-readiness"), finding("payer-readiness")]), 0, "two missing is 0, as the anchor says (review S11)");
  assert.equal(keyFactsScore(["present", "present", "partial", "present"]), 1);
  assert.equal(keyFactsScore(Array(10).fill("present").concat(["partial"]) as never), 2);
  assert.equal(keyFactsScore(["absent", "present"]), 0);
});

test("rubric v2: Medical Necessity names what the child needs to learn, not procedures; pending rules are not scored; payer facts for every section", () => {
  const mn = SECTION_EXPECTATIONS["medical-necessity"].join(" ");
  assert.match(mn, /what the child needs to learn \(the reverse of the documented deficit\) and the general approach/);
  assert.match(mn, /is a proposal/);
  assert.doesNotMatch(mn, /by the program or procedure's name/);
  assert.match(SECTION_EXPECTATIONS["environmental-changes"].join(" "), /When her standing instructions give her standard supports/);
  assert.match(SECTION_EXPECTATIONS["discharge-and-service-fading-plan"].join(" "), /When her standing instructions give her standard criteria/);
  assert.doesNotMatch(STYLE_EXPECTATIONS.join(" "), /rarely by their own names/);
  const style = RUBRIC.find((item) => item.id === "style")!;
  assert.doesNotMatch(`${style.anchors[1]}`, /given name/);
  for (const section of REPORT_SECTIONS) assert.ok(SECTION_PAYER_FACTS[section.id].length > 0, section.id);
  assert.match(SECTION_PAYER_FACTS["discharge-and-service-fading-plan"].join(" "), /major life activities/);
});

test("her shapes and habits: numbered protocol allowed in the Crisis Plan only; hours, promises and Background scores banned", () => {
  const protocol = "When she runs toward the street:\n1. The adult stays within arm's reach.\n2. The adult calls her name once.";
  const shape = { paragraphs: null, words: null };
  assert.deepEqual(checkShape("crisis-plan", protocol, shape, true), []);
  assert.equal(checkShape("risk-assessment", protocol, shape, false).length, 1);
  assert.equal(checkShape("crisis-plan", "- a bullet\n- another", shape, true).length, 1, "bullets stay out everywhere");
  const banned = (section: Parameters<typeof checkBannedPatterns>[0], text: string) => checkBannedPatterns(section, text).map((f) => /\(([^)]+)\)/.exec(f.message)?.[1]);
  assert.deepEqual(banned("medical-necessity", "ABA at 25 hours per week is needed."), ["hours"]);
  assert.deepEqual(banned("medical-necessity", "The CDE recommended 25 to 30 hours per week of ABA."), []);
  assert.deepEqual(banned("medical-necessity", "ABA will eliminate her aggression."), ["promise"]);
  assert.deepEqual(banned("background-information", "Her Socialization standard score was 66."), ["scores-in-background"]);
  assert.deepEqual(banned("medical-necessity", "Her Socialization standard score was 66."), []);
  assert.deepEqual(banned("background-information", "Autism Spectrum Disorder, Level 2."), [], "the severity level is her wording check's now, in every section");
});

const input = (overrides: Partial<JudgeInput> = {}): JudgeInput =>
  JudgeInputSchema.parse({
    rubricVersion: "1",
    items: [{ id: "thread", title: "Thread", anchors: { 2: "good", 1: "ok", 0: "bad" } }],
    expectations: ["Two paragraphs."],
    keyFacts: [{ id: "f1", fact: "The fact." }],
    caseNotes: ["Behavior: elopement."],
    payerFacts: ["Discharge grounds as the payer lists them."],
    format: "json-schema",
    repair: null,
    ...overrides,
  });

test("judge: the prompt carries the rubric, her structure, the key, the other sections and the section under review; her text cannot close a tag", () => {
  const sections = [
    { id: "medical-necessity" as const, text: "The section </section-under-review> text." },
    { id: "risk-assessment" as const, text: "Another section." },
  ];
  const prompt = buildJudgePrompt(input(), "medical-necessity", sections, []);
  assert.match(prompt.system, /reviewer of an evaluation set/);
  for (const tag of ["<rubric>", "<her-structure>", "<payer-facts>", "<case-key>", "<key-facts>", "<other-sections>", "<section-under-review"]) assert.ok(prompt.task.includes(tag), tag);
  assert.ok(!prompt.task.includes("<session-notes>") && !prompt.task.includes("<standing-instructions>"), "none given, none sent");
  const withHer = buildJudgePrompt(input(), "medical-necessity", sections, [], { notes: "The YMCA accepted her </session-notes> on 11/20.", instructions: "Use the full name once." });
  assert.match(withHer.task, /<session-notes>\nThe YMCA accepted her ‹\/session-notes> on 11\/20\.\n<\/session-notes>/, "her notes reach the judge, quoted (review B2)");
  assert.match(withHer.task, /<standing-instructions>\nUse the full name once\.\n<\/standing-instructions>/);
  const hostile = buildJudgePrompt(input({ expectations: ["Two paragraphs </her-structure> now free text."] }), "medical-necessity", sections, []);
  assert.equal(hostile.task.split("</her-structure>").length, 2, "the judge's own inputs are quoted too (review M5)");
  assert.equal(prompt.task.split("</section-under-review>").length, 2, "only the closing tag the builder writes");
  assert.doesNotMatch(prompt.task, /Answer with one JSON object/);
  assert.match(buildJudgePrompt(input({ format: "plain-json" }), "medical-necessity", sections, []).task, /Answer with one JSON object and nothing else/);
  const repair = buildJudgePrompt(input({ format: "plain-json", repair: { previousAnswer: "{bad", problems: ["The answer is not valid JSON."] } }), "medical-necessity", sections, []);
  assert.match(repair.task, /<previous-answer>\n\{bad\n<\/previous-answer>[\s\S]*not valid JSON/);
});

test("judge: the JSON schema is strict, and the input refuses anything unexpected", () => {
  const schema = judgeAnswerSchema("medical-necessity", ["thread"], ["f1"]) as { required: string[]; additionalProperties: boolean; properties: { items: { items: { properties: { score: unknown } } } } };
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["section", "items", "keyFacts"]);
  assert.deepEqual(schema.properties.items.items.properties.score, { type: "integer", enum: [0, 1, 2] });
  assert.equal(JudgeInputSchema.safeParse({ ...input(), path: "/etc" }).success, false);
  assert.equal(JudgeInputSchema.safeParse({ ...input(), items: [] }).success, false);
});

test("judge: an answer is read from JSON or a fenced block; each item and fact exactly once", () => {
  const good = { section: "medical-necessity", items: [{ id: "thread", score: 2, reason: "r", evidence: [] }], keyFacts: [{ id: "f1", status: "present", quote: "q" }] };
  assert.equal(parseJudgeAnswer(JSON.stringify(good), "medical-necessity", ["thread"], ["f1"]).ok, true);
  assert.equal(parseJudgeAnswer("```json\n" + JSON.stringify(good) + "\n```", "medical-necessity", ["thread"], ["f1"]).ok, true);
  assert.equal(parseJudgeAnswer("Here you go: " + JSON.stringify(good), "medical-necessity", ["thread"], ["f1"]).ok, true);
  const bad = parseJudgeAnswer(JSON.stringify({ ...good, items: [...good.items, ...good.items], keyFacts: [] }), "medical-necessity", ["thread", "style"], ["f1"]);
  assert.deepEqual(bad.ok ? [] : bad.problems, ['Rubric item "thread" is answered 2 times.', 'Rubric item "style" is missing.', 'Key fact "f1" is missing.']);
  const score3 = parseJudgeAnswer(JSON.stringify({ ...good, items: [{ ...good.items[0], score: 3 }] }), "medical-necessity", ["thread"], ["f1"]);
  assert.equal(score3.ok, false);
  assert.deepEqual(parseJudgeAnswer("not json", "medical-necessity", [], []), { ok: false, problems: ["The answer is not valid JSON."] });
});

function section(id: SectionResult["id"], findings: Finding[], scores: Record<string, 0 | 1 | 2 | null>, fingerprint = "judge-a"): SectionResult {
  return {
    id,
    version: 1,
    text: "Text.",
    words: 1,
    paragraphs: 1,
    markers: [],
    generation: null,
    consistency: null,
    draftError: null,
    findings,
    scores,
    judge: { format: "json-schema", repaired: false, answers: [], error: null, requests: 1, seconds: 1, usage: null, fingerprint },
  };
}

/** A run of one case with a single run of these sections. */
function run(sections: SectionResult[], overrides: Partial<RunResult> = {}): RunResult {
  return runs([sections], overrides);
}

/** A run of one case with one run per list of sections, its medians worked out. */
function runs(perRun: SectionResult[][], overrides: Partial<RunResult> = {}): RunResult {
  const caseRuns: CaseRun[] = perRun.map((sections, index) => ({ run: index + 1, sections }));
  return {
    resultsVersion: 3,
    label: "t",
    startedAt: "a",
    finishedAt: "b",
    rubricVersion: RUBRIC_VERSION,
    judgePromptVersion: "2",
    checksVersion: "2",
    runs: perRun.length,
    judgeSamples: 1,
    drafting: { label: "this checkout", commit: "abcdef0", branch: "dev", dirty: false, rulesVersions: {} },
    judging: { label: "this checkout", commit: "abcdef0", branch: "eval", dirty: false, model: "m" },
    provider: "openai",
    model: "m",
    mode: "chained",
    judgeFormat: "json-schema",
    requests: { drafts: 1, checks: 0, judges: 1, repairs: 0, baselineJudges: 0, total: 2 },
    launches: [{ role: "draft", visibleWindows: 0, dockVisible: false, focusedWindows: 0, at: "launch" }],
    windowChecksDuring: 3,
    valid: true,
    invalidReason: null,
    cases: [{ caseId: "case-b-sofia", keyVersion: "2", sourcesLoaded: [], inputs: { notes: "", instructions: {} }, runs: caseRuns, medians: caseMedians(caseRuns) }],
    ...overrides,
  };
}

test("compare: the hard verdict is code drops, newly failing checks and unscored items; judge moves are apart (review B3)", () => {
  const baseline = run([section("medical-necessity", [], { thread: 2, "numbers-sourced": 2, style: 1, attribution: 1 })]);
  const same = compareRuns(baseline, baseline);
  assert.equal(same.status, "pass");
  assert.match(verdictLine(same), /^No hard regression/);
  const judgeOnly = compareRuns(run([section("medical-necessity", [], { thread: 1, "numbers-sourced": 2, style: 2, attribution: 1 })]), baseline);
  assert.equal(judgeOnly.status, "pass", "a judge drop alone is not the hard verdict");
  assert.deepEqual(judgeOnly.judgeDrops.map((d) => d.item), ["thread"]);
  assert.deepEqual(judgeOnly.judgeRises.map((d) => d.item), ["style"]);
  assert.match(verdictLine(judgeOnly), /Judge item medians, apart from the verdict: 1 down, 1 up/);
  const worse = run([section("medical-necessity", [{ ...finding("numbers"), message: '"7" is in no source.' }], { thread: 1, "numbers-sourced": 1, style: null, attribution: 1 })]);
  const comparison = compareRuns(worse, baseline);
  assert.equal(comparison.status, "regression");
  assert.deepEqual(comparison.codeDrops.map((d) => `${d.item}:${d.from}->${d.to}`), ["numbers-sourced:2->1"]);
  assert.deepEqual(comparison.newFailures.map((f) => f.check), ["numbers"]);
  assert.deepEqual(comparison.unscored.map((u) => u.item), ["style"]);
  assert.equal(exitCodeFor(comparison, worse), 2);
  const summary = summaryMarkdown(worse, comparison, "baseline-1", baseline);
  assert.match(summary, /\*\*REGRESSION/);
  assert.match(summary, /## Hard: code item medians that went down\n\n- case-b-sofia MN numbers-sourced: 2 → 1 \(runs 2 → 1\)/);
  assert.match(summary, /\| numbers-sourced \(code\) \| 2 → 1 \|/);
});

test("compare: a provisional finding never fails a check, and judge items of another judge are not compared", () => {
  const baseline = run([section("medical-necessity", [], { names: 2, thread: 2 })]);
  const provisional = run([section("medical-necessity", [{ ...finding("names"), provisional: true }], { names: 2, thread: 0 }, "judge-b")]);
  const comparison = compareRuns(provisional, baseline);
  assert.equal(comparison.status, "pass");
  assert.deepEqual(comparison.newFailures, []);
  assert.deepEqual(comparison.judgeDrops, [], "another judge: not compared");
  assert.deepEqual(comparison.judgeNotCompared.map((s) => s.section), ["medical-necessity"]);
});

test("compare: NOT COMPARED with another rubric, provider or mode; new cases noted; an invalid run fails (review S8, S9)", () => {
  const baseline = run([section("medical-necessity", [], { thread: 2 })]);
  const other = compareRuns(run(baseline.cases[0].runs[0].sections, { rubricVersion: "1" }), baseline);
  assert.equal(other.status, "not-compared");
  assert.match(verdictLine(other), /^NOT COMPARED: the baseline used rubric version/);
  assert.equal(exitCodeFor(other, baseline), 3);
  assert.equal(compareRuns(run(baseline.cases[0].runs[0].sections, { provider: "rehearsal (fake provider)" }), baseline).status, "not-compared");
  assert.equal(compareRuns(run(baseline.cases[0].runs[0].sections, { mode: "independent" }), baseline).status, "not-compared");
  const more = run(baseline.cases[0].runs[0].sections);
  more.cases.push({ ...more.cases[0], caseId: "case-a-mateo" });
  assert.ok(compareRuns(more, baseline).notes.some((note) => /case-a-mateo is new/.test(note)));
  const invalid = run(baseline.cases[0].runs[0].sections, { valid: false, invalidReason: "a window showed" });
  assert.equal(compareRuns(invalid, baseline).status, "invalid");
  assert.equal(exitCodeFor(null, invalid), 1);
  assert.match(verdictLine(null, invalid), /^INVALID/);
});

test("compare: the baseline's code items are scored again with the current checks (review B3)", () => {
  const baseline = run([section("medical-necessity", [finding("numbers")], { "numbers-sourced": 1, thread: 2 })]);
  const rescored = rescoreRun(baseline, new Map([["case-b-sofia", [[]]]]));
  assert.equal(rescored.cases[0].runs[0].sections[0].scores["numbers-sourced"], 2);
  assert.equal(rescored.cases[0].medians[0].scores["numbers-sourced"], 2, "the medians are worked out again");
  assert.equal(baseline.cases[0].runs[0].sections[0].scores["numbers-sourced"], 1, "the baseline itself is not changed");
});

test("samples: each item and fact is the median of the answers", () => {
  const answer = (thread: 0 | 1 | 2, status: "present" | "partial" | "absent") => ({ section: "medical-necessity", items: [{ id: "thread", score: thread, reason: String(thread), evidence: [] }], keyFacts: [{ id: "f", status, quote: "" }] });
  const median = medianAnswer([answer(2, "present"), answer(0, "absent"), answer(1, "present")])!;
  assert.equal(median.items[0].score, 1);
  assert.equal(median.items[0].reason, "1");
  assert.equal(median.keyFacts[0].status, "present");
  assert.equal(medianAnswer([]), null);
});

test("scoreSection: code items from findings, judge items from the answers, null when nothing to score", () => {
  const answer = { section: "medical-necessity", items: [{ id: "thread", score: 1 as const, reason: "", evidence: [] }], keyFacts: [{ id: "f", status: "present" as const, quote: "" }] };
  const scores = scoreSection("medical-necessity", [finding("numbers")], [answer], true);
  assert.equal(scores["numbers-sourced"], 1);
  assert.equal(scores.thread, 1);
  assert.equal(scores["key-facts"], 2);
  assert.equal(scores.style, null, "an item the judge did not answer");
  assert.ok(Object.values(scoreSection("medical-necessity", [], [], false)).every((score) => score === null));
  assert.equal(scores["definition-topography"], undefined, "later-stage items are not scored yet");
});

/** Invented local paths, built from parts so no path appears literally in the repository. */
const fakePath = (...parts: string[]) => `/${parts.join("/")}`;
const MAC_HOME = fakePath("Users", "ana");

test("older results: paths become labels, the single answer becomes a list, and no fingerprint means not comparable", () => {
  const old = {
    ...run([]),
    resultsVersion: 1,
    drafting: { checkout: fakePath("Users", "someone", "work", "dev-checkout"), commit: "363e3d7", branch: "HEAD", dirty: false, rulesVersions: {} },
    judging: { checkout: fakePath("Users", "someone", "work", "eval-harness"), commit: "abc" },
    cases: [{ caseId: "case-b-sofia", keyVersion: "1", sourcesLoaded: [], sections: [{ ...section("medical-necessity", [], { thread: 2 }), judge: { format: "json-schema", repaired: false, answer: { section: "medical-necessity", items: [], keyFacts: [] }, error: null, requests: 1, seconds: 1, usage: null } }] }],
  };
  delete (old as Record<string, unknown>).checksVersion;
  delete (old as Record<string, unknown>).runs;
  const read = normalizeRun(old);
  assert.equal(read.runs, 1, "a file from before runs is one run of each case");
  assert.equal(read.cases[0].runs.length, 1);
  assert.equal(read.cases[0].medians[0].scores.thread, 2);
  assert.equal((read.cases[0] as unknown as { sections?: unknown }).sections, undefined);
  assert.equal(read.drafting.label, "dev-checkout");
  assert.equal(read.judging.label, "eval-harness");
  assert.equal(read.checksVersion, "1");
  assert.equal(read.cases[0].runs[0].sections[0].judge?.answers.length, 1);
  assert.equal(read.cases[0].runs[0].sections[0].judge?.fingerprint, "");
  assert.deepEqual(localPathsIn(read, { home: fakePath("Users", "someone"), user: "someone" }), [], "no path is left");
});

test("baselines hold no local path, home folder or user name (review B4)", () => {
  const clean = run([section("medical-necessity", [], { thread: 2 })]);
  assert.deepEqual(localPathsIn(baselineCopy(clean, { home: MAC_HOME, user: "ana" }), { home: MAC_HOME, user: "ana" }), []);
  const withPath = run([{ ...section("medical-necessity", [], { thread: 2 }), draftError: `could not read ${MAC_HOME}/x` }]);
  assert.throws(() => baselineCopy(withPath, { home: MAC_HOME, user: "ana" }), /no local path/);
  const withUser = run([{ ...section("medical-necessity", [], { thread: 2 }), text: "Saved by ana yesterday." }]);
  assert.throws(() => baselineCopy(withUser, { home: MAC_HOME, user: "ana" }), /no local path/);
  for (const sample of [["C:", "Users", "ana", "x"].join("\\"), fakePath("private", "tmp", "x"), fakePath("home", "ana", "x"), fakePath("var", "folders", "ab", "x")]) assert.ok(localPathsIn({ sample }, { home: "/nowhere", user: "nobody" }).length === 1, sample);
});

/* Runs and medians (owner's decision, 2026-11-23: each case runs 3 times and the medians are compared). */

const numbersFinding = (message = '"7" is in no source.'): Finding => ({ ...finding("numbers"), message });
/** A Medical Necessity section whose numbers check found something (score 1) or nothing (2), with a thread score. */
const mn = (numbersFail: boolean, thread: 0 | 1 | 2 = 2, fingerprint = "judge-a") =>
  section("medical-necessity", numbersFail ? [numbersFinding()] : [], { "numbers-sourced": numbersFail ? 1 : 2, thread }, fingerprint);

test("runs: an item's score is the median of its runs, unscored when any run could not score it; a check fails in most runs", () => {
  assert.equal(medianScore([2, 1, 2]), 2);
  assert.equal(medianScore([0, 2, 1]), 1);
  assert.equal(medianScore([2]), 2);
  assert.equal(medianScore([2, null, 2]), null, "missing in one run: unscored (owner's choice)");
  assert.equal(medianScore([]), null);
  assert.equal(failsInMost(2, 3), true);
  assert.equal(failsInMost(1, 3), false);
  assert.equal(failsInMost(undefined, 3), false);
  assert.equal(failsInMost(1, 1), true, "one run: as before");
  assert.equal(failsInMost(3, 5), true);
  const [median] = caseMedians([{ run: 1, sections: [mn(false, 2)] }, { run: 2, sections: [mn(true, 0)] }, { run: 3, sections: [mn(false, 1)] }]);
  assert.equal(median.scores["numbers-sourced"], 2);
  assert.equal(median.scores.thread, 1);
  assert.deepEqual(median.spread["numbers-sourced"], [2, 1, 2]);
  assert.deepEqual(median.spread.thread, [2, 0, 1]);
  assert.equal(median.failing.numbers, 1);
  assert.equal(median.drafted, 3);
  const provisional = caseMedians([{ run: 1, sections: [section("medical-necessity", [{ ...finding("names"), provisional: true }], { names: 2 })] }]);
  assert.equal(provisional[0].failing.names, undefined, "a provisional finding never makes a check fail");
});

test("compare on medians: a drop in one run of three is not a regression; in two of three it is", () => {
  const baseline = runs([[mn(false)], [mn(false)], [mn(false)]]);
  const oneRun = runs([[mn(false)], [mn(true)], [mn(false)]]);
  const single = compareRuns(oneRun, baseline);
  assert.equal(single.status, "pass", "a single-run drop is noise: the median holds and the check passes in 2 of 3");
  assert.deepEqual(single.codeDrops, []);
  assert.deepEqual(single.newFailures, []);
  const twoRuns = runs([[mn(true)], [mn(true)], [mn(false)]]);
  const majority = compareRuns(twoRuns, baseline);
  assert.equal(majority.status, "regression");
  assert.deepEqual(majority.codeDrops.map((d) => `${d.item}:${d.from}->${d.to} ${d.fromRuns.join("")}->${d.toRuns.join("")}`), ["numbers-sourced:2->1 222->112"]);
  assert.deepEqual(majority.newFailures.map((f) => `${f.check} ${f.failing}/${f.runs} (was ${f.baselineFailing}/${f.baselineRuns})`), ["numbers 2/3 (was 0/3)"]);
  assert.deepEqual(majority.newFailures[0].findings, ['run 1: "7" is in no source.', 'run 2: "7" is in no source.']);
  assert.equal(exitCodeFor(majority, twoRuns), 2);
  const summary = summaryMarkdown(twoRuns, majority, "baseline-3", baseline);
  assert.match(summary, /3 runs per case, each drafted and judged on its own/);
  assert.match(summary, /## Hard: code item medians that went down\n\n- case-b-sofia MN numbers-sourced: 2 → 1 \(runs 2·2·2 → 1·1·2\)/);
  assert.match(summary, /fails in 2 of 3 runs \(baseline 0 of 3\)/);
  assert.match(summary, /Spread over the 3 runs/);
  assert.match(summary, /\| numbers-sourced \(code\) \| \*\*1·1·2\*\* \|/, "the noise is visible");
  assert.match(summary, /the runs disagree on 1 of \d+ code item scores/);
  // A check that already failed in most baseline runs is not new.
  const failingBefore = runs([[mn(true)], [mn(true)], [mn(false)]]);
  assert.deepEqual(compareRuns(twoRuns, failingBefore).newFailures, []);
});

test("compare on medians: judge medians are apart from the verdict; an item missing in one run is unscored", () => {
  const baseline = runs([[mn(false, 2)], [mn(false, 2)], [mn(false, 1)]]);
  const oneLower = compareRuns(runs([[mn(false, 2)], [mn(false, 0)], [mn(false, 2)]]), baseline);
  assert.deepEqual(oneLower.judgeDrops, [], "a judge drop in one run leaves the median");
  const twoLower = compareRuns(runs([[mn(false, 1)], [mn(false, 0)], [mn(false, 2)]]), baseline);
  assert.equal(twoLower.status, "pass", "judge medians never make the hard verdict");
  assert.deepEqual(twoLower.judgeDrops.map((d) => `${d.item}:${d.from}->${d.to}`), ["thread:2->1"]);
  const otherJudge = compareRuns(runs([[mn(false, 1)], [mn(false, 0, "judge-b")], [mn(false, 2)]]), baseline);
  assert.deepEqual(otherJudge.judgeDrops, [], "another judge in any run: not compared");
  assert.deepEqual(otherJudge.judgeNotCompared.map((s) => s.section), ["medical-necessity"]);
  const missing = runs([[mn(false)], [section("medical-necessity", [], { "numbers-sourced": 2, thread: null })], [mn(false)]]);
  const unscored = compareRuns(missing, baseline);
  assert.equal(unscored.status, "regression");
  assert.deepEqual(unscored.unscored.map((u) => `${u.item} ${u.toRuns.map(String).join(",")}`), ["thread 2,null,2"]);
});

test("compare on medians: the 1-run baseline is still compared, as a single run, with a note (owner's choice)", () => {
  const oldBaseline = run([mn(false)]);
  const now = runs([[mn(false)], [mn(true)], [mn(false)]]);
  const comparison = compareRuns(now, oldBaseline);
  assert.equal(comparison.status, "pass");
  assert.ok(comparison.notes.some((note) => /Runs per case differ: 1 run in the baseline, 3 now/.test(note)));
  assert.equal(compareRuns(runs([[mn(true)], [mn(true)], [mn(false)]]), oldBaseline).status, "regression");
});

test("rescore: every stored run of the baseline is checked again, and its medians follow", () => {
  const baseline = runs([[mn(true)], [mn(true)], [mn(false)]]);
  assert.equal(baseline.cases[0].medians[0].scores["numbers-sourced"], 1);
  const rescored = rescoreRun(baseline, new Map([["case-b-sofia", [[], [numbersFinding()], []]]]));
  assert.deepEqual(rescored.cases[0].medians[0].spread["numbers-sourced"], [2, 1, 2]);
  assert.equal(rescored.cases[0].medians[0].scores["numbers-sourced"], 2);
  assert.equal(rescored.cases[0].medians[0].failing.numbers, 1);
  assert.equal(baseline.cases[0].medians[0].scores["numbers-sourced"], 1, "the baseline itself is not changed");
});

test("noise: how many items the runs disagree on, of those every run scored", () => {
  const noisy = runs([[mn(false, 2)], [mn(true, 2)], [mn(false, 0)]]);
  const noise = noiseOf(noisy);
  assert.equal(noise.code[0], 1);
  assert.equal(noise.judge[0], 1);
  assert.equal(noise.judge[1] > 0 && noise.code[1] > 0, true);
});

test("baselines hold no local path in any run (review B4), and normalizeRun reads every run", () => {
  const clean = runs([[mn(false)], [mn(false)], [mn(false)]]);
  assert.deepEqual(localPathsIn(baselineCopy(clean, { home: MAC_HOME, user: "ana" }), { home: MAC_HOME, user: "ana" }), []);
  const third = runs([[mn(false)], [mn(false)], [{ ...mn(false), text: `Copied from ${MAC_HOME}/notes.txt` }]]);
  assert.throws(() => baselineCopy(third, { home: MAC_HOME, user: "ana" }), /no local path/, "a path in the third run is found too");
  const read = normalizeRun(JSON.parse(JSON.stringify(clean)));
  assert.equal(read.runs, 3);
  assert.deepEqual(read.cases[0].runs.map((r) => r.run), [1, 2, 3]);
  assert.deepEqual(read.cases[0].medians, clean.cases[0].medians);
});

/* Review round 1 of the 3-run evaluation: failed drafts and unscored baseline items. */

/** A Medical Necessity section whose draft failed in that run: no text, nothing scored, no judge. */
const failedDraft = (id: SectionResult["id"] = "medical-necessity"): SectionResult => ({
  ...section(id, [], { "numbers-sourced": null, thread: null }),
  text: null,
  words: 0,
  draftError: "provider_unavailable: the provider did not answer",
  judge: null,
});

test("S1: a baseline run with a failed draft never turns a check that failed in most runs into a false new failure, and is said so", () => {
  // The check failed in baseline runs 1 and 2; run 2's draft is gone, so only 1 of 3 has the finding.
  const baseline = runs([[mn(true)], [failedDraft()], [mn(false)]]);
  const now = runs([[mn(true)], [mn(true)], [mn(false)]]);
  const comparison = compareRuns(now, baseline);
  assert.deepEqual(comparison.newFailures, [], "no false new failure");
  assert.deepEqual(comparison.checksNotCompared, [{ caseId: "case-b-sofia", section: "medical-necessity", drafted: 2, runs: 3 }]);
  assert.deepEqual(comparison.baselineUnscored.map((u) => `${u.item} ${u.fromRuns.map(String).join(",")}`), ["numbers-sourced 1,null,2", "thread 2,null,2"]);
  assert.equal(comparison.status, "pass");
  assert.match(verdictLine(comparison), /Not compared: 2 items the baseline could not score; the checks of 1 section with a baseline run missing its draft\./);
  const summary = summaryMarkdown(now, comparison, "b", baseline);
  assert.match(summary, /## Not compared: the baseline could not score these\n\n- case-b-sofia MN numbers-sourced \(baseline runs 1·–·2\)/);
  assert.match(summary, /## Checks not compared: a baseline run has no draft of the section\n\n- case-b-sofia MN: drafted in 2 of 3 baseline runs/);
  // The hidden drop of the review's probe: every MN score at 0 now is listed, never silent.
  const zero = runs([[section("medical-necessity", [numbersFinding(), numbersFinding(), numbersFinding()], { "numbers-sourced": 0, thread: 0 })], [section("medical-necessity", [numbersFinding(), numbersFinding(), numbersFinding()], { "numbers-sourced": 0, thread: 0 })], [section("medical-necessity", [numbersFinding(), numbersFinding(), numbersFinding()], { "numbers-sourced": 0, thread: 0 })]]);
  assert.equal(compareRuns(zero, baseline).baselineUnscored.length, 2);
});

test("S1: a failed draft in one current run leaves its items unscored (hard), with the way to fill each kind of gap", () => {
  const baseline = runs([[mn(false)], [mn(false)], [mn(false)]]);
  const now = runs([[mn(false)], [failedDraft()], [mn(false)]]);
  const comparison = compareRuns(now, baseline);
  assert.equal(comparison.status, "regression");
  assert.deepEqual(comparison.unscored.map((u) => u.item), ["numbers-sourced", "thread"]);
  assert.deepEqual(comparison.newFailures, []);
  assert.match(summaryMarkdown(now, comparison, "b", baseline), /A missing judge answer is filled with `--from-run <this run>`; a failed draft needs a new run\./);
});

test("S2: a baseline item left unscored by a judge request that failed is listed as not compared, not dropped", () => {
  const judgeFailed = { ...mn(false), scores: { "numbers-sourced": 2 as const, thread: null }, judge: { ...mn(false).judge!, answers: [], error: "server_is_overloaded: try again" } };
  const baseline = runs([[judgeFailed], [mn(false, 2)], [mn(false, 2)]]);
  const now = runs([[mn(false, 0)], [mn(false, 0)], [mn(false, 0)]]);
  const comparison = compareRuns(now, baseline);
  assert.deepEqual(comparison.judgeDrops, []);
  assert.deepEqual(comparison.baselineUnscored.map((u) => u.item), ["thread"]);
  assert.match(verdictLine(comparison), /Not compared: 1 item the baseline could not score\./);
});

test("S1: a run with a failed draft, a judge error or an unscored item is never accepted", () => {
  assert.deepEqual(incompleteParts(runs([[mn(false)], [mn(false)], [mn(false)]])), []);
  assert.deepEqual(incompleteParts(runs([[mn(false)], [failedDraft()], [mn(false)]])), ["case-b-sofia run 2 MN: no draft (provider_unavailable: the provider did not answer)"]);
  const judgeError = { ...mn(false), scores: { "numbers-sourced": 2 as const, thread: null }, judge: { ...mn(false).judge!, answers: [], error: "repair failed" } };
  assert.deepEqual(incompleteParts(runs([[judgeError], [mn(false)], [mn(false)]])), ["case-b-sofia run 1 MN: judge error (repair failed)"]);
  const unscored = { ...mn(false), scores: { "numbers-sourced": 2 as const, thread: null } };
  assert.deepEqual(incompleteParts(runs([[mn(false)], [mn(false)], [unscored]])), ["case-b-sofia run 3 MN: not scored: thread"]);
});

test("m4: --from-run keeps an earlier judge answer only from the same judge with every sample; --rejudge never", () => {
  const record = (overrides: Partial<JudgeRecord> = {}): JudgeRecord => ({ ...mn(false).judge!, answers: [{ section: "medical-necessity", items: [], keyFacts: [] }], ...overrides });
  assert.equal(keepsEarlierJudge(record(), "judge-a", 1, false), true);
  assert.equal(keepsEarlierJudge(record(), "judge-a", 1, true), false, "--rejudge");
  assert.equal(keepsEarlierJudge(record(), "judge-b", 1, false), false, "another judge");
  assert.equal(keepsEarlierJudge(record(), "judge-a", 3, false), false, "fewer samples than asked");
  assert.equal(keepsEarlierJudge(record({ answers: [], error: "timeout" }), "judge-a", 1, false), false, "a failed judge request is judged again");
  assert.equal(keepsEarlierJudge(null, "judge-a", 1, false), false);
});

test("m2: one run against a 3-run baseline says its hard verdict is not reliable", () => {
  const baseline = runs([[mn(false)], [mn(false)], [mn(false)]]);
  const note = compareRuns(run([mn(false)]), baseline).notes.find((n) => n.startsWith("Runs per case differ"));
  assert.match(note ?? "", /3 runs in the baseline, 1 now; .*this run's hard verdict is not reliable.*Run 3 to decide\./);
  assert.doesNotMatch(compareRuns(baseline, run([mn(false)])).notes.join(" "), /not reliable/, "more runs than the baseline: no warning");
});

type Rejudged = ReadonlyMap<string, ReadonlyArray<ReadonlyMap<ReportSectionId, JudgeRecord>>>;
const rejudgedOf = (perRun: Array<Array<[ReportSectionId, JudgeRecord]>>): Rejudged => new Map([["case-b-sofia", perRun.map((entries) => new Map(entries))]]);

test("rubric v3: a baseline of another rubric version is compared only when every stored draft was judged again in this run", () => {
  const judged = (error: string | null = null): JudgeRecord => ({ format: "json-schema", repaired: false, answers: error ? [] : ([{ section: "medical-necessity", items: [], keyFacts: [] }] as never), error, requests: 1, seconds: 1, usage: null, fingerprint: "new" });
  const both = (): Array<[ReportSectionId, JudgeRecord]> => [["medical-necessity", judged()], ["risk-assessment", judged()]];
  const old = runs([[section("medical-necessity", [], { thread: 2 }), section("risk-assessment", [], { thread: 2 })], [section("medical-necessity", [], { thread: 2 }), section("risk-assessment", [], { thread: 2 })]], { rubricVersion: "2" });
  const current = runs([[section("medical-necessity", [], { thread: 2 })]]);
  assert.equal(compareRuns(current, old).status, "not-compared", "another rubric version is refused as it is");
  const adopted = adoptRubricWhenRescored(old, current, rejudgedOf([both(), both()]));
  assert.equal(adopted.rubricVersion, RUBRIC_VERSION);
  assert.equal(adopted.rescoredFromRubric, "2");
  const comparison = compareRuns(current, adopted);
  assert.notEqual(comparison.status, "not-compared");
  assert.ok(comparison.notes.some((note) => /stored drafts, re-judged, not drafted again/.test(note)), "the comparison says what the baseline arm is");
  assert.match(summaryMarkdown(current, comparison, "dev", adopted), /stored drafts, re-judged/);
  // Partly judged again: still refused.
  assert.equal(compareRuns(current, adoptRubricWhenRescored(old, current, rejudgedOf([both(), [["medical-necessity", judged()]]]))).status, "not-compared", "a section left unjudged keeps it refused");
  assert.equal(adoptRubricWhenRescored(old, current, rejudgedOf([both()])).rubricVersion, "2", "a run left unjudged keeps it refused");
  assert.equal(adoptRubricWhenRescored(old, current, rejudgedOf([both(), [["medical-necessity", judged()], ["risk-assessment", judged("timeout")]]])).rubricVersion, "2", "a judge error keeps it refused");
  assert.equal(adoptRubricWhenRescored(old, current, new Map()).rubricVersion, "2", "nothing judged again: refused");
});

test("review round 1 (finding 10): the note says where the baseline's drafts were judged again", () => {
  const current = runs([[section("medical-necessity", [], { thread: 2 })]], { label: "run-b" });
  const here = { ...current, rescoredFromRubric: "2", rejudgedIn: "run-b" };
  assert.match(rescoredBaselineNote(here, current), /judged again in this run, so/);
  const earlier = { ...current, rescoredFromRubric: "2", rejudgedIn: "run-a" };
  assert.match(rescoredBaselineNote(earlier, current), /judged again in run run-a, .*in this run its drafts were checked again, and judged again only where the judge changed/);
  assert.match(rescoredBaselineNote({ ...current, rescoredFromRubric: "2" }, current), /in an earlier run/, "a baseline from before the field never claims this run");
  const judged: JudgeRecord = { format: "json-schema", repaired: false, answers: [{ section: "medical-necessity", items: [], keyFacts: [] }] as never, error: null, requests: 1, seconds: 1, usage: null, fingerprint: "new" };
  const old = runs([[section("medical-necessity", [], { thread: 2 })]], { rubricVersion: "2" });
  assert.equal(adoptRubricWhenRescored(old, current, new Map([["case-b-sofia", [new Map([["medical-necessity" as ReportSectionId, judged]])]]])).rejudgedIn, "run-b", "a full re-judge records this run");
});

test("review round 1 (finding 12): a re-judged baseline's name is suffixed once, and its case label stays within the app's limit", () => {
  assert.equal(rejudgedBaselineName("dev-step0"), "dev-step0 re-judged");
  assert.equal(rejudgedBaselineName(rejudgedBaselineName("dev-step0")), "dev-step0 re-judged");
  assert.equal(rejudgedBaselineName(undefined), "unknown re-judged");
  const label = baselineCaseLabel("Sofía Inventada Ejemplo", "x".repeat(200), 3, 100);
  assert.equal(label.length, 100);
  assert.ok(label.startsWith("Sofía Inventada Ejemplo (baseline "));
  assert.equal(baselineCaseLabel("Sofía", "dev", 1, 100), "Sofía (baseline dev, run 1)");
});

test("review round 1 (finding 11): a saved baseline answer is reused only for the same draft, baseline and judge", () => {
  const record: JudgeRecord = { format: "json-schema", repaired: false, answers: [{ section: "risk-assessment", items: [], keyFacts: [] }] as never, error: null, requests: 1, seconds: 1, usage: null, fingerprint: "judge-a" };
  const saved: SavedBaselineJudge[] = [{ baseline: "dev re-judged", caseId: "case-b-sofia", run: 2, section: "risk-assessment", textHash: "h1", record }];
  const wanted = { baseline: "dev re-judged", caseId: "case-b-sofia", run: 2, section: "risk-assessment" as ReportSectionId, textHash: "h1", fingerprint: "judge-a", samples: 1 };
  assert.equal(reusableBaselineJudge(saved, wanted), record);
  assert.equal(reusableBaselineJudge(saved, { ...wanted, fingerprint: "judge-b" }), null, "another judge");
  assert.equal(reusableBaselineJudge(saved, { ...wanted, textHash: "h2" }), null, "another draft");
  assert.equal(reusableBaselineJudge(saved, { ...wanted, baseline: "other" }), null, "another baseline");
  assert.equal(reusableBaselineJudge(saved, { ...wanted, run: 1 }), null, "another run");
  assert.equal(reusableBaselineJudge(saved, { ...wanted, samples: 2 }), null, "fewer samples than wanted");
  assert.equal(reusableBaselineJudge([{ ...saved[0], record: { ...record, error: "timeout" } }], wanted), null, "an error is judged again");
});

test("review round 1 (finding 11): a partial run is never compared", () => {
  const done = run([section("medical-necessity", [], { thread: 2 })]);
  assert.equal(compareRuns({ ...done, partial: true }, done).status, "not-compared");
  assert.equal(compareRuns(done, { ...done, partial: true }).status, "not-compared");
});
