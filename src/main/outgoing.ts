import { readFile } from "node:fs/promises";
import path from "node:path";
import type { PromptParts, SourceDocument } from "../lib/providers/types.ts";
import { buildJudgePrompt, JUDGE_PROMPT_VERSION, type JudgedSection, type JudgeInput } from "../lib/judge.ts";
import { buildSectionPrompt, type ContextSection, type SectionId, type SectionRequest } from "../lib/rules.ts";
import { isSourceType, SOURCE_TYPE_NAMES } from "../shared/sources.ts";
import type { CaseData } from "./case-file.ts";

/*
 * Everything the app sends to an AI provider about a case is prepared here, and only
 * here: prepareOutgoingRequest is the one function that turns the case's content (its
 * sources, her sections, her instructions, her session notes, the text being corrected
 * and her request) into the text a provider receives, and its `restore` is applied to
 * everything that comes back. De-identification plugs in at this one place (owner's
 * decision, 2026-11-22: real client data never reaches a provider identifiable); until it
 * does, `deidentified` is false and the interface says the app is not ready for real
 * client data wherever it can generate.
 *
 * PDFs are sent as files for now. The owner decided PDFs are never sent to a provider as
 * files; this is acceptable only while the app shows it is not ready for real client
 * data, and the de-identification task replaces it with each PDF's text, extracted and
 * de-identified here.
 */

/** A source of the case as it is about to be sent: a pasted text, or a PDF read from the case's folder when needed. */
export type OutgoingSource =
  | { id: string; title: string; kind: "text"; text: string }
  | { id: string; title: string; kind: "pdf"; fileName: string; load: () => Promise<Uint8Array> };

export interface OutgoingInput {
  section: SectionId;
  request: SectionRequest;
  sources: OutgoingSource[];
  /** Her other sections that are hers or approved, in the report's order. */
  herSections: ContextSection[];
  instructions: string | null;
  notes: string | null;
  rulesDir: string;
}

const prepared = Symbol("prepared by prepareOutgoingRequest");

/** A request ready to send. Only prepareOutgoingRequest makes one (the section generation takes nothing else). */
export interface PreparedRequest {
  readonly [prepared]: true;
  readonly prompt: PromptParts;
  readonly rulesVersions: Record<string, string>;
  /** The sources sent, by id and title, recorded with the version they produce. */
  readonly sourcesUsed: ReadonlyArray<{ id: string; title: string }>;
  /** Whether the client's details were hidden before sending. False until de-identification is plugged in. */
  readonly deidentified: boolean;
  /** Turns what the provider wrote back into the case's own words (the placeholders restored). */
  restore(text: string): string;
}

export function isPreparedRequest(value: unknown): value is PreparedRequest {
  return typeof value === "object" && value !== null && (value as { [prepared]?: unknown })[prepared] === true;
}

/**
 * How a source is named to the model: its type as the clinician's forms name it, then
 * its title and date when it has them. Quotes become apostrophes, so a title can never
 * close the attribute it is written in.
 */
export function outgoingSourceTitle(source: { type: string; title?: string; date?: string; file?: string }): string {
  const type = isSourceType(source.type) && source.type !== "other" ? SOURCE_TYPE_NAMES[source.type] : "Other document";
  const named = source.title ?? source.file;
  const title = [type, named ? `: ${named}` : "", source.date ? ` (${source.date})` : ""].join("");
  return title.replace(/["<>]/g, (char) => (char === '"' ? "'" : char === "<" ? "‹" : "›"));
}

/** The case's sources that are not removed, ready to be prepared; a PDF is read from `folder` only when it is sent. */
export function outgoingSourcesOf(data: CaseData, folder: string): OutgoingSource[] {
  return data.sources
    .filter((source) => !source.removedAt)
    .map((source): OutgoingSource => {
      const title = outgoingSourceTitle(source.kind === "pdf" ? { ...source } : source);
      if (source.kind === "text") return { id: source.id, title, kind: "text", text: source.text };
      return { id: source.id, title, kind: "pdf", fileName: source.file, load: () => readFile(path.join(folder, source.file)) };
    });
}

/** The identity until de-identification is plugged in: nothing was replaced, so nothing is restored. */
const restoreNothing = (text: string) => text;

/** Reads the PDFs of a request's sources (only when it is sent) and makes them the provider's documents. */
async function loadSources(input: readonly OutgoingSource[]): Promise<SourceDocument[]> {
  const sources: SourceDocument[] = [];
  for (const source of input) {
    if (source.kind === "text") {
      sources.push({ id: source.id, title: source.title, kind: "text", text: source.text });
    } else {
      const bytes = await source.load();
      sources.push({ id: source.id, title: source.title, kind: "pdf", filename: source.fileName, base64: Buffer.from(bytes).toString("base64") });
    }
  }
  return sources;
}

/**
 * Development only: the evaluation's judge request for one section (src/lib/judge.ts). It
 * goes through the same preparation as her requests, so de-identification, when it plugs
 * in, covers it too: the case's sources and its drafted sections are the case's content.
 */
export async function prepareJudgeRequest(input: {
  section: SectionId;
  judge: JudgeInput;
  sections: readonly JudgedSection[];
  sources: OutgoingSource[];
  /** Her session notes and her standing instructions for the section, as the drafts got them (review B2). */
  notes: string | null;
  instructions: string | null;
}): Promise<PreparedRequest> {
  const sources = await loadSources(input.sources);
  return {
    [prepared]: true,
    prompt: buildJudgePrompt(input.judge, input.section, input.sections, sources, { notes: input.notes, instructions: input.instructions }),
    rulesVersions: { judge: JUDGE_PROMPT_VERSION, rubric: input.judge.rubricVersion },
    sourcesUsed: input.sources.map(({ id, title }) => ({ id, title })),
    deidentified: false,
    restore: restoreNothing,
  };
}

/**
 * The one way a request about a case is made ready to send. Today it builds the prompt
 * from the rules and the case's content as they are; de-identification goes in here, on
 * every piece of text (sources, her sections, instructions, notes, the current text and
 * her request), and its restore map becomes `restore`.
 */
export async function prepareOutgoingRequest(input: OutgoingInput): Promise<PreparedRequest> {
  const sources = await loadSources(input.sources);
  const { prompt, rulesVersions } = await buildSectionPrompt(
    { section: input.section, request: input.request, sources, herSections: input.herSections, instructions: input.instructions, notes: input.notes },
    input.rulesDir,
  );
  return {
    [prepared]: true,
    prompt,
    rulesVersions,
    sourcesUsed: input.sources.map(({ id, title }) => ({ id, title })),
    deidentified: false,
    restore: restoreNothing,
  };
}

/**
 * Restores streamed text as it arrives. A placeholder ("[CLIENT]") can be split across
 * two pieces of the stream, so text from an opening bracket that is not closed yet is held
 * back (up to `holdLimit` characters, longer than any placeholder) until it is.
 */
export class StreamRestorer {
  #pending = "";
  readonly #restore: (text: string) => string;
  readonly #holdLimit: number;

  constructor(restore: (text: string) => string, holdLimit = 80) {
    this.#restore = restore;
    this.#holdLimit = holdLimit;
  }

  /** The restored text that can be shown now. */
  push(delta: string): string {
    const text = this.#pending + delta;
    const open = text.lastIndexOf("[");
    const held = open !== -1 && !text.includes("]", open) && text.length - open <= this.#holdLimit ? open : text.length;
    this.#pending = text.slice(held);
    return held > 0 ? this.#restore(text.slice(0, held)) : "";
  }

  /** Whatever was held back, at the end of the stream. */
  flush(): string {
    const rest = this.#pending;
    this.#pending = "";
    return rest ? this.#restore(rest) : "";
  }
}
