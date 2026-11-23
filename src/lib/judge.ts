import { z } from "zod";
import type { PromptParts, SourceDocument } from "./providers/types.ts";
import { quoteForPrompt, SECTIONS, type SectionId } from "./rules.ts";

/*
 * The evaluation's judge (development only; pnpm eval, docs/evaluation.md): one request
 * per section that scores the rubric items code cannot measure. Its prompt is built here
 * and sent through the same path as her requests (src/main/outgoing.ts prepares it, the
 * section service runs it on the connected provider). The judge's own instructions are
 * fixed with its version, never taken from the rules under test, so a rules change
 * cannot move the bar it is measured against.
 *
 * The answer is structured: a JSON schema the provider enforces when it can (OpenAI's
 * text.format), and the same shape asked for as plain JSON otherwise, validated with Zod
 * here and repaired once (eval/run.mts).
 */

/**
 * Version 2 (review round 1): the judge reads the session notes and the section's standing
 * instructions (B2) and the payer facts of the section; every input is quoted (M5).
 */
export const JUDGE_PROMPT_VERSION = "2";

/** How the answer is asked for: enforced by the provider's JSON schema, or plain JSON in the text. */
export type JudgeFormat = "json-schema" | "plain-json";

const Item = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]{1,60}$/),
  title: z.string().min(1).max(200),
  anchors: z.strictObject({ "2": z.string().min(1).max(1000), "1": z.string().min(1).max(1000), "0": z.string().min(1).max(1000) }),
});

/** What the harness sends for one judge request (plain data through window.aba; checked here before anything is read). */
export const JudgeInputSchema = z.strictObject({
  rubricVersion: z.string().min(1).max(20),
  items: z.array(Item).min(1).max(20),
  /** Her structure and shape for this section. */
  expectations: z.array(z.string().min(1).max(2000)).max(10),
  /** The facts this section must contain, from the case key. */
  keyFacts: z.array(z.strictObject({ id: z.string().regex(/^[a-z0-9-]{1,60}$/), fact: z.string().min(1).max(1000) })).max(30),
  /** What the key says about the case that the judge needs (behavior names and functions, planted gaps). */
  caseNotes: z.array(z.string().min(1).max(1000)).max(30),
  /** What the payer requires of this section: text it requires is not invented. */
  payerFacts: z.array(z.string().min(1).max(1500)).max(10),
  format: z.enum(["json-schema", "plain-json"]),
  /** The previous answer and what was wrong with it, for the one repair request. */
  repair: z.strictObject({ previousAnswer: z.string().max(60_000), problems: z.array(z.string().max(500)).min(1).max(30) }).nullable(),
});
export type JudgeInput = z.infer<typeof JudgeInputSchema>;

/** One section of the assessment as the judge sees it. */
export interface JudgedSection {
  id: SectionId;
  text: string;
}

const JUDGE_SYSTEM = [
  "You are the reviewer of an evaluation set for an app that drafts ABA initial assessments (Florida Medicaid, Molina) with a BCBA. The case is invented.",
  "You score one section of a drafted assessment against a rubric. You do not rewrite it, and you never suggest text.",
  "",
  "How to score:",
  "- Score each rubric item 0, 1 or 2 by its anchors, for the section under review only. The other sections are there so you can judge the thread and what each section owns; do not score them.",
  "- Read the sources, the session notes and her standing instructions for the section: a fact is invented when none of them gives it. Text the payer requires of the section (<payer-facts>) is not invented. A clinical proposal (a named procedure, a parameter, a program title, a support, a criterion) that none of them gives is invented unless it is marked [MISSING: ...] or [CHECK: ...].",
  "- Who owns what: Background Information owns the history, family, diagnosis wording, medication, school and other services; Medical Necessity owns the argument for need and the scores explained; Strengths and Weaknesses owns strengths and names the deficit areas without their numbers; Environmental Changes owns the changes and their supports; Family/Caregiver Involvement owns who takes part and what training covers; Generalization and Maintenance owns generalization and maintenance; Discharge owns the criteria and how services step down; Risk Assessment owns each risk and its evidence; Crisis Plan owns the responses. A section refers to what another owns in a clause, by name.",
  "- For each key fact, answer present, partial or absent, and quote the words that show it (empty when absent).",
  "- reason: one or two sentences saying why, naming what is wrong when the score is below 2. evidence: up to three short quotes from the section under review (empty when there is nothing to quote).",
  "- Be strict and consistent: the same text must get the same scores every time.",
].join("\n");

/** The JSON schema of the judge's answer for one section (OpenAI strict mode: every property required, no others). */
export function judgeAnswerSchema(section: SectionId, itemIds: readonly string[], factIds: readonly string[]): Record<string, unknown> {
  const id = (ids: readonly string[]) => (ids.length > 0 ? { type: "string", enum: [...ids] } : { type: "string" });
  return {
    type: "object",
    additionalProperties: false,
    required: ["section", "items", "keyFacts"],
    properties: {
      section: { type: "string", enum: [section] },
      items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "score", "reason", "evidence"],
          properties: { id: id(itemIds), score: { type: "integer", enum: [0, 1, 2] }, reason: { type: "string" }, evidence: { type: "array", items: { type: "string" } } },
        },
      },
      keyFacts: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "status", "quote"],
          properties: { id: id(factIds), status: { type: "string", enum: ["present", "partial", "absent"] }, quote: { type: "string" } },
        },
      },
    },
  };
}

/** The name the schema is sent under. */
export const JUDGE_SCHEMA_NAME = "rubric_scores";

/** The judge's own tags: text inside its prompt can open or close none of them, nor any tag of her requests. */
const JUDGE_TAGS = /<(\/?)(rubric|her-structure|payer-facts|case-key|key-facts|other-sections|section-under-review|previous-answer)\b/giu;
function quoteForJudge(text: string): string {
  return quoteForPrompt(text).replace(JUDGE_TAGS, (_whole, slash: string, name: string) => `‹${slash}${name}`);
}

/** What she gave for the case, as the drafts got it: her session notes and her standing instructions for this section. */
export interface JudgeHerInputs {
  notes: string | null;
  instructions: string | null;
}

/** The judge's prompt: its fixed instructions, the case's sources (cached across the judge requests of a case), then the task. */
export function buildJudgePrompt(input: JudgeInput, section: SectionId, sections: readonly JudgedSection[], sources: SourceDocument[], her: JudgeHerInputs = { notes: null, instructions: null }): PromptParts {
  const q = quoteForJudge;
  const title = SECTIONS[section].title;
  const under = sections.find((s) => s.id === section);
  const others = sections.filter((s) => s.id !== section);
  const parts: string[] = [`Rubric version ${input.rubricVersion}. Section under review: "${title}" (section ${SECTIONS[section].templateNumber} of the ABA Matrix template).`];
  parts.push(
    [
      "<rubric>",
      ...input.items.map((item) => `- ${item.id}: ${q(item.title)}\n  2: ${q(item.anchors["2"])}\n  1: ${q(item.anchors["1"])}\n  0: ${q(item.anchors["0"])}`),
      "</rubric>",
    ].join("\n"),
  );
  if (input.expectations.length > 0) parts.push(["<her-structure>", ...input.expectations.map((line) => `- ${q(line)}`), "</her-structure>"].join("\n"));
  if (input.payerFacts.length > 0) parts.push(["<payer-facts>", ...input.payerFacts.map((line) => `- ${q(line)}`), "</payer-facts>"].join("\n"));
  if (input.caseNotes.length > 0) parts.push(["<case-key>", ...input.caseNotes.map((line) => `- ${q(line)}`), "</case-key>"].join("\n"));
  parts.push(["<key-facts>", ...(input.keyFacts.length > 0 ? input.keyFacts.map((fact) => `- ${fact.id}: ${q(fact.fact)}`) : ["(none for this section)"]), "</key-facts>"].join("\n"));
  // What she gave the drafts besides the sources (review B2): her notes are a source of facts, her instructions are hers.
  const notes = her.notes?.trim();
  if (notes) parts.push(`<session-notes>\n${q(notes)}\n</session-notes>`);
  const instructions = her.instructions?.trim();
  if (instructions) parts.push(`<standing-instructions>\n${q(instructions)}\n</standing-instructions>`);
  if (others.length > 0) {
    parts.push(`<other-sections>\n${others.map((s) => `<section title="${SECTIONS[s.id].title}">\n${q(s.text)}\n</section>`).join("\n\n")}\n</other-sections>`);
  }
  parts.push(`<section-under-review title="${title}">\n${q(under?.text ?? "")}\n</section-under-review>`);
  const shape = `{"section": "${section}", "items": [{"id": "<rubric item id>", "score": 0 | 1 | 2, "reason": "...", "evidence": ["..."]}], "keyFacts": [{"id": "<key fact id>", "status": "present" | "partial" | "absent", "quote": "..."}]}`;
  parts.push(
    input.format === "json-schema"
      ? "Score every rubric item once and answer every key fact once, in the structured format."
      : `Score every rubric item once and answer every key fact once. Answer with one JSON object and nothing else (no code fence, no text before or after), in this shape:\n${shape}`,
  );
  if (input.repair) {
    parts.push(
      [
        "<previous-answer>",
        q(input.repair.previousAnswer),
        "</previous-answer>",
        "Your previous answer could not be used:",
        ...input.repair.problems.map((problem) => `- ${problem}`),
        "Answer again, complete and valid.",
      ].join("\n"),
    );
  }
  return { system: JUDGE_SYSTEM, sources, task: parts.join("\n\n") };
}

const AnswerSchema = z.strictObject({
  section: z.string(),
  items: z.array(z.strictObject({ id: z.string(), score: z.union([z.literal(0), z.literal(1), z.literal(2)]), reason: z.string(), evidence: z.array(z.string()) })),
  keyFacts: z.array(z.strictObject({ id: z.string(), status: z.enum(["present", "partial", "absent"]), quote: z.string() })),
});
export type JudgeAnswer = z.infer<typeof AnswerSchema>;

/** The JSON object in a plain-text answer: the whole text, or the text inside a code fence, or from the first { to the last }. */
function jsonText(answer: string): string {
  const trimmed = answer.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/u.exec(trimmed);
  if (fenced) return fenced[1];
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  return start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
}

/**
 * Reads the judge's answer: valid JSON in the shape above, for this section, every item
 * scored exactly once and every key fact answered exactly once. The problems, when there
 * are some, are what the repair request tells the judge.
 */
export function parseJudgeAnswer(answer: string, section: SectionId, itemIds: readonly string[], factIds: readonly string[]): { ok: true; answer: JudgeAnswer } | { ok: false; problems: string[] } {
  let value: unknown;
  try {
    value = JSON.parse(jsonText(answer));
  } catch {
    return { ok: false, problems: ["The answer is not valid JSON."] };
  }
  const parsed = AnswerSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, problems: parsed.error.issues.slice(0, 10).map((issue) => `${issue.path.join(".") || "(answer)"}: ${issue.message}`) };
  }
  const problems: string[] = [];
  if (parsed.data.section !== section) problems.push(`section must be "${section}".`);
  const once = (what: string, expected: readonly string[], got: readonly string[]) => {
    for (const id of expected) {
      const count = got.filter((g) => g === id).length;
      if (count === 0) problems.push(`${what} "${id}" is missing.`);
      if (count > 1) problems.push(`${what} "${id}" is answered ${count} times.`);
    }
    for (const id of got) if (!expected.includes(id)) problems.push(`${what} "${id}" is not one asked for.`);
  };
  once("Rubric item", itemIds, parsed.data.items.map((item) => item.id));
  once("Key fact", factIds, parsed.data.keyFacts.map((fact) => fact.id));
  return problems.length > 0 ? { ok: false, problems: [...new Set(problems)] } : { ok: true, answer: parsed.data };
}
