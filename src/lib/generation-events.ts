import type { Effort, GenerateEvent, ProviderId } from "./providers/types.ts";

/**
 * What one generation reports, in order: a meta event, then the provider's events
 * (status, text, fallback, refusal, done), or an error. Plain data that can cross a
 * process boundary as it is. Kept free of Node imports so the interface can use the type.
 */
export type GenerationEvent =
  | {
      type: "meta";
      provider: ProviderId;
      model: string;
      section: string;
      effort: Effort;
      mode: "generate" | "prewarm";
      /** The id and version of every rules file in the prompt. */
      rulesVersions: Record<string, string>;
    }
  | GenerateEvent
  /** The generation failed. The message is safe to show: never a key, a path or a request body. */
  | { type: "error"; code: string; message: string; status: number | null };
