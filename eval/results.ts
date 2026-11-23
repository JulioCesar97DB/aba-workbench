/*
 * What one evaluation run writes (results.json), how two runs are compared, and the short
 * Markdown summary. Pure functions over plain data (tests/eval-rubric.test.ts).
 *
 * The verdict (review round 1, B3):
 * - hard: a code item that went down, a check that passed in the baseline and finds
 *   something now, or an item scored in the baseline and not scored now. The code items of
 *   the baseline are scored again with the current checks before the comparison, so a
 *   change to the checks never reads as a change of the rules.
 * - soft: judge items that went down or up. They are reported apart from the verdict,
 *   because a single judge sample has a noise nobody has measured yet; they are compared
 *   only where both runs were judged with the same judge (same prompt, inputs, model and
 *   samples: the judge fingerprint).
 * - NOT COMPARED: another rubric version, provider or drafting mode.
 * - INVALID: a window or the Dock icon showed during the run.
 */
import type { JudgeAnswer, JudgeFormat } from "../src/lib/judge.ts";
import { REPORT_SECTIONS, type ReportSectionId } from "../src/shared/report-sections.ts";
import type { CheckId, Finding } from "./checks/checks.ts";
import { codeScore, keyFactsScore, RUBRIC, type CodeItem, type Score } from "./rubric.ts";

export const RESULTS_VERSION = 2;

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
  sections: SectionResult[];
}

export interface LaunchCheck {
  /** Which app was started: the one that drafts (the rules under test) or the one that judges. */
  role: "draft" | "judge";
  visibleWindows: number;
  dockVisible: boolean | null;
  focusedWindows: number;
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

/* Reading older results ------------------------------------------------------------------ */

/** The last part of a path, so an older record never carries the path itself. */
function neutralLabel(value: unknown, fallback: string): string {
  if (typeof value !== "string" || value === "") return fallback;
  const parts = value.split(/[\\/]/).filter((part) => part !== "");
  return parts.at(-1) ?? fallback;
}

/**
 * Any results.json as this version reads it: a version 1 file gets its judge answers as a
 * list, labels instead of paths, the checks version it was made with ("1"), one sample and
 * no fingerprint (so its judge items are never taken as comparable).
 */
export function normalizeRun(raw: unknown): RunResult {
  const run = structuredClone(raw) as RunResult & {
    drafting: RunResult["drafting"] & { checkout?: string };
    judging: RunResult["judging"] & { checkout?: string };
    cases: Array<CaseResult & { sections: Array<SectionResult & { judge: (JudgeRecord & { answer?: JudgeAnswer | null }) | null }> }>;
  };
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
    for (const s of c.sections) {
      if (!s.judge) continue;
      if (!Array.isArray(s.judge.answers)) s.judge.answers = s.judge.answer ? [s.judge.answer] : [];
      delete s.judge.answer;
      s.judge.fingerprint ??= "";
    }
  }
  run.resultsVersion = RESULTS_VERSION;
  return run;
}

/**
 * The baseline as the current checks see it (review B3, part 1): its stored texts checked
 * again (`findings` per case, by the caller), and its code items scored again; its judge
 * answers stay as they are.
 */
export function rescoreRun(run: RunResult, findingsByCase: ReadonlyMap<string, readonly Finding[]>): RunResult {
  const copy = structuredClone(run);
  for (const c of copy.cases) {
    const findings = findingsByCase.get(c.caseId);
    if (!findings) continue;
    for (const s of c.sections) {
      s.findings = findings.filter((finding) => finding.section === s.id);
      s.scores = scoreSection(s.id, s.findings, s.judge?.answers ?? [], s.text !== null);
    }
  }
  return copy;
}

/* The comparison ----------------------------------------------------------------------- */

export type CompareStatus = "pass" | "regression" | "not-compared" | "invalid";

interface ItemChange {
  caseId: string;
  section: ReportSectionId;
  item: string;
  from: Score;
  to: Score;
}

export interface Comparison {
  status: CompareStatus;
  /** Why not compared, why invalid, and what else differs between the runs. */
  notes: string[];
  /** Hard: a code item that went down. */
  codeDrops: ItemChange[];
  codeRises: ItemChange[];
  /** Hard: a check that found nothing in the baseline and finds something now (provisional findings left out). */
  newFailures: Array<{ caseId: string; section: ReportSectionId; check: CheckId; findings: string[] }>;
  /** Hard: scored in the baseline, not scored now (no draft, or no judge answer). */
  unscored: Array<{ caseId: string; section: ReportSectionId; item: string }>;
  /** Soft, apart from the verdict: judge items that moved, where both runs had the same judge. */
  judgeDrops: ItemChange[];
  judgeRises: ItemChange[];
  /** Sections whose judge items were not compared: another judge (fingerprint) in one of the runs. */
  judgeNotCompared: Array<{ caseId: string; section: ReportSectionId }>;
}

/** Compares a run with the last accepted one (already rescored with the current checks: rescoreRun). */
export function compareRuns(current: RunResult, baseline: RunResult): Comparison {
  const comparison: Comparison = { status: "pass", notes: [], codeDrops: [], codeRises: [], newFailures: [], unscored: [], judgeDrops: [], judgeRises: [], judgeNotCompared: [] };
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
  if (current.model !== baseline.model) comparison.notes.push(`The drafting model differs: ${baseline.model ?? "unknown"} in the baseline, ${current.model ?? "unknown"} now.`);
  if (current.judgeFormat !== baseline.judgeFormat) comparison.notes.push(`The judge format differs: ${baseline.judgeFormat ?? "none"} in the baseline, ${current.judgeFormat ?? "none"} now.`);
  if (current.judgeSamples !== baseline.judgeSamples) comparison.notes.push(`Judge samples differ: ${baseline.judgeSamples} in the baseline, ${current.judgeSamples} now.`);
  for (const c of current.cases) if (!baseline.cases.some((b) => b.caseId === c.caseId)) comparison.notes.push(`Case ${c.caseId} is new: the baseline has no run of it, so it is not compared.`);
  for (const baseCase of baseline.cases) {
    const nowCase = current.cases.find((c) => c.caseId === baseCase.caseId);
    if (!nowCase) {
      comparison.notes.push(`Case ${baseCase.caseId} is in the baseline but was not run.`);
      continue;
    }
    if (nowCase.keyVersion !== baseCase.keyVersion) comparison.notes.push(`Case ${baseCase.caseId}: its key changed (version ${baseCase.keyVersion} to ${nowCase.keyVersion}).`);
    for (const baseSection of baseCase.sections) {
      const nowSection = nowCase.sections.find((s) => s.id === baseSection.id);
      if (!nowSection) continue;
      const sameJudge = Boolean(baseSection.judge?.fingerprint) && baseSection.judge?.fingerprint === nowSection.judge?.fingerprint;
      let judgeSkipped = false;
      for (const [item, before] of Object.entries(baseSection.scores)) {
        if (before === null) continue;
        const after = nowSection.scores[item] ?? null;
        const change = { caseId: baseCase.caseId, section: baseSection.id, item };
        if (after === null) {
          comparison.unscored.push(change);
          continue;
        }
        if (CODE_ITEMS.has(item)) {
          if (after < before) comparison.codeDrops.push({ ...change, from: before, to: after });
          else if (after > before) comparison.codeRises.push({ ...change, from: before, to: after });
        } else if (!sameJudge) {
          judgeSkipped = true;
        } else if (after < before) {
          comparison.judgeDrops.push({ ...change, from: before, to: after });
        } else if (after > before) {
          comparison.judgeRises.push({ ...change, from: before, to: after });
        }
      }
      if (judgeSkipped) comparison.judgeNotCompared.push({ caseId: baseCase.caseId, section: baseSection.id });
      if (baseSection.text === null || nowSection.text === null) continue;
      for (const check of CODE_CHECKS) {
        const counted = (findings: readonly Finding[]) => findings.filter((finding) => finding.check === check && !finding.provisional);
        if (counted(baseSection.findings).length > 0) continue;
        const now = counted(nowSection.findings);
        if (now.length > 0) comparison.newFailures.push({ caseId: baseCase.caseId, section: baseSection.id, check, findings: now.map((finding) => finding.message) });
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
  const judge = `Judge items, apart from the verdict: ${comparison.judgeDrops.length} down, ${comparison.judgeRises.length} up${comparison.judgeNotCompared.length > 0 ? `, ${plural(comparison.judgeNotCompared.length, "section", "sections")} not comparable` : ""}.`;
  if (comparison.status === "pass") return `No hard regression: no code item went down, no check that passed in the baseline fails now, and nothing went unscored. ${judge}`;
  const parts: string[] = [];
  if (comparison.codeDrops.length > 0) parts.push(`${plural(comparison.codeDrops.length, "code item score", "code item scores")} went down`);
  if (comparison.newFailures.length > 0) parts.push(`${plural(comparison.newFailures.length, "check that passed in the baseline fails", "checks that passed in the baseline fail")} now`);
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

function totals(run: RunResult): { code: [number, number]; judge: [number, number] } {
  const t = { code: [0, 0] as [number, number], judge: [0, 0] as [number, number] };
  for (const c of run.cases) {
    for (const s of c.sections) {
      for (const [item, score] of Object.entries(s.scores)) {
        if (score === null) continue;
        const bucket = CODE_ITEMS.has(item) ? t.code : t.judge;
        bucket[0] += score;
        bucket[1] += 2;
      }
    }
  }
  return t;
}

/** The short Markdown summary written next to results.json. */
export function summaryMarkdown(run: RunResult, comparison: Comparison | null, baselineLabel: string | null, baseline: RunResult | null = null): string {
  const lines: string[] = [];
  lines.push(`# Evaluation run: ${run.label}`, "");
  lines.push(`**${verdictLine(comparison, run)}**${baselineLabel ? ` (baseline: ${baselineLabel})` : ""}`, "");
  const t = totals(run);
  const judgeUsage = run.cases.flatMap((c) => c.sections.map((s) => s.judge?.usage ?? null)).reduce<Usage | null>(addUsage, null);
  const judgeInput = judgeUsage ? judgeUsage.uncachedInputTokens + judgeUsage.cacheReadTokens + judgeUsage.cacheWriteTokens : 0;
  lines.push(
    `- Drafted by ${run.drafting.label} (${run.drafting.branch} at ${run.drafting.commit.slice(0, 7)})${run.drafting.dirty ? " with UNCOMMITTED changes" : ""}; judged by ${run.judging.label} at ${run.judging.commit.slice(0, 7)}${run.judging.dirty ? " with UNCOMMITTED changes" : ""}.`,
    `- Rubric v${run.rubricVersion}, judge prompt v${run.judgePromptVersion}, checks v${run.checksVersion}, ${plural(run.judgeSamples, "judge sample", "judge samples")} per section (median when more than one); judge format ${run.judgeFormat ?? "none"}; ${run.provider}, ${run.model ?? "model unknown"}; ${run.mode} drafting.`,
    ...(run.fromRun ? [`- ${run.rejudged ? "Every section judged again" : "Judged again only where there was no answer"} from run ${run.fromRun}'s drafts, checked again with the current checks. The request counts below are both runs together.`] : []),
    `- Requests: ${run.requests.total} (${run.requests.drafts} drafts, ${run.requests.checks} consistency checks, ${run.requests.judges} judge, ${run.requests.repairs} repairs, ${run.requests.baselineJudges} judging the baseline's drafts again). ${run.startedAt} to ${run.finishedAt}.`,
    `- Judge input: ${judgeInput} tokens, ${judgeUsage?.cacheReadTokens ?? 0} read from the cache.`,
    `- Windows: ${run.launches.filter((launch) => launch.at !== "during").map((launch) => `${launch.role} ${launch.at}: ${launch.visibleWindows} visible, Dock ${launch.dockVisible === null ? "n/a" : launch.dockVisible ? "VISIBLE" : "hidden"}, ${launch.focusedWindows} focused`).join("; ")}; ${run.windowChecksDuring} checks during the run${run.valid ? ", all clear" : ", NOT clear"}.`,
    `- Scores: code items ${t.code[0]} of ${t.code[1]}, judge items ${t.judge[0]} of ${t.judge[1]}${baseline ? `; the baseline as the current checks score it: code ${totals(baseline).code[0]} of ${totals(baseline).code[1]}, judge ${totals(baseline).judge[0]} of ${totals(baseline).judge[1]}` : ""}.`,
    "",
  );
  const items = RUBRIC.filter((item) => item.stage === "body");
  for (const c of run.cases) {
    const base = baseline?.cases.find((b) => b.caseId === c.caseId) ?? null;
    lines.push(`## ${c.caseId}`, "");
    if (base) lines.push("Each cell: baseline → this run.", "");
    lines.push(`| Item | ${c.sections.map((s) => SHORT[s.id]).join(" | ")} |`, `| --- | ${c.sections.map(() => "---").join(" | ")} |`);
    for (const item of items) {
      const row = c.sections.map((s) => {
        const before = base?.sections.find((b) => b.id === s.id)?.scores[item.id];
        return base ? `${cell(before)} → ${cell(s.scores[item.id])}` : cell(s.scores[item.id]);
      });
      lines.push(`| ${item.id} (${item.scoredBy}) | ${row.join(" | ")} |`);
    }
    lines.push(`| words | ${c.sections.map((s) => String(s.words)).join(" | ")} |`, `| markers | ${c.sections.map((s) => String(s.markers.length)).join(" | ")} |`, "");
    const instructions = Object.entries(c.inputs.instructions).filter(([, text]) => text && text.trim() !== "");
    lines.push(`- Her inputs: ${c.inputs.notes.trim() ? "session notes given" : "no session notes"}; ${instructions.length > 0 ? `standing instructions for ${instructions.map(([id]) => SHORT[id as ReportSectionId]).join(", ")}` : "no standing instructions (every section's cleared)"}.`);
    if (c.keyNotes && c.keyNotes.length > 0) lines.push("- Provisional in the key, for her to confirm:", ...c.keyNotes.map((note) => `  - ${note}`));
    const provisional = c.sections.flatMap((s) => s.findings.filter((finding) => finding.provisional).map((finding) => `${SHORT[s.id]}: ${finding.message}`));
    if (provisional.length > 0) lines.push("- Provisional, not scored (a rule pending her answer):", ...provisional.map((line) => `  - ${line}`));
    const problems = c.sections.filter((s) => s.draftError || s.judge?.error);
    for (const s of problems) lines.push(`- ${SHORT[s.id]}: ${s.draftError ? `draft failed: ${s.draftError}` : `judge: ${s.judge?.error}`}`);
    lines.push("");
  }
  if (comparison && comparison.status !== "invalid") {
    if (comparison.notes.length > 0) lines.push("## Notes", "", ...comparison.notes.map((note) => `- ${note}`), "");
    const list = (title: string, changes: readonly ItemChange[]) => (changes.length > 0 ? [title, "", ...changes.map((d) => `- ${d.caseId} ${SHORT[d.section]} ${d.item}: ${d.from} → ${d.to}`), ""] : []);
    lines.push(...list("## Hard: code items that went down", comparison.codeDrops));
    if (comparison.newFailures.length > 0) lines.push("## Hard: checks that passed and fail now", "", ...comparison.newFailures.map((f) => `- ${f.caseId} ${SHORT[f.section]} ${f.check}: ${f.findings.slice(0, 3).join(" / ")}`), "");
    if (comparison.unscored.length > 0) lines.push("## Hard: not scored this time", "", ...comparison.unscored.map((u) => `- ${u.caseId} ${SHORT[u.section]} ${u.item}`), "");
    lines.push(...list("## Code items that went up", comparison.codeRises));
    lines.push(
      ...list(`## Judge items that went down (apart from the verdict; ${plural(run.judgeSamples, "sample", "samples")}, noise not measured)`, comparison.judgeDrops),
      ...list("## Judge items that went up", comparison.judgeRises),
    );
    if (comparison.judgeNotCompared.length > 0) lines.push("## Judge items not compared (another judge)", "", ...comparison.judgeNotCompared.map((s) => `- ${s.caseId} ${SHORT[s.section]}`), "");
  }
  lines.push("Sections: " + REPORT_SECTIONS.map((s) => `${SHORT[s.id]} ${s.title}`).join("; ") + ".", "");
  return lines.join("\n");
}

/* Baselines ---------------------------------------------------------------------------- */

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
