/*
 * What one evaluation run writes (results.json), how two runs are compared, and the short
 * Markdown summary. Pure functions over plain data (tests/eval-rubric.test.ts).
 *
 * Every case is run several times (owner's decision, 2026-11-23: 3 runs, each drafted and
 * judged), and the comparison is made on the medians of the runs:
 * - an item's score is the median of its runs, and it is unscored when any run could not
 *   score it;
 * - a check fails when it finds something in most runs (2 of 3), and passes otherwise.
 *
 * The verdict (review round 1, B3):
 * - hard: a code item whose median went down, a check that passed in the baseline and fails
 *   in most runs now, or an item scored in the baseline and not scored now. The code items of
 *   the baseline are scored again with the current checks on every stored run before the
 *   comparison, so a change to the checks never reads as a change of the rules.
 * - soft: judge items whose median went down or up. They are reported apart from the
 *   verdict, and only where both runs were judged with the same judge (same prompt, inputs,
 *   model and samples: the judge fingerprint) in every run.
 * - NOT COMPARED: another rubric version, provider or drafting mode.
 * - INVALID: a window or the Dock icon showed during the run.
 */
import type { JudgeAnswer, JudgeFormat } from "../src/lib/judge.ts";
import { REPORT_SECTIONS, type ReportSectionId } from "../src/shared/report-sections.ts";
import type { CheckId, Finding } from "./checks/checks.ts";
import { codeScore, keyFactsScore, RUBRIC, type CodeItem, type Score } from "./rubric.ts";

export const RESULTS_VERSION = 3;

/** How many times a case may be run: an odd count, so a median and a majority never tie (owner's choice, 2026-11-23). */
export const RUN_COUNTS = [1, 3, 5] as const;

export interface Usage {
  uncachedInputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  reasoningTokens: number | null;
}

/** Adds two token counts (review M2: the tokens of retries and repairs are kept). */
export function addUsage(a: Usage | null, b: Usage | null): Usage | null {
  if (!a) return b;
  if (!b) return a;
  return {
    uncachedInputTokens: a.uncachedInputTokens + b.uncachedInputTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens === null && b.reasoningTokens === null ? null : (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0),
  };
}

export interface JudgeRecord {
  /** The format that produced the answers used (or was last tried). */
  format: JudgeFormat;
  /** Whether a repair request was needed. */
  repaired: boolean;
  /** One valid answer per sample (pnpm eval --judge-samples); the scores are their median. */
  answers: JudgeAnswer[];
  /** Why there are fewer answers than samples: a request failed, or a repaired answer was still not valid. */
  error: string | null;
  requests: number;
  seconds: number;
  /** Every request's tokens, retries and repairs included. */
  usage: Usage | null;
  /**
   * What the judge was: its prompt version and code, its inputs for this section (rubric,
   * expectations, payer facts, key facts and notes, her notes and instructions), the model and
   * the samples, hashed. Two judgements compare only when it is the same.
   */
  fingerprint: string;
}

export interface SectionResult {
  id: ReportSectionId;
  /** The version the run drafted (null: the draft failed). */
  version: number | null;
  text: string | null;
  words: number;
  paragraphs: number;
  markers: Array<{ kind: "missing" | "check"; note: string }>;
  generation: { seconds: number; usage: Usage | null; servedModel: string | null; rulesVersions: Record<string, string> } | null;
  /** The app's own consistency check after the version, when it ran. */
  consistency: { status: string; items: string[] } | null;
  draftError: string | null;
  findings: Finding[];
  /** Every rubric item that applies, 0 to 2; null when it could not be scored (no draft, no judge answer). */
  scores: Record<string, Score | null>;
  judge: JudgeRecord | null;
}

export interface CaseResult {
  caseId: string;
  keyVersion: string;
  sourcesLoaded: string[];
  /** Her inputs as the run gave them: the session notes, and the standing instructions of every section (empty when none). */
  inputs: { notes: string; instructions: Partial<Record<ReportSectionId, string>> };
  /** What the key holds that is provisional (review M7): incident homes on a map she has not confirmed, facts left out of the judge's list. */
  keyNotes?: string[];
  /** Every run of the case, in order: each one drafted (or taken from an earlier run), checked and judged on its own. */
  runs: CaseRun[];
  /** Each section's medians over the runs (caseMedians); what the comparison reads. */
  medians: MedianSection[];
}

/** One run of a case: its nine sections, each with its text, findings, judge record and scores. */
export interface CaseRun {
  /** 1, 2, 3… */
  run: number;
  sections: SectionResult[];
}

/** A section over all the runs of a case. */
export interface MedianSection {
  id: ReportSectionId;
  /** Each item's median over the runs; null (unscored) when any run could not score it. */
  scores: Record<string, Score | null>;
  /** Each item's score in every run, in run order: the noise. */
  spread: Record<string, Array<Score | null>>;
  /** For each code check: in how many runs it found something (provisional findings left out). */
  failing: Partial<Record<CheckId, number>>;
  /** How many runs have a text for the section. */
  drafted: number;
  /** The words of each run's text (0 where there is none). */
  words: number[];
}

export interface LaunchCheck {
  /** Which app was started: the one that drafts (the rules under test) or the one that judges. */
  role: "draft" | "judge";
  visibleWindows: number;
  dockVisible: boolean | null;
  focusedWindows: number;
  /** Message boxes the app asked for (the harness stubs them): any one makes the run invalid. */
  dialogs?: string[];
  at: "launch" | "end" | "during";
}

/** A checkout, as a run records it: a neutral label, never a path (review B4). */
export interface CheckoutRecord {
  /** "this checkout", or the folder's name of a --draft-app checkout. */
  label: string;
  commit: string;
  branch: string;
  /** Changes not committed in rules/, src/ or eval/, untracked files included (review S10). */
  dirty: boolean;
}

export interface RunResult {
  resultsVersion: typeof RESULTS_VERSION;
  label: string;
  startedAt: string;
  finishedAt: string;
  rubricVersion: string;
  judgePromptVersion: string;
  checksVersion: string;
  /** How many times each case was run (pnpm eval --runs; 1 for results from before runs). */
  runs: number;
  /** Judge requests per section in each run (pnpm eval --judge-samples); the runs themselves are the samples by default. */
  judgeSamples: number;
  drafting: CheckoutRecord & { rulesVersions: Record<string, string> };
  judging: CheckoutRecord & { model: string | null };
  provider: string;
  model: string | null;
  mode: "chained" | "independent";
  /** The judge format the route accepted ("json-schema", or "plain-json" after it refused the schema). */
  judgeFormat: JudgeFormat | null;
  requests: { drafts: number; checks: number; judges: number; repairs: number; baselineJudges: number; total: number };
  launches: LaunchCheck[];
  /** How many times the windows were checked while the apps ran (every 5 s); each one that found something is also in `launches`. */
  windowChecksDuring: number;
  /** False when a window or the Dock icon showed (review S9): such a run is never accepted or compared. */
  valid: boolean;
  invalidReason: string | null;
  /** Set when this run took an earlier run's drafts (pnpm eval --from-run or --rejudge): that run's label. */
  fromRun?: string;
  /** --rejudge: every section was judged again, not only those without an answer. */
  rejudged?: boolean;
  /**
   * Set only on a baseline as a comparison saw it (adoptRubricWhenRescored): it was scored by
   * another rubric version, and every one of its stored drafts was checked and judged again in
   * this run, so it is compared under this run's rubric. The version it was accepted with.
   */
  rescoredFromRubric?: string;
  cases: CaseResult[];
}

/* Scores ------------------------------------------------------------------------------ */

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

const FACT_VALUE = { present: 2, partial: 1, absent: 0 } as const;
const FACT_STATUS = ["absent", "partial", "present"] as const;

/** One answer from several samples: each item's score and each fact's status is their median (the lower middle one for an even count). */
export function medianAnswer(answers: readonly JudgeAnswer[]): JudgeAnswer | null {
  if (answers.length === 0) return null;
  if (answers.length === 1) return answers[0];
  const first = answers[0];
  return {
    section: first.section,
    items: first.items.map((item) => {
      const scores = answers.map((answer) => answer.items.find((other) => other.id === item.id)?.score ?? item.score);
      const score = median(scores) as 0 | 1 | 2;
      const closest = answers.map((answer) => answer.items.find((other) => other.id === item.id)).find((other) => other?.score === score) ?? item;
      return { ...closest, score };
    }),
    keyFacts: first.keyFacts.map((fact) => {
      const values = answers.map((answer) => FACT_VALUE[answer.keyFacts.find((other) => other.id === fact.id)?.status ?? fact.status]);
      return { ...fact, status: FACT_STATUS[median(values)] };
    }),
  };
}

/** The code items' scores from a section's findings, and the judge items' from its answers (their median). */
export function scoreSection(section: ReportSectionId, findings: readonly Finding[], answers: readonly JudgeAnswer[], hasText: boolean): Record<string, Score | null> {
  const judge = medianAnswer(answers);
  const scores: Record<string, Score | null> = {};
  for (const item of RUBRIC) {
    if (item.stage !== "body") continue;
    if (!hasText) {
      scores[item.id] = null;
      continue;
    }
    if (item.scoredBy === "code") {
      scores[item.id] = codeScore(item as CodeItem, findings.filter((finding) => finding.section === section));
    } else if (item.id === "key-facts") {
      scores[item.id] = judge ? keyFactsScore(judge.keyFacts.map((fact) => fact.status)) : null;
    } else {
      scores[item.id] = judge?.items.find((answered) => answered.id === item.id)?.score ?? null;
    }
  }
  return scores;
}

const CODE_ITEMS = new Set(RUBRIC.filter((item) => item.scoredBy === "code").map((item) => item.id));
const CODE_CHECKS = new Set<CheckId>(RUBRIC.filter((item): item is CodeItem => item.scoredBy === "code").map((item) => item.check));

/* Medians over the runs ------------------------------------------------------------------ */

/** The median of one item's scores over the runs; null (unscored) when any run could not score it (owner's choice, 2026-11-23). */
export function medianScore(scores: ReadonlyArray<Score | null>): Score | null {
  if (scores.length === 0 || scores.some((score) => score === null)) return null;
  return median(scores as Score[]) as Score;
}

/** Whether a check fails over the runs: it finds something in most of them (2 of 3). */
export function failsInMost(failing: number | undefined, runs: number): boolean {
  return (failing ?? 0) * 2 > runs;
}

const countedFindings = (findings: readonly Finding[], check: CheckId) => findings.filter((finding) => finding.check === check && !finding.provisional);

/** Each section's medians, spread and failing checks over a case's runs. */
export function caseMedians(runs: readonly CaseRun[]): MedianSection[] {
  const ids = REPORT_SECTIONS.map((section) => section.id).filter((id) => runs.some((r) => r.sections.some((s) => s.id === id)));
  return ids.map((id) => {
    const sections = runs.map((r) => r.sections.find((s) => s.id === id) ?? null);
    const items = [...new Set(sections.flatMap((s) => (s ? Object.keys(s.scores) : [])))];
    const spread = Object.fromEntries(items.map((item) => [item, sections.map((s) => s?.scores[item] ?? null)]));
    const failing: Partial<Record<CheckId, number>> = {};
    for (const check of CODE_CHECKS) {
      const count = sections.filter((s) => s !== null && s.text !== null && countedFindings(s.findings, check).length > 0).length;
      if (count > 0) failing[check] = count;
    }
    return {
      id,
      scores: Object.fromEntries(items.map((item) => [item, medianScore(spread[item])])),
      spread,
      failing,
      drafted: sections.filter((s) => s?.text !== null && s?.text !== undefined).length,
      words: sections.map((s) => s?.words ?? 0),
    };
  });
}

/** The judge fingerprint every run of a case shares for a section, or null when the runs differ or one has none. */
function sharedFingerprint(c: CaseResult, id: ReportSectionId): string | null {
  const prints = c.runs.map((r) => r.sections.find((s) => s.id === id)?.judge?.fingerprint ?? "");
  return prints.length > 0 && prints[0] !== "" && prints.every((print) => print === prints[0]) ? prints[0] : null;
}

/* Reading older results ------------------------------------------------------------------ */

/** The last part of a path, so an older record never carries the path itself. */
function neutralLabel(value: unknown, fallback: string): string {
  if (typeof value !== "string" || value === "") return fallback;
  const parts = value.split(/[\\/]/).filter((part) => part !== "");
  return parts.at(-1) ?? fallback;
}

type OlderSection = SectionResult & { judge: (JudgeRecord & { answer?: JudgeAnswer | null }) | null };

/**
 * Any results.json as this version reads it:
 * - a version 1 file gets its judge answers as a list, labels instead of paths, the checks
 *   version it was made with ("1"), one sample and no fingerprint (so its judge items are
 *   never taken as comparable);
 * - a version 1 or 2 file, from before runs, is one run of each case.
 * The medians are always worked out again from the runs' scores.
 */
export function normalizeRun(raw: unknown): RunResult {
  const run = structuredClone(raw) as RunResult & {
    drafting: RunResult["drafting"] & { checkout?: string };
    judging: RunResult["judging"] & { checkout?: string };
    cases: Array<CaseResult & { sections?: OlderSection[] }>;
  };
  for (const c of run.cases) {
    if (!Array.isArray(c.runs)) c.runs = [{ run: 1, sections: c.sections ?? [] }];
    delete c.sections;
  }
  run.runs ??= run.cases[0]?.runs.length ?? 1;
  run.checksVersion ??= "1";
  run.judgeSamples ??= 1;
  run.valid ??= true;
  run.windowChecksDuring ??= 0;
  run.invalidReason ??= null;
  run.requests.baselineJudges ??= 0;
  const drafting = run.drafting;
  run.drafting = { label: drafting.label ?? neutralLabel(drafting.checkout, "unknown"), commit: drafting.commit, branch: drafting.branch ?? "unknown", dirty: drafting.dirty ?? false, rulesVersions: drafting.rulesVersions ?? {} };
  const judging = run.judging;
  run.judging = { label: judging.label ?? neutralLabel(judging.checkout, "unknown"), commit: judging.commit, branch: judging.branch ?? "unknown", dirty: judging.dirty ?? false, model: judging.model ?? run.model ?? null };
  for (const c of run.cases) {
    c.inputs ??= { notes: "", instructions: {} };
    for (const r of c.runs) {
      for (const s of r.sections as OlderSection[]) {
        if (!s.judge) continue;
        if (!Array.isArray(s.judge.answers)) s.judge.answers = s.judge.answer ? [s.judge.answer] : [];
        delete s.judge.answer;
        s.judge.fingerprint ??= "";
      }
    }
    c.medians = caseMedians(c.runs);
  }
  run.resultsVersion = RESULTS_VERSION;
  return run;
}

/**
 * The baseline as the current checks see it (review B3, part 1): every stored run's texts
 * checked again (`findings` per case and run, in run order, by the caller), its code items
 * scored again and its medians worked out again; its judge answers stay as they are.
 */
export function rescoreRun(run: RunResult, findingsByCase: ReadonlyMap<string, ReadonlyArray<readonly Finding[]>>): RunResult {
  const copy = structuredClone(run);
  for (const c of copy.cases) {
    const perRun = findingsByCase.get(c.caseId);
    if (!perRun) continue;
    c.runs.forEach((r, index) => {
      const findings = perRun[index];
      if (!findings) return;
      for (const s of r.sections) {
        s.findings = findings.filter((finding) => finding.section === s.id);
        s.scores = scoreSection(s.id, s.findings, s.judge?.answers ?? [], s.text !== null);
      }
    });
    c.medians = caseMedians(c.runs);
  }
  return copy;
}

/**
 * A baseline accepted under another rubric version counts as scored by this run's version only
 * when every stored draft of every case this run compares was checked again (rescoreRun) and
 * judged again in this same run by this judge, with a valid answer for every sample. Anything
 * less (a case, a run or a section left unjudged, a judge error) leaves it as it was, so the
 * compare still refuses it (owner's approval, 2026-11-27). The baseline arm is then its stored
 * drafts, re-judged, not drafted again; the comparison says so.
 */
export function adoptRubricWhenRescored(baseline: RunResult, current: RunResult, rejudged: ReadonlyMap<string, ReadonlyArray<ReadonlyMap<ReportSectionId, JudgeRecord>>>): RunResult {
  if (baseline.rubricVersion === current.rubricVersion) return baseline;
  let compared = 0;
  for (const c of current.cases) {
    const baseCase = baseline.cases.find((b) => b.caseId === c.caseId);
    if (!baseCase) continue;
    const records = rejudged.get(c.caseId);
    if (!records || records.length < baseCase.runs.length) return baseline;
    for (const [index, r] of baseCase.runs.entries()) {
      for (const s of r.sections) {
        if (s.text === null) continue;
        const record = records[index]?.get(s.id);
        if (!record || record.error !== null || record.answers.length < current.judgeSamples) return baseline;
      }
    }
    compared++;
  }
  if (compared === 0) return baseline;
  return { ...baseline, rubricVersion: current.rubricVersion, rescoredFromRubric: baseline.rubricVersion };
}

/* The comparison ----------------------------------------------------------------------- */

export type CompareStatus = "pass" | "regression" | "not-compared" | "invalid";

interface ItemChange {
  caseId: string;
  section: ReportSectionId;
  item: string;
  /** The medians. */
  from: Score;
  to: Score;
  /** Every run's score, baseline and now: the spread behind each median. */
  fromRuns: Array<Score | null>;
  toRuns: Array<Score | null>;
}

export interface Comparison {
  status: CompareStatus;
  /** Why not compared, why invalid, and what else differs between the runs. */
  notes: string[];
  /** Hard: a code item whose median went down. */
  codeDrops: ItemChange[];
  codeRises: ItemChange[];
  /** Hard: a check that passed in the baseline (found something in at most half its runs) and fails in most runs now (provisional findings left out). */
  newFailures: Array<{ caseId: string; section: ReportSectionId; check: CheckId; failing: number; runs: number; baselineFailing: number; baselineRuns: number; findings: string[] }>;
  /** Hard: scored in the baseline, not scored now (no draft, or no judge answer, in some run). */
  unscored: Array<{ caseId: string; section: ReportSectionId; item: string; toRuns: Array<Score | null> }>;
  /** Soft, apart from the verdict: judge items whose median moved, where both runs had the same judge in every run. */
  judgeDrops: ItemChange[];
  judgeRises: ItemChange[];
  /** Sections whose judge items were not compared: another judge (fingerprint) in one of the runs. */
  judgeNotCompared: Array<{ caseId: string; section: ReportSectionId }>;
  /**
   * Not compared, and said so (review round 1 of the 3-run evaluation, S2): items the baseline
   * could not score (some run of it has no draft, or no judge answer, even after it was judged
   * again in this run), so a drop there cannot be seen.
   */
  baselineUnscored: Array<{ caseId: string; section: ReportSectionId; item: string; fromRuns: Array<Score | null> }>;
  /**
   * Sections whose checks were not compared because a run of the baseline has no draft of them
   * (review S1): its failing count would be read against runs that never had a text.
   */
  checksNotCompared: Array<{ caseId: string; section: ReportSectionId; drafted: number; runs: number }>;
}

/** Compares a run with the last accepted one (already rescored with the current checks: rescoreRun). */
export function compareRuns(current: RunResult, baseline: RunResult): Comparison {
  const comparison: Comparison = { status: "pass", notes: [], codeDrops: [], codeRises: [], newFailures: [], unscored: [], judgeDrops: [], judgeRises: [], judgeNotCompared: [], baselineUnscored: [], checksNotCompared: [] };
  const blockers: string[] = [];
  if (!current.valid) {
    comparison.status = "invalid";
    comparison.notes.push(`This run is invalid: ${current.invalidReason ?? "a window showed"}.`);
    return comparison;
  }
  if (!baseline.valid) blockers.push("the baseline run is marked invalid");
  if (current.rubricVersion !== baseline.rubricVersion) blockers.push(`the baseline used rubric version ${baseline.rubricVersion} and this run ${current.rubricVersion}`);
  if (current.provider !== baseline.provider) blockers.push(`the baseline was drafted by ${baseline.provider} and this run by ${current.provider}`);
  if (current.mode !== baseline.mode) blockers.push(`the baseline drafted ${baseline.mode} and this run ${current.mode}`);
  if (blockers.length > 0) {
    comparison.status = "not-compared";
    comparison.notes.push(...blockers.map((reason) => `Not compared: ${reason}.`));
    return comparison;
  }
  if (baseline.rescoredFromRubric !== undefined) {
    comparison.notes.push(
      `The baseline was accepted under rubric version ${baseline.rescoredFromRubric}. Every one of its stored drafts was checked and judged again in this run, so it is compared under rubric version ${baseline.rubricVersion}: the baseline arm is its stored drafts, re-judged, not drafted again.`,
    );
  }
  if (current.model !== baseline.model) comparison.notes.push(`The drafting model differs: ${baseline.model ?? "unknown"} in the baseline, ${current.model ?? "unknown"} now.`);
  if (current.judgeFormat !== baseline.judgeFormat) comparison.notes.push(`The judge format differs: ${baseline.judgeFormat ?? "none"} in the baseline, ${current.judgeFormat ?? "none"} now.`);
  if (current.judgeSamples !== baseline.judgeSamples) comparison.notes.push(`Judge samples per run differ: ${baseline.judgeSamples} in the baseline, ${current.judgeSamples} now.`);
  if (current.runs !== baseline.runs) {
    comparison.notes.push(
      `Runs per case differ: ${plural(baseline.runs, "run", "runs")} in the baseline, ${current.runs} now; each side is compared on its own medians.${
        current.runs < baseline.runs ? ` With fewer runs than the baseline, this run's hard verdict is not reliable: one run's drafting and judging noise is what the medians were brought in to absorb (owner's decision, 2026-11-23). Run ${baseline.runs} to decide.` : ""
      }`,
    );
  }
  for (const c of current.cases) if (!baseline.cases.some((b) => b.caseId === c.caseId)) comparison.notes.push(`Case ${c.caseId} is new: the baseline has no run of it, so it is not compared.`);
  for (const baseCase of baseline.cases) {
    const nowCase = current.cases.find((c) => c.caseId === baseCase.caseId);
    if (!nowCase) {
      comparison.notes.push(`Case ${baseCase.caseId} is in the baseline but was not run.`);
      continue;
    }
    if (nowCase.keyVersion !== baseCase.keyVersion) comparison.notes.push(`Case ${baseCase.caseId}: its key changed (version ${baseCase.keyVersion} to ${nowCase.keyVersion}).`);
    for (const baseSection of baseCase.medians) {
      const nowSection = nowCase.medians.find((s) => s.id === baseSection.id);
      if (!nowSection) continue;
      const baseJudge = sharedFingerprint(baseCase, baseSection.id);
      const sameJudge = baseJudge !== null && baseJudge === sharedFingerprint(nowCase, baseSection.id);
      let judgeSkipped = false;
      for (const [item, before] of Object.entries(baseSection.scores)) {
        if (before === null) {
          comparison.baselineUnscored.push({ caseId: baseCase.caseId, section: baseSection.id, item, fromRuns: baseSection.spread[item] ?? [] });
          continue;
        }
        const after = nowSection.scores[item] ?? null;
        const runs = { fromRuns: baseSection.spread[item] ?? [], toRuns: nowSection.spread[item] ?? [] };
        const change = { caseId: baseCase.caseId, section: baseSection.id, item };
        if (after === null) {
          comparison.unscored.push({ ...change, toRuns: runs.toRuns });
          continue;
        }
        if (CODE_ITEMS.has(item)) {
          if (after < before) comparison.codeDrops.push({ ...change, from: before, to: after, ...runs });
          else if (after > before) comparison.codeRises.push({ ...change, from: before, to: after, ...runs });
        } else if (!sameJudge) {
          judgeSkipped = true;
        } else if (after < before) {
          comparison.judgeDrops.push({ ...change, from: before, to: after, ...runs });
        } else if (after > before) {
          comparison.judgeRises.push({ ...change, from: before, to: after, ...runs });
        }
      }
      if (judgeSkipped) comparison.judgeNotCompared.push({ caseId: baseCase.caseId, section: baseSection.id });
      if (baseSection.drafted === 0 || nowSection.drafted === 0) continue;
      // Review S1: a baseline run without this draft would make a check that failed in most of its
      // runs read as passing (its failing count is only over runs with a text); not compared, said so.
      if (baseSection.drafted < baseCase.runs.length) {
        comparison.checksNotCompared.push({ caseId: baseCase.caseId, section: baseSection.id, drafted: baseSection.drafted, runs: baseCase.runs.length });
        continue;
      }
      for (const check of CODE_CHECKS) {
        if (failsInMost(baseSection.failing[check], baseCase.runs.length)) continue;
        if (!failsInMost(nowSection.failing[check], nowCase.runs.length)) continue;
        const messages = nowCase.runs.flatMap((r) => countedFindings(r.sections.find((s) => s.id === baseSection.id)?.findings ?? [], check).map((finding) => `run ${r.run}: ${finding.message}`));
        comparison.newFailures.push({
          caseId: baseCase.caseId,
          section: baseSection.id,
          check,
          failing: nowSection.failing[check] ?? 0,
          runs: nowCase.runs.length,
          baselineFailing: baseSection.failing[check] ?? 0,
          baselineRuns: baseCase.runs.length,
          findings: messages,
        });
      }
    }
  }
  comparison.status = comparison.codeDrops.length > 0 || comparison.newFailures.length > 0 || comparison.unscored.length > 0 ? "regression" : "pass";
  return comparison;
}

/** The process's exit code for a verdict: 0 pass or nothing to compare, 2 regression, 3 not compared, 1 invalid. */
export function exitCodeFor(comparison: Comparison | null, run: RunResult): number {
  if (!run.valid) return 1;
  if (!comparison) return 0;
  return { pass: 0, regression: 2, "not-compared": 3, invalid: 1 }[comparison.status];
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The verdict in one plain sentence. */
export function verdictLine(comparison: Comparison | null, run?: RunResult): string {
  if (run && !run.valid) return `INVALID: ${run.invalidReason ?? "a window showed"}. This run is not compared and cannot be accepted.`;
  if (!comparison) return "No accepted baseline to compare with: this run is not compared.";
  if (comparison.status === "invalid") return `INVALID: ${comparison.notes.join(" ")}`;
  if (comparison.status === "not-compared") return `NOT COMPARED: ${comparison.notes.filter((note) => note.startsWith("Not compared")).map((note) => note.replace(/^Not compared: /, "").replace(/\.$/, "")).join("; ")}.`;
  const gaps = [
    ...(comparison.baselineUnscored.length > 0 ? [`${plural(comparison.baselineUnscored.length, "item", "items")} the baseline could not score`] : []),
    ...(comparison.checksNotCompared.length > 0 ? [`the checks of ${plural(comparison.checksNotCompared.length, "section", "sections")} with a baseline run missing its draft`] : []),
  ];
  const judge = `Judge item medians, apart from the verdict: ${comparison.judgeDrops.length} down, ${comparison.judgeRises.length} up${comparison.judgeNotCompared.length > 0 ? `, ${plural(comparison.judgeNotCompared.length, "section", "sections")} not comparable` : ""}.${gaps.length > 0 ? ` Not compared: ${gaps.join("; ")}.` : ""}`;
  if (comparison.status === "pass") return `No hard regression: no code item's median went down, no check that passed in the baseline fails in most runs now, and nothing went unscored. ${judge}`;
  const parts: string[] = [];
  if (comparison.codeDrops.length > 0) parts.push(`${plural(comparison.codeDrops.length, "code item median", "code item medians")} went down`);
  if (comparison.newFailures.length > 0) parts.push(`${plural(comparison.newFailures.length, "check that passed in the baseline fails", "checks that passed in the baseline fail")} in most runs now`);
  if (comparison.unscored.length > 0) parts.push(`${plural(comparison.unscored.length, "item was", "items were")} scored in the baseline but not now`);
  return `REGRESSION: ${parts.join("; ")}. This rules change does not go to the BCBA as it is. ${judge}`;
}

/* The summary --------------------------------------------------------------------------- */

const SHORT: Record<ReportSectionId, string> = {
  "background-information": "BI",
  "medical-necessity": "MN",
  "strengths-and-weaknesses": "SW",
  "environmental-changes": "EC",
  "family-caregiver-involvement": "FCI",
  "generalization-and-maintenance": "GM",
  "discharge-and-service-fading-plan": "DC",
  "risk-assessment": "RA",
  "crisis-plan": "CP",
};

const cell = (score: Score | null | undefined) => (score === null || score === undefined ? "–" : String(score));
/** Every run's score, "2·1·2"; a single run shows just its score. */
const runsCell = (scores: ReadonlyArray<Score | null>) => scores.map(cell).join("·");
const disagree = (scores: ReadonlyArray<Score | null>) => new Set(scores.map(cell)).size > 1;

function totals(run: RunResult): { code: [number, number]; judge: [number, number] } {
  const t = { code: [0, 0] as [number, number], judge: [0, 0] as [number, number] };
  for (const c of run.cases) {
    for (const s of c.medians) {
      for (const [item, score] of Object.entries(s.scores)) {
        if (score === null || score === undefined) continue;
        const bucket = CODE_ITEMS.has(item) ? t.code : t.judge;
        bucket[0] += score;
        bucket[1] += 2;
      }
    }
  }
  return t;
}

/** How many section items the runs disagree on, of those scored in every run: the noise, made visible. */
export function noiseOf(run: RunResult): { code: [number, number]; judge: [number, number] } {
  const n = { code: [0, 0] as [number, number], judge: [0, 0] as [number, number] };
  for (const c of run.cases) {
    for (const s of c.medians) {
      for (const [item, scores] of Object.entries(s.spread)) {
        if (scores.some((score) => score === null)) continue;
        const bucket = CODE_ITEMS.has(item) ? n.code : n.judge;
        if (disagree(scores)) bucket[0]++;
        bucket[1]++;
      }
    }
  }
  return n;
}

/** The short Markdown summary written next to results.json. */
export function summaryMarkdown(run: RunResult, comparison: Comparison | null, baselineLabel: string | null, baseline: RunResult | null = null): string {
  const lines: string[] = [];
  lines.push(`# Evaluation run: ${run.label}`, "");
  lines.push(`**${verdictLine(comparison, run)}**${baselineLabel ? ` (baseline: ${baselineLabel})` : ""}`, "");
  const t = totals(run);
  const noise = noiseOf(run);
  const allSections = run.cases.flatMap((c) => c.runs.flatMap((r) => r.sections));
  const judgeUsage = allSections.map((s) => s.judge?.usage ?? null).reduce<Usage | null>(addUsage, null);
  const judgeInput = judgeUsage ? judgeUsage.uncachedInputTokens + judgeUsage.cacheReadTokens + judgeUsage.cacheWriteTokens : 0;
  lines.push(
    `- Drafted by ${run.drafting.label} (${run.drafting.branch} at ${run.drafting.commit.slice(0, 7)})${run.drafting.dirty ? " with UNCOMMITTED changes" : ""}; judged by ${run.judging.label} at ${run.judging.commit.slice(0, 7)}${run.judging.dirty ? " with UNCOMMITTED changes" : ""}.`,
    `- ${plural(run.runs, "run", "runs")} per case, each drafted and judged on its own. Every score below is the median of the runs; an item is unscored when any run could not score it, and a check fails when it fails in most runs.`,
    `- Rubric v${run.rubricVersion}, judge prompt v${run.judgePromptVersion}, checks v${run.checksVersion}, ${plural(run.judgeSamples, "judge sample", "judge samples")} per section in each run (median when more than one); judge format ${run.judgeFormat ?? "none"}; ${run.provider}, ${run.model ?? "model unknown"}; ${run.mode} drafting.`,
    ...(run.fromRun ? [`- ${run.rejudged ? "Every section of every run judged again" : "Judged again only where a run had no answer"} from run ${run.fromRun}'s drafts, checked again with the current checks. The request counts below are both runs together.`] : []),
    `- Requests: ${run.requests.total} (${run.requests.drafts} drafts, ${run.requests.checks} consistency checks, ${run.requests.judges} judge, ${run.requests.repairs} repairs, ${run.requests.baselineJudges} judging the baseline's drafts again). ${run.startedAt} to ${run.finishedAt}.`,
    `- Judge input: ${judgeInput} tokens, ${judgeUsage?.cacheReadTokens ?? 0} read from the cache.`,
    `- Windows: ${run.launches.filter((launch) => launch.at !== "during").map((launch) => `${launch.role} ${launch.at}: ${launch.visibleWindows} visible, Dock ${launch.dockVisible === null ? "n/a" : launch.dockVisible ? "VISIBLE" : "hidden"}, ${launch.focusedWindows} focused${launch.dialogs && launch.dialogs.length > 0 ? `, ${launch.dialogs.length} dialog(s) asked for` : ""}`).join("; ")}; ${run.windowChecksDuring} checks during the run${run.valid ? ", all clear" : ", NOT clear"}.`,
    `- Scores (medians): code items ${t.code[0]} of ${t.code[1]}, judge items ${t.judge[0]} of ${t.judge[1]}${baseline ? `; the baseline as the current checks score it: code ${totals(baseline).code[0]} of ${totals(baseline).code[1]}, judge ${totals(baseline).judge[0]} of ${totals(baseline).judge[1]} (${plural(baseline.runs, "run", "runs")})` : ""}.`,
    ...(run.runs > 1 ? [`- Noise: the runs disagree on ${noise.code[0]} of ${noise.code[1]} code item scores and ${noise.judge[0]} of ${noise.judge[1]} judge item scores (see each case's spread).`] : []),
    "",
  );
  const items = RUBRIC.filter((item) => item.stage === "body");
  for (const c of run.cases) {
    const base = baseline?.cases.find((b) => b.caseId === c.caseId) ?? null;
    lines.push(`## ${c.caseId}`, "");
    lines.push(base ? "Medians. Each cell: baseline → this run." : "Medians.", "");
    lines.push(`| Item | ${c.medians.map((s) => SHORT[s.id]).join(" | ")} |`, `| --- | ${c.medians.map(() => "---").join(" | ")} |`);
    for (const item of items) {
      const row = c.medians.map((s) => {
        const before = base?.medians.find((b) => b.id === s.id)?.scores[item.id];
        return base ? `${cell(before)} → ${cell(s.scores[item.id])}` : cell(s.scores[item.id]);
      });
      lines.push(`| ${item.id} (${item.scoredBy}) | ${row.join(" | ")} |`);
    }
    const middle = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) / 2)] ?? 0;
    const markersOf = (id: ReportSectionId) => c.runs.map((r) => r.sections.find((s) => s.id === id)?.markers.length ?? 0);
    lines.push(`| words | ${c.medians.map((s) => String(middle(s.words))).join(" | ")} |`, `| markers | ${c.medians.map((s) => String(middle(markersOf(s.id)))).join(" | ")} |`, "");
    if (c.runs.length > 1) {
      lines.push(`Spread over the ${c.runs.length} runs: each cell is every run's score in order; **bold** where the runs disagree.`, "");
      lines.push(`| Item | ${c.medians.map((s) => SHORT[s.id]).join(" | ")} |`, `| --- | ${c.medians.map(() => "---").join(" | ")} |`);
      for (const item of items) {
        const row = c.medians.map((s) => {
          const scores = s.spread[item.id] ?? [];
          return disagree(scores) ? `**${runsCell(scores)}**` : runsCell(scores);
        });
        lines.push(`| ${item.id} (${item.scoredBy}) | ${row.join(" | ")} |`);
      }
      lines.push(`| words | ${c.medians.map((s) => s.words.join("·")).join(" | ")} |`, "");
    }
    const instructions = Object.entries(c.inputs.instructions).filter(([, text]) => text && text.trim() !== "");
    lines.push(`- Her inputs: ${c.inputs.notes.trim() ? "session notes given" : "no session notes"}; ${instructions.length > 0 ? `standing instructions for ${instructions.map(([id]) => SHORT[id as ReportSectionId]).join(", ")}` : "no standing instructions (every section's cleared)"}.`);
    if (c.keyNotes && c.keyNotes.length > 0) lines.push("- Provisional in the key, for her to confirm:", ...c.keyNotes.map((note) => `  - ${note}`));
    const provisional = new Map<string, number[]>();
    for (const r of c.runs) {
      for (const s of r.sections) {
        for (const finding of s.findings.filter((f) => f.provisional)) {
          const key = `${SHORT[s.id]}: ${finding.message}`;
          provisional.set(key, [...(provisional.get(key) ?? []), r.run]);
        }
      }
    }
    if (provisional.size > 0) lines.push("- Provisional, not scored (a rule pending her answer):", ...[...provisional].map(([line, runs]) => `  - ${line}${c.runs.length > 1 ? ` (run ${[...new Set(runs)].join(", ")})` : ""}`));
    for (const r of c.runs) {
      for (const s of r.sections.filter((section) => section.draftError || section.judge?.error)) {
        lines.push(`- ${c.runs.length > 1 ? `run ${r.run} ` : ""}${SHORT[s.id]}: ${s.draftError ? `draft failed: ${s.draftError}` : `judge: ${s.judge?.error}`}`);
      }
    }
    lines.push("");
  }
  if (comparison && comparison.status !== "invalid") {
    if (comparison.notes.length > 0) lines.push("## Notes", "", ...comparison.notes.map((note) => `- ${note}`), "");
    const list = (title: string, changes: readonly ItemChange[]) =>
      changes.length > 0 ? [title, "", ...changes.map((d) => `- ${d.caseId} ${SHORT[d.section]} ${d.item}: ${d.from} → ${d.to} (runs ${runsCell(d.fromRuns)} → ${runsCell(d.toRuns)})`), ""] : [];
    lines.push(...list("## Hard: code item medians that went down", comparison.codeDrops));
    if (comparison.newFailures.length > 0)
      lines.push(
        "## Hard: checks that passed and fail in most runs now",
        "",
        ...comparison.newFailures.map((f) => `- ${f.caseId} ${SHORT[f.section]} ${f.check}: fails in ${f.failing} of ${f.runs} runs (baseline ${f.baselineFailing} of ${f.baselineRuns}): ${f.findings.slice(0, 3).join(" / ")}`),
        "",
      );
    if (comparison.unscored.length > 0)
      lines.push(
        "## Hard: not scored in every run this time",
        "",
        "A missing judge answer is filled with `--from-run <this run>`; a failed draft needs a new run.",
        "",
        ...comparison.unscored.map((u) => `- ${u.caseId} ${SHORT[u.section]} ${u.item} (runs ${runsCell(u.toRuns)})`),
        "",
      );
    lines.push(...list("## Code item medians that went up", comparison.codeRises));
    lines.push(
      ...list(`## Judge item medians that went down (apart from the verdict; ${plural(run.runs, "run", "runs")} × ${plural(run.judgeSamples, "sample", "samples")})`, comparison.judgeDrops),
      ...list("## Judge item medians that went up", comparison.judgeRises),
    );
    if (comparison.judgeNotCompared.length > 0) lines.push("## Judge items not compared (another judge)", "", ...comparison.judgeNotCompared.map((s) => `- ${s.caseId} ${SHORT[s.section]}`), "");
    if (comparison.baselineUnscored.length > 0)
      lines.push("## Not compared: the baseline could not score these", "", ...comparison.baselineUnscored.map((u) => `- ${u.caseId} ${SHORT[u.section]} ${u.item} (baseline runs ${runsCell(u.fromRuns)})`), "");
    if (comparison.checksNotCompared.length > 0)
      lines.push("## Checks not compared: a baseline run has no draft of the section", "", ...comparison.checksNotCompared.map((c) => `- ${c.caseId} ${SHORT[c.section]}: drafted in ${c.drafted} of ${c.runs} baseline runs`), "");
  }
  lines.push("Sections: " + REPORT_SECTIONS.map((s) => `${SHORT[s.id]} ${s.title}`).join("; ") + ".", "");
  return lines.join("\n");
}

/* Baselines ---------------------------------------------------------------------------- */

/**
 * What keeps a run from becoming the bar (review round 1 of the 3-run evaluation, S1): a run
 * of a case with a failed draft, a judge error or an item it could not score. An item missing
 * in any run is unscored until it is filled (owner's choice, 2026-11-23), so such a run is
 * never accepted. Empty when the run is complete.
 */
export function incompleteParts(run: RunResult): string[] {
  const found: string[] = [];
  for (const c of run.cases) {
    for (const r of c.runs) {
      for (const s of r.sections) {
        const where = `${c.caseId} run ${r.run} ${SHORT[s.id]}`;
        if (s.text === null || s.draftError) found.push(`${where}: no draft${s.draftError ? ` (${s.draftError})` : ""}`);
        else if (s.judge?.error) found.push(`${where}: judge error (${s.judge.error})`);
        else {
          const missing = Object.entries(s.scores).filter(([, score]) => score === null).map(([item]) => item);
          if (missing.length > 0) found.push(`${where}: not scored: ${missing.join(", ")}`);
        }
      }
    }
  }
  return found;
}

/**
 * Whether --from-run keeps an earlier run's judge record for a section (review m4): only an
 * answer from this same judge (fingerprint) with every sample; --rejudge never keeps one.
 */
export function keepsEarlierJudge(earlier: JudgeRecord | null | undefined, fingerprint: string, samples: number, rejudgeAll: boolean): earlier is JudgeRecord {
  return !rejudgeAll && !!earlier && earlier.error === null && earlier.answers.length === samples && earlier.fingerprint === fingerprint;
}

/**
 * A run as it may be committed (review B4): labels only, never a path. Fails closed: if any
 * string in it still looks like a local path, or holds the home folder or the user name
 * given, it throws instead of returning.
 */
export function baselineCopy(run: RunResult, local: { home: string; user: string }): RunResult {
  const copy = structuredClone(run) as RunResult & { drafting: { checkout?: unknown }; judging: { checkout?: unknown } };
  delete copy.drafting.checkout;
  delete copy.judging.checkout;
  const found = localPathsIn(copy, local);
  if (found.length > 0) throw new Error(`A baseline must hold no local path; found: ${found.slice(0, 3).join(" | ")}`);
  return copy;
}

/** Strings in a value that look like a local path or hold the home folder or the user name. */
export function localPathsIn(value: unknown, local: { home: string; user: string }): string[] {
  const found: string[] = [];
  const looksLocal = (text: string) =>
    /(?:^|[\s"'(])(?:\/Users\/|\/home\/|\/private\/|\/var\/folders\/|\/tmp\/|[A-Za-z]:\\)/.test(text) ||
    (local.home.length > 1 && text.includes(local.home)) ||
    (local.user.length > 2 && new RegExp(`\\b${local.user.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text));
  const walk = (node: unknown) => {
    if (typeof node === "string") {
      if (looksLocal(node)) found.push(node.slice(0, 120));
    } else if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (node && typeof node === "object") {
      for (const [key, child] of Object.entries(node)) {
        if (looksLocal(key)) found.push(key);
        walk(child);
      }
    }
  };
  walk(value);
  return found;
}
