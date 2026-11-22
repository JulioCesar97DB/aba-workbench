import { runPromptGeneration } from "../lib/generate.ts";
import type { GenerationEvent } from "../lib/generation-events.ts";
import type { Effort, GenerateEvent, Provider, ProviderCredential } from "../lib/providers/types.ts";
import { isPreparedRequest, StreamRestorer, type PreparedRequest } from "./outgoing.ts";

/** What a finished generation hands over to be saved as a new version. */
export interface FinishedText {
  /** The whole text as it arrived, restored to the case's own words. */
  text: string;
  done: Extract<GenerateEvent, { type: "done" }>;
}

/** What the section workspace's generation reports: the provider's events, then whether the result was saved. */
export type SectionGenerationEvent<Saved> = GenerationEvent | { type: "saved"; result: Saved };

/**
 * One request of the section workspace, from a prepared request (src/main/outgoing.ts)
 * to a saved version. The text is restored as it streams in; once the model finishes on
 * its own, `save` turns the whole text into a version and its answer is the last event.
 * A refusal, a stop, an error or a text cut short is never saved.
 */
export async function* runSectionGeneration<Saved>(options: {
  prepared: PreparedRequest;
  provider: Provider;
  credential: ProviderCredential;
  model: string;
  effort: Effort;
  maxOutputTokens: number;
  section: string;
  signal: AbortSignal;
  save: (finished: FinishedText) => Promise<Saved>;
}): AsyncGenerator<SectionGenerationEvent<Saved>> {
  // The type system already asks for one; this also refuses anything built elsewhere.
  if (!isPreparedRequest(options.prepared)) throw new Error("A section request must be prepared by prepareOutgoingRequest.");
  const { prepared, signal } = options;
  const restorer = new StreamRestorer((text) => prepared.restore(text));
  let text = "";
  let refused = false;
  let done: Extract<GenerateEvent, { type: "done" }> | null = null;
  const events = runPromptGeneration({
    provider: options.provider,
    credential: options.credential,
    model: options.model,
    section: options.section,
    effort: options.effort,
    maxOutputTokens: options.maxOutputTokens,
    mode: "generate",
    prompt: prepared.prompt,
    rulesVersions: prepared.rulesVersions,
    signal,
  });
  for await (const event of events) {
    if (signal.aborted) return;
    if (event.type === "text") {
      const shown = restorer.push(event.delta);
      text += shown;
      if (shown) yield { type: "text", delta: shown };
      continue;
    }
    if (event.type === "refusal") refused = true;
    if (event.type === "done") {
      const rest = restorer.flush();
      text += rest;
      if (rest) yield { type: "text", delta: rest };
      done = event;
    }
    yield event;
  }
  if (signal.aborted || refused || !done?.complete || text.trim() === "") return;
  yield { type: "saved", result: await options.save({ text, done }) };
}
