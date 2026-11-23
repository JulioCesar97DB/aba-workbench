import { setTimeout as delay } from "node:timers/promises";
import { runGeneration, type GenerationEvent } from "../lib/generate.ts";
import { mockProvider } from "../lib/providers/mock.ts";
import type { SourceDocument } from "../lib/providers/types.ts";

/** An invented source: the development check never reads a case. */
const DEV_CHECK_SOURCES: SourceDocument[] = [
  {
    id: "dev-check",
    title: "Development check (invented)",
    kind: "text",
    text: "Invented text for the development check. It describes no real person.",
  },
];

/**
 * The placeholder screen's generation: the mock provider with the real prompt builder
 * and rules, so a run proves the window, the bridge, the main process and the rules
 * folder all work. No AI call, no key, no cost.
 */
export async function* runDevCheckGeneration(options: {
  rulesDir: string;
  signal: AbortSignal;
  /** The mock answers at once; a pause between words lets you watch the text stream in. */
  msPerTextDelta?: number;
}): AsyncGenerator<GenerationEvent> {
  const pause = options.msPerTextDelta ?? 40;
  const events = runGeneration({
    provider: mockProvider,
    credential: { kind: "api-key", apiKey: "" }, // the mock needs none
    model: "mock-echo",
    section: "medical-necessity",
    effort: "high",
    maxOutputTokens: 32_000,
    mode: "generate",
    sources: DEV_CHECK_SOURCES,
    signal: options.signal,
    rulesDir: options.rulesDir,
  });
  for await (const event of events) {
    if (event.type === "text" && pause > 0) {
      try {
        await delay(pause, undefined, { signal: options.signal });
      } catch {
        return; // cancelled
      }
    }
    yield event;
  }
}
