import type { GenerateEvent, Provider, TokenUsage } from "./types";

/**
 * A fake provider for checking the plumbing (route, streaming, PDF transport, saving)
 * without an API key or any spend. Only available when ABA_ENABLE_MOCK_PROVIDER=1.
 */
function fakeUsage(chars: number, outputChars: number): TokenUsage {
  return {
    uncachedInputTokens: Math.round(chars / 4),
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    outputTokens: Math.round(outputChars / 4),
    reasoningTokens: 0,
  };
}

export const mockProvider: Provider = {
  id: "mock",

  async listModels() {
    return [{ id: "mock-echo", label: "Mock (no API call)", createdAt: null }];
  },

  async *generate(options): AsyncIterable<GenerateEvent> {
    const { prompt } = options;
    const pdfs = prompt.sources.filter((s) => s.kind === "pdf");
    const pdfBytes = pdfs.reduce((sum, s) => sum + Math.floor((s.kind === "pdf" ? s.base64.length : 0) * 0.75), 0);
    const inputChars =
      prompt.system.length + prompt.task.length + prompt.sources.reduce((n, s) => n + (s.kind === "text" ? s.text.length : 0), 0);

    yield { type: "status", phase: "thinking" };
    await new Promise((resolve) => setTimeout(resolve, 300));
    yield { type: "status", phase: "writing" };
    const text = [
      `MOCK OUTPUT for model ${options.model} at effort ${options.effort}. No AI call was made.`,
      `The route received ${prompt.sources.length} sources (${pdfs.length} PDF, ${pdfBytes} PDF bytes): ${prompt.sources.map((s) => s.id).join(", ")}.`,
      `Rules sent as the cached prefix: ${prompt.system.length} characters. Section request: ${prompt.task.length} characters.`,
    ].join("\n\n");
    for (const word of text.split(/(?<= )/)) {
      if (options.signal.aborted) return;
      yield { type: "text", delta: word };
    }
    yield { type: "done", stopReason: "end_turn", servedModel: options.model, usage: fakeUsage(inputChars, text.length), attempts: null };
  },

  async prewarm(options) {
    return fakeUsage(options.prompt.system.length, 0);
  },
};
