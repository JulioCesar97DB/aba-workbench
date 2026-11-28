import { z } from "zod";
import { reviewedFields, type CheckedBehavior, type DefinitionReviewFinding } from "../shared/definition-checks.ts";
import { MAP_TEXT_LIMITS } from "../shared/case-map.ts";
import { cutText } from "./case-map-extraction.ts";
import type { PromptParts } from "./providers/types.ts";
import { quoteForPrompt } from "./rules.ts";

/*
 * The AI review of the behaviors' definitions (T3, owner's decisions of 2026-11-28): one
 * request per map draft, after the behaviors are saved, and again when she asks for it.
 * It reads every definition together, with its topographies, onset, offset, examples and
 * non-examples, and reports the ones that fail the dead-man test and the pairs that would
 * score the same response. It never rewrites a definition: its findings are shown beside
 * the behaviors, in English, citing them by name.
 *
 * The answer is structured (a JSON schema both providers enforce, plain JSON on a route
 * that refuses it) and read with Zod here. There is no repair: a finding that names a
 * behavior the request did not send, or a pair of one behavior with itself, is left out.
 */

export const REVIEW_SCHEMA_NAME = "definition_review";
/** The rules file the review's prompt is built from. */
export const REVIEW_RULES_FILE = "definition-review.md";

type Schema = Record<string, unknown>;
const str: Schema = { type: "string" };
const object = (properties: Record<string, Schema>): Schema => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const list = (items: Schema): Schema => ({ type: "array", items });

/** The answer's JSON schema: strict on both providers, no union, every property required. */
export function reviewAnswerSchema(): Schema {
  return object({
    deadMan: list(object({ behavior: str, why: str })),
    overlaps: list(object({ first: str, second: str, response: str, exclusion: str })),
  });
}

const MAX_FINDINGS = 60;
const Text = z.string().transform((text) => cutText(text.trim(), MAP_TEXT_LIMITS.text));
/** An id field as the model wrote it: any length (a long name where an id belongs is dropped by its id, not a failure of the whole answer; review of T3, finding 4). */
const Key = z.string().transform((key) => key.slice(0, 200));

export const ReviewAnswerSchema = z.strictObject({
  deadMan: z.array(z.strictObject({ behavior: Key, why: Text })).max(MAX_FINDINGS),
  overlaps: z.array(z.strictObject({ first: Key, second: Key, response: Text, exclusion: Text })).max(MAX_FINDINGS),
});
export type ReviewAnswer = z.output<typeof ReviewAnswerSchema>;

/** The answer's JSON, also when a plain-JSON answer comes in a code fence or with text around it. */
function jsonOf(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/u.exec(trimmed);
  if (fenced) return fenced[1];
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  return first >= 0 && last > first ? trimmed.slice(first, last + 1) : trimmed;
}

/**
 * The review's answer as findings, by the ids of the behaviors it was sent. A finding about a
 * behavior it was not sent (a name written where the id belongs, however long), one with an
 * empty reason, response or exclusion, a pair of a behavior with itself, or a pair given twice
 * is left out and counted in `dropped`.
 */
export function parseReviewAnswer(text: string, ids: ReadonlySet<string>): { ok: true; findings: DefinitionReviewFinding[]; dropped: number } | { ok: false; problems: string[] } {
  let json: unknown;
  try {
    json = JSON.parse(jsonOf(text));
  } catch {
    return { ok: false, problems: ["The answer is not JSON."] };
  }
  const parsed = ReviewAnswerSchema.safeParse(json);
  if (!parsed.success) return { ok: false, problems: parsed.error.issues.slice(0, 20).map((issue) => `${issue.path.join(".") || "answer"}: ${issue.message}`) };
  const findings: DefinitionReviewFinding[] = [];
  let dropped = 0;
  const seen = new Set<string>();
  for (const entry of parsed.data.deadMan) {
    const key = `dead-man:${entry.behavior}`;
    if (!ids.has(entry.behavior) || entry.why === "" || seen.has(key)) {
      dropped++;
      continue;
    }
    seen.add(key);
    findings.push({ kind: "dead-man", behaviorId: entry.behavior, why: entry.why });
  }
  for (const entry of parsed.data.overlaps) {
    const pair = [entry.first, entry.second].sort();
    const key = `overlap:${pair.join("|")}`;
    if (!ids.has(entry.first) || !ids.has(entry.second) || entry.first === entry.second || entry.response === "" || entry.exclusion === "" || seen.has(key)) {
      dropped++;
      continue;
    }
    seen.add(key);
    findings.push({ kind: "overlap", behaviorIds: [entry.first, entry.second], response: entry.response, exclusion: entry.exclusion });
  }
  return { ok: true, findings, dropped };
}

export type ReviewFormat = "json-schema" | "plain-json";

/** What the review is sent of each behavior: its id and the fields a definition is judged by. */
export function reviewedBehaviors(behaviors: ReadonlyArray<CheckedBehavior>) {
  return behaviors.map((behavior) => ({ id: behavior.id, ...reviewedFields(behavior) })).filter((behavior) => behavior.name !== "" || behavior.definition.trim() !== "");
}

/**
 * The review's prompt: its rules as the system text, no sources, and the behaviors as JSON in
 * the task. Small on purpose: the definitions alone are what a QA reviewer reads.
 */
export function buildReviewPrompt(rules: string, behaviors: ReturnType<typeof reviewedBehaviors>, format: ReviewFormat): PromptParts {
  const task = [
    `<behaviors>\n${quoteForPrompt(JSON.stringify(behaviors, null, 1))}\n</behaviors>`,
    [
      "Review request: read every definition in <behaviors> together, with its topographies, onset, offset, examples and non-examples.",
      "Return in deadMan each behavior whose definition fails the dead-man test, and in overlaps each pair of behaviors whose definitions would score the same response. Name a behavior in behavior, first and second by its id from <behaviors>; in your texts, call it by its name. Return empty lists when nothing fails.",
      format === "json-schema"
        ? "Answer in the structured format."
        : `Answer with one JSON object and nothing else (no code fence, no text before or after), following this JSON schema exactly:\n${JSON.stringify(reviewAnswerSchema())}`,
    ].join("\n"),
  ].join("\n\n");
  return { system: rules, sources: [], task, kind: "definition-review" };
}
