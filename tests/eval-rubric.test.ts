import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { checkBannedPatterns, checkShape, CHECK_IDS, type Finding } from "../eval/checks/checks.ts";
import { compareRuns, scoreSection, summaryMarkdown, verdictLine, type RunResult, type SectionResult } from "../eval/results.ts";
import { codeScore, keyFactsScore, RUBRIC, RUBRIC_VERSION, SECTION_EXPECTATIONS, SECTION_SHAPES, type CodeItem } from "../eval/rubric.ts";
import { buildJudgePrompt, JudgeInputSchema, judgeAnswerSchema, parseJudgeAnswer, type JudgeInput } from "../src/lib/judge.ts";
import { REPORT_SECTIONS } from "../src/shared/report-sections.ts";

const finding = (check: Finding["check"], severity: Finding["severity"] = "major"): Finding => ({ check, section: "medical-necessity", message: "x", severity });

test("rubric: ids unique, every check scored by one code item, every section has her expectations; RUBRIC.md lists every item", () => {
  const ids = RUBRIC.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length);
  const checks = RUBRIC.filter((item): item is CodeItem => item.scoredBy === "code").map((item) => item.check);
  assert.deepEqual([...checks].sort(), [...CHECK_IDS].sort());
  for (const section of REPORT_SECTIONS) assert.ok(SECTION_EXPECTATIONS[section.id].length > 0, section.id);
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
  assert.equal(keyFactsScore(["present", "present", "partial", "present"]), 1);
  assert.equal(keyFactsScore(Array(10).fill("present").concat(["partial"]) as never), 2);
  assert.equal(keyFactsScore(["absent", "present"]), 0);
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
  assert.deepEqual(banned("background-information", "Autism Spectrum Disorder, Level 2."), ["severity-in-background"]);
});

const input = (overrides: Partial<JudgeInput> = {}): JudgeInput =>
  JudgeInputSchema.parse({
    rubricVersion: "1",
    items: [{ id: "thread", title: "Thread", anchors: { 2: "good", 1: "ok", 0: "bad" } }],
    expectations: ["Two paragraphs."],
    keyFacts: [{ id: "f1", fact: "The fact." }],
    caseNotes: ["Behavior: elopement."],
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
  for (const tag of ["<rubric>", "<her-structure>", "<case-key>", "<key-facts>", "<other-sections>", "<section-under-review"]) assert.ok(prompt.task.includes(tag), tag);
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

function section(id: SectionResult["id"], findings: Finding[], scores: Record<string, 0 | 1 | 2 | null>): SectionResult {
  return { id, version: 1, text: "Text.", words: 1, paragraphs: 1, markers: [], generation: null, consistency: null, draftError: null, findings, scores, judge: null };
}

function run(sections: SectionResult[], rubricVersion = "1"): RunResult {
  return {
    resultsVersion: 1,
    label: "t",
    startedAt: "a",
    finishedAt: "b",
    rubricVersion,
    judgePromptVersion: "1",
    drafting: { checkout: ".", commit: "abcdef0", branch: "dev", dirty: false, rulesVersions: {} },
    judging: { checkout: ".", commit: "abcdef0" },
    provider: "openai",
    model: "m",
    mode: "chained",
    judgeFormat: "json-schema",
    requests: { drafts: 1, checks: 0, judges: 1, repairs: 0, total: 2 },
    launches: [{ role: "draft", visibleWindows: 0, dockVisible: false, focusedWindows: 0, at: "launch" }],
    cases: [{ caseId: "case-b-sofia", keyVersion: "1", sourcesLoaded: [], sections }],
  };
}

test("compare: a rubric item that went down, a check that passed and fails now, an item no longer scored", () => {
  const baseline = run([section("medical-necessity", [], { thread: 2, "numbers-sourced": 2, style: 1 })]);
  const same = compareRuns(baseline, baseline);
  assert.equal(same.regressed, false);
  assert.equal(verdictLine(same), "No rubric item went down, and no check that passed in the baseline fails now.");
  const worse = run([section("medical-necessity", [{ ...finding("numbers"), message: '"7" is in no source.' }], { thread: 1, "numbers-sourced": 1, style: null })]);
  const comparison = compareRuns(worse, baseline);
  assert.deepEqual(comparison.drops.map((d) => `${d.item}:${d.from}->${d.to}`), ["thread:2->1", "numbers-sourced:2->1"]);
  assert.deepEqual(comparison.newFailures.map((f) => f.check), ["numbers"]);
  assert.deepEqual(comparison.unscored.map((u) => u.item), ["style"]);
  assert.match(verdictLine(comparison), /^REGRESSION: 2 rubric item scores went down; 1 check that passed in the baseline fails now; 1 item was scored/);
  const other = compareRuns(run(worse.cases[0].sections, "2"), baseline);
  assert.equal(other.comparable, false);
  assert.deepEqual(other.drops, []);
  assert.equal(other.newFailures.length, 1, "checks are still compared across rubric versions");
  const summary = summaryMarkdown(worse, comparison, "baseline-1");
  assert.match(summary, /\*\*REGRESSION/);
  assert.match(summary, /## Went down\n\n- case-b-sofia MN thread: 2 → 1/);
});

test("scoreSection: code items from findings, judge items from the answer, null when nothing to score", () => {
  const answer = { section: "medical-necessity", items: [{ id: "thread", score: 1 as const, reason: "", evidence: [] }], keyFacts: [{ id: "f", status: "present" as const, quote: "" }] };
  const scores = scoreSection("medical-necessity", [finding("numbers")], answer, true);
  assert.equal(scores["numbers-sourced"], 1);
  assert.equal(scores.thread, 1);
  assert.equal(scores["key-facts"], 2);
  assert.equal(scores.style, null, "an item the judge did not answer");
  assert.ok(Object.values(scoreSection("medical-necessity", [], null, false)).every((score) => score === null));
  assert.equal(scores["definition-topography"], undefined, "later-stage items are not scored yet");
});
