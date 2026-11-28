/*
 * What code computes in the plan instead of the AI (proposal §4.4; D10, D11, D12, D13).
 * Every value here is computed when it is shown or copied, never stored, so it cannot go
 * stale (coordinator's answer of 2026-11-28 to PR 1's question 4). She can override a
 * computed baseline, mastery or program target for a case: the override is her value,
 * stored and marked hers, and wins; clearing it brings the computation back.
 *
 * When in doubt the code gives nothing and says so: a count that is not a plain number
 * gives no baseline, an age it cannot read gives no under-5 rule.
 */

import type { ClientAge } from "./api.ts";
import type { MasteryCategory, PlanParameter, ProgramItem } from "./plan.ts";

/** A plain non-negative number, alone in its text ("12", "12.5", "20 %", "20%"): anything else is null. */
export function plainNumber(text: string | null | undefined, { percent = false }: { percent?: boolean } = {}): number | null {
  const trimmed = (text ?? "").trim();
  const match = (percent ? /^(\d+(?:[.,]\d+)?)\s*%?$/u : /^(\d+(?:[.,]\d+)?)$/u).exec(trimmed);
  return match ? Number(match[1].replace(",", ".")) : null;
}

/** A whole number, alone in its text: a count of correct responses or of opportunities. */
export function plainCount(text: string | null | undefined): number | null {
  const match = /^(\d{1,4})$/u.exec((text ?? "").trim());
  return match ? Number(match[1]) : null;
}

/** Rounded to the nearest 10% (D11): her baselines are multiples of 10, from 10 opportunities. A half rounds up. */
export function roundToTen(percent: number): number {
  return Math.min(100, Math.max(0, Math.round(percent / 10) * 10));
}

/**
 * The child's age in whole years: from the map's client age when it reads plainly ("6 years
 * 4 months", "6 años", "6;4", "6"), otherwise the case's own age; null when neither says.
 */
export function ageInYears(mapAge: string | null | undefined, caseAge: ClientAge | null | undefined): number | null {
  const text = (mapAge ?? "").trim().toLowerCase();
  const match = /^(\d{1,2})(?:\s*(?:years?|yrs?|y|años?|a)(?![a-z])|\s*;\s*\d{1,2}|\s*$)/u.exec(text);
  if (match) return Number(match[1]);
  return caseAge ? caseAge.years : null;
}

export type TargetRule = "under-5" | "hours" | "default" | "override";

export interface ProgramTarget {
  target: number;
  rule: TargetRule;
  /** No weekly hours from a child of 5 or more (or of unknown age): the app counts 30, her usual plan, and says so as an open item. */
  openItem: boolean;
  ageYears: number | null;
  hours: number | null;
}

/** Her usual plan when she gives no weekly hours (programs.md). */
export const DEFAULT_PROGRAMS = 30;
export const UNDER_FIVE_PROGRAMS = 25;

/** Weekly hours of 97153 she typed: a plain number from 1 to 60, or null. */
export function weeklyHours(text: string | null | undefined): number | null {
  const hours = plainNumber(text);
  return hours !== null && hours >= 1 && hours <= 60 ? hours : null;
}

/**
 * How many programs, by her rule (D10; programs.md): about 25 under age 5; from 5, about one
 * per weekly hour of direct therapy; 30 with an open item when she gives no hours. Her
 * override, a plain whole number from 1 to 99, wins.
 */
export function programTarget(input: { ageYears: number | null; hoursText: string | null | undefined; overrideText?: string | null }): ProgramTarget {
  const hours = weeklyHours(input.hoursText);
  const override = plainCount(input.overrideText);
  if (override !== null && override >= 1 && override <= 99) return { target: override, rule: "override", openItem: false, ageYears: input.ageYears, hours };
  if (input.ageYears !== null && input.ageYears < 5) return { target: UNDER_FIVE_PROGRAMS, rule: "under-5", openItem: false, ageYears: input.ageYears, hours };
  if (hours !== null) return { target: Math.round(hours), rule: "hours", openItem: false, ageYears: input.ageYears, hours };
  return { target: DEFAULT_PROGRAMS, rule: "default", openItem: true, ageYears: input.ageYears, hours: null };
}

/** One session's percent, correct over opportunities; null when either is not a plain count, there is no opportunity, or more correct than opportunities. */
export function sessionPercent(correct: string | null | undefined, opportunities: string | null | undefined): number | null {
  const right = plainCount(correct);
  const chances = plainCount(opportunities);
  if (right === null || chances === null || chances === 0 || right > chances) return null;
  return (right / chances) * 100;
}

export interface SkillBaseline {
  /** The baseline as a percent, or null when nothing gives one ([MISSING]). */
  percent: number | null;
  source: "sessions" | "caregiver" | "override" | "none";
  /** The caregiver's report gives it: marked [CHECK] for her (D11). */
  check: boolean;
  /** Each session's percent, unrounded, or null when that session cannot be read. */
  sessions: Array<number | null>;
  /** Sessions were entered, but one cannot be read: no mean (the app never guesses). */
  unreadable: boolean;
}

/**
 * A skill's baseline (D11): the mean of its sessions' percents, rounded to the nearest 10%.
 * With no sessions, the caregiver's report gives it, rounded the same way, with a [CHECK].
 * When a session cannot be read, there is no baseline from the sessions and the report is
 * not used in their place: she fixes the session. Her override wins.
 */
export function skillBaseline(baseline: ProgramItem["baseline"]): SkillBaseline {
  const sessions = baseline.sessions.map((session) => sessionPercent(session.correct?.value, session.opportunities?.value));
  const override = plainNumber(baseline.override?.value, { percent: true });
  if (override !== null && override <= 100) return { percent: override, source: "override", check: false, sessions, unreadable: false };
  if (sessions.length > 0) {
    if (sessions.some((value) => value === null)) return { percent: null, source: "none", check: false, sessions, unreadable: true };
    const mean = (sessions as number[]).reduce((sum, value) => sum + value, 0) / sessions.length;
    return { percent: roundToTen(mean), source: "sessions", check: false, sessions, unreadable: false };
  }
  const reported = plainNumber(baseline.caregiverPercent?.value, { percent: true });
  if (reported !== null && reported <= 100) return { percent: roundToTen(reported), source: "caregiver", check: true, sessions, unreadable: false };
  return { percent: null, source: "none", check: false, sessions, unreadable: false };
}

export const MASTERY_PERCENT: Readonly<Record<MasteryCategory, number>> = { general: 90, safety: 95, "street-crossing": 100 };
/** Caregiver goals' mastery, by her patterns' LTO (reading 4). */
export const CAREGIVER_MASTERY = 95;

/** A mastery criterion from its category (D12), or her override. An unknown category reads as general. */
export function masteryPercent(category: string, overrideText?: string | null): { percent: number; source: "category" | "override" } {
  const override = plainNumber(overrideText, { percent: true });
  if (override !== null && override > 0 && override <= 100) return { percent: override, source: "override" };
  return { percent: MASTERY_PERCENT[category as MasteryCategory] ?? MASTERY_PERCENT.general, source: "category" };
}

/** A caregiver goal's baseline: 0, 10 or 20 (programs.md). Above 0 means earlier training, marked [CHECK]. Null when not given. */
export function caregiverBaseline(text: string | null | undefined): { percent: number; check: boolean } | null {
  const percent = plainNumber(text, { percent: true });
  if (percent === null || percent > 100) return null;
  return { percent, check: percent > 0 };
}

/** "Immediately", "at once", "right away" and their Spanish: 0 seconds (proposal §5.1). */
const AT_ONCE = /^(?:immediately|at once|right away|inmediatamente|de inmediato|enseguida|al instante)$/iu;

/** A parameter as seconds: a plain number in s or min, or "immediately" (0). Null otherwise. */
export function parameterSeconds(parameter: Pick<PlanParameter, "value" | "unit">): number | null {
  const text = (parameter.value?.value ?? "").trim();
  if (AT_ONCE.test(text)) return 0;
  const value = plainNumber(text);
  if (value === null) return null;
  if (parameter.unit === "s") return value;
  if (parameter.unit === "min") return value * 60;
  return null;
}

/** A parameter as feet: a plain number in ft. Null otherwise. */
export function parameterFeet(parameter: Pick<PlanParameter, "value" | "unit">): number | null {
  if (parameter.unit !== "ft") return null;
  return plainNumber(parameter.value?.value);
}

/** Alphabetical order of names, case and accents aside (D15). */
export function byName<T>(items: readonly T[], nameOf: (item: T) => string): T[] {
  const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });
  return [...items].sort((a, b) => collator.compare(nameOf(a), nameOf(b)));
}
