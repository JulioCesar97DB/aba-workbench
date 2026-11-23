/*
 * What one evaluation run writes (results.json), how two runs are compared, and the short
 * Markdown summary. Pure functions over plain data (tests/eval-results.test.ts).
 */
import type { JudgeAnswer, JudgeFormat } from "../src/lib/judge.ts";
import { REPORT_SECTIONS, type ReportSectionId } from "../src/shared/report-sections.ts";
import type { CheckId, Finding } from "./checks/checks.ts";
import { codeScore, keyFactsScore, RUBRIC, type CodeItem, type Score } from "./rubric.ts";

export const RESULTS_VERSION = 1;

export interface Usage {
  uncachedInputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  reasoningTokens: number | null;
}

export interface JudgeRecord {
  /** The format that produced the answer used (or was last tried). */
  format: JudgeFormat;
  /** Whether the one repair request was needed. */
  repaired: boolean;
  answer: JudgeAnswer | null;
  /** Why there is no answer: the request failed, or the repaired answer was still not valid. */
  error: string | null;
  requests: number;
  seconds: number;
  usage: Usage | null;
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
  sections: SectionResult[];
}

export interface LaunchCheck {
  /** Which app was started: the one that drafts (the rules under test) or the one that judges. */
  role: "draft" | "judge";
  visibleWindows: number;
  dockVisible: boolean | null;
  focusedWindows: number;
  at: "launch" | "end";
}

export interface RunResult {
  resultsVersion: typeof RESULTS_VERSION;
  label: string;
  startedAt: string;
  finishedAt: string;
  rubricVersion: string;
  judgePromptVersion: string;
  drafting: { checkout: string; commit: string; branch: string; dirty: boolean; rulesVersions: Record<string, string> };
  judging: { checkout: string; commit: string };
  provider: string;
  model: string | null;
  mode: "chained" | "independent";
  /** The judge format the route accepted ("json-schema", or "plain-json" after it refused the schema). */
  judgeFormat: JudgeFormat | null;
  requests: { drafts: number; checks: number; judges: number; repairs: number; total: number };
  launches: LaunchCheck[];
  /** Set when this run re-scored and re-judged an earlier run's drafts (pnpm eval --from-run): that run's label. */
  fromRun?: string;
  cases: CaseResult[];
}

/** The code items' scores from a section's findings, and the judge items' from its answer. */
export function scoreSection(section: ReportSectionId, findings: readonly Finding[], judge: JudgeAnswer | null, hasText: boolean): Record<string, Score | null> {
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

export interface Comparison {
  /** False when the runs used different rubric versions: items are not compared then. */
  comparable: boolean;
  notes: string[];
  /** A rubric item that went down. */
  drops: Array<{ caseId: string; section: ReportSectionId; item: string; from: Score; to: Score }>;
  rises: Array<{ caseId: string; section: ReportSectionId; item: string; from: Score; to: Score }>;
  /** A check that found nothing in the baseline and finds something now. */
  newFailures: Array<{ caseId: string; section: ReportSectionId; check: CheckId; findings: string[] }>;
  /** Scored in the baseline, not scored now (no draft or no judge answer): it cannot be said it did not go down. */
  unscored: Array<{ caseId: string; section: ReportSectionId; item: string }>;
  /** The plain verdict. */
  regressed: boolean;
}

const checksOf = (findings: readonly Finding[], check: CheckId) => findings.filter((finding) => finding.check === check);

/** Compares a run with the last accepted one, case by case and section by section. */
export function compareRuns(current: RunResult, baseline: RunResult): Comparison {
  const comparison: Comparison = { comparable: current.rubricVersion === baseline.rubricVersion, notes: [], drops: [], rises: [], newFailures: [], unscored: [], regressed: false };
  if (!comparison.comparable) comparison.notes.push(`The baseline used rubric version ${baseline.rubricVersion} and this run ${current.rubricVersion}: rubric items are not compared, only the checks.`);
  if (current.judgePromptVersion !== baseline.judgePromptVersion) comparison.notes.push(`The judge's prompt changed (version ${baseline.judgePromptVersion} to ${current.judgePromptVersion}): a judge item's change may come from the judge.`);
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
      if (comparison.comparable) {
        for (const [item, before] of Object.entries(baseSection.scores)) {
          if (before === null) continue;
          const after = nowSection.scores[item] ?? null;
          if (after === null) comparison.unscored.push({ caseId: baseCase.caseId, section: baseSection.id, item });
          else if (after < before) comparison.drops.push({ caseId: baseCase.caseId, section: baseSection.id, item, from: before, to: after });
          else if (after > before) comparison.rises.push({ caseId: baseCase.caseId, section: baseSection.id, item, from: before, to: after });
        }
      }
      if (baseSection.text === null || nowSection.text === null) continue;
      const checks = new Set<CheckId>(RUBRIC.filter((item): item is CodeItem => item.scoredBy === "code").map((item) => item.check));
      for (const check of checks) {
        if (checksOf(baseSection.findings, check).length > 0) continue;
        const now = checksOf(nowSection.findings, check);
        if (now.length > 0) comparison.newFailures.push({ caseId: baseCase.caseId, section: baseSection.id, check, findings: now.map((finding) => finding.message) });
      }
    }
  }
  comparison.regressed = comparison.drops.length > 0 || comparison.newFailures.length > 0 || comparison.unscored.length > 0;
  return comparison;
}

/** The verdict in one plain sentence. */
export function verdictLine(comparison: Comparison | null): string {
  if (!comparison) return "No accepted baseline to compare with: this run is not compared.";
  if (!comparison.regressed) return "No rubric item went down, and no check that passed in the baseline fails now.";
  const parts: string[] = [];
  if (comparison.drops.length > 0) parts.push(`${comparison.drops.length} rubric item score${comparison.drops.length === 1 ? "" : "s"} went down`);
  if (comparison.newFailures.length > 0) parts.push(`${comparison.newFailures.length} check${comparison.newFailures.length === 1 ? "" : "s"} that passed in the baseline fail${comparison.newFailures.length === 1 ? "s" : ""} now`);
  if (comparison.unscored.length > 0) parts.push(`${comparison.unscored.length} item${comparison.unscored.length === 1 ? " was" : "s were"} scored in the baseline but not now`);
  return `REGRESSION: ${parts.join("; ")}. This rules change does not go to the BCBA as it is.`;
}

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

/** The short Markdown summary written next to results.json. */
export function summaryMarkdown(run: RunResult, comparison: Comparison | null, baselineLabel: string | null): string {
  const lines: string[] = [];
  lines.push(`# Evaluation run: ${run.label}`, "");
  lines.push(`**${verdictLine(comparison)}**${baselineLabel ? ` (baseline: ${baselineLabel})` : ""}`, "");
  lines.push(
    `- Drafted by ${run.drafting.branch} at ${run.drafting.commit.slice(0, 7)}${run.drafting.dirty ? " (uncommitted changes)" : ""}; judged by ${run.judging.commit.slice(0, 7)}.`,
    `- Rubric v${run.rubricVersion}, judge prompt v${run.judgePromptVersion}, judge format ${run.judgeFormat ?? "none"}; ${run.provider}, ${run.model ?? "model unknown"}; ${run.mode} drafting.`,
    ...(run.fromRun ? [`- Re-judged from run ${run.fromRun}: its drafts, checked again, and the judge asked again only where it had no answer. Requests below are both runs together.`] : []),
    `- Requests: ${run.requests.total} (${run.requests.drafts} drafts, ${run.requests.checks} consistency checks, ${run.requests.judges} judge, ${run.requests.repairs} repairs). ${run.startedAt} to ${run.finishedAt}.`,
    `- Windows: ${run.launches.map((launch) => `${launch.role} ${launch.at}: ${launch.visibleWindows} visible, dock ${launch.dockVisible === null ? "n/a" : launch.dockVisible ? "VISIBLE" : "hidden"}, ${launch.focusedWindows} focused`).join("; ")}.`,
    "",
  );
  const items = RUBRIC.filter((item) => item.stage === "body");
  for (const c of run.cases) {
    lines.push(`## ${c.caseId}`, "");
    lines.push(`| Item | ${c.sections.map((s) => SHORT[s.id]).join(" | ")} |`, `| --- | ${c.sections.map(() => "---").join(" | ")} |`);
    for (const item of items) lines.push(`| ${item.id} (${item.scoredBy}) | ${c.sections.map((s) => cell(s.scores[item.id])).join(" | ")} |`);
    lines.push(`| words | ${c.sections.map((s) => String(s.words)).join(" | ")} |`, `| markers | ${c.sections.map((s) => String(s.markers.length)).join(" | ")} |`, "");
    const problems = c.sections.filter((s) => s.draftError || s.judge?.error);
    for (const s of problems) lines.push(`- ${SHORT[s.id]}: ${s.draftError ? `draft failed: ${s.draftError}` : `judge failed: ${s.judge?.error}`}`);
    if (problems.length > 0) lines.push("");
  }
  if (comparison) {
    if (comparison.notes.length > 0) lines.push("## Notes", "", ...comparison.notes.map((note) => `- ${note}`), "");
    if (comparison.drops.length > 0) lines.push("## Went down", "", ...comparison.drops.map((d) => `- ${d.caseId} ${SHORT[d.section]} ${d.item}: ${d.from} → ${d.to}`), "");
    if (comparison.newFailures.length > 0) lines.push("## Checks that passed and fail now", "", ...comparison.newFailures.map((f) => `- ${f.caseId} ${SHORT[f.section]} ${f.check}: ${f.findings.slice(0, 3).join(" / ")}`), "");
    if (comparison.unscored.length > 0) lines.push("## Not scored this time", "", ...comparison.unscored.map((u) => `- ${u.caseId} ${SHORT[u.section]} ${u.item}`), "");
    if (comparison.rises.length > 0) lines.push("## Went up", "", ...comparison.rises.map((r) => `- ${r.caseId} ${SHORT[r.section]} ${r.item}: ${r.from} → ${r.to}`), "");
  }
  lines.push("Sections: " + REPORT_SECTIONS.map((s) => `${SHORT[s.id]} ${s.title}`).join("; ") + ".", "");
  return lines.join("\n");
}
