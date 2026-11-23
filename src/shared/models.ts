/*
 * The models the section workspace offers on each provider, most capable first. The
 * first is the default (owner's decision, 2026-11-22: the most capable); Settings lets
 * her choose the other to halve the cost. Providers do not rank capability in their
 * model lists, so the ranking is ours (src/lib/providers/index.ts uses it too).
 */
export const MODEL_CHOICES = {
  anthropic: [
    { id: "claude-fable-5-2", label: "Claude Fable 5.2" },
    { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
  ],
  openai: [
    { id: "gpt-6.2-astra", label: "GPT-6.2 Astra" },
    { id: "gpt-6.2-sol", label: "GPT-6.2 Sol" },
  ],
} as const;

export type ModelProvider = keyof typeof MODEL_CHOICES;

export function isModelChoice(provider: ModelProvider, model: unknown): model is string {
  return typeof model === "string" && MODEL_CHOICES[provider].some((choice) => choice.id === model);
}

export function defaultModel(provider: ModelProvider): string {
  return MODEL_CHOICES[provider][0].id;
}

/** A model's name as the screens show it; the id itself for one not offered here (a fallback model, say). */
export function modelLabel(model: string): string {
  for (const choices of Object.values(MODEL_CHOICES)) {
    const found = choices.find((choice) => choice.id === model);
    if (found) return found.label;
  }
  return model;
}
