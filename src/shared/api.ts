import type { GenerationEvent } from "../lib/generation-events.ts";

/*
 * The contract between the interface (renderer) and the main process. The preload
 * exposes exactly these functions as window.aba; the interface has no other way in.
 * Rules for growing it: one narrow function per action, plain data in and out, no
 * generic "invoke", and never a key, a token or a file path the user did not choose.
 */

export interface AppInfo {
  name: string;
  version: string;
  /**
   * True when the app runs from the repository (pnpm dev, pnpm preview, the built window
   * tests); false in a packaged app. The interface shows its development screens' links
   * only when it is true.
   */
  developmentBuild: boolean;
}

/** The languages the screens can be shown in. The assessment itself is always English. */
export const LANGUAGES = ["en", "es"] as const;
export type Language = (typeof LANGUAGES)[number];

export function isLanguage(value: unknown): value is Language {
  return typeof value === "string" && (LANGUAGES as readonly string[]).includes(value);
}

/** The user's settings, kept by the main process in its own data folder (src/main/settings.ts). */
export interface Settings {
  language: Language;
}

/** What the main process reports about a generation, in order. "finished" is always last. */
export type GenerationUpdateEvent = GenerationEvent | { type: "finished"; cancelled: boolean };

export interface GenerationUpdate {
  generationId: string;
  event: GenerationUpdateEvent;
}

export interface AbaApi {
  getAppInfo(): Promise<AppInfo>;
  /**
   * Development check: runs the mock provider (no AI call, no key, no cost) with the real
   * prompt builder and rules. The interface picks the id (see isGenerationId) so it can
   * match the updates that may arrive before this promise settles.
   */
  startMockGeneration(generationId: string): Promise<void>;
  /** Stops a running generation; unknown or finished ids are ignored. */
  cancelGeneration(generationId: string): Promise<void>;
  /** Subscribes to generation updates; returns the function that unsubscribes. */
  onGenerationUpdate(listener: (update: GenerationUpdate) => void): () => void;
  /** The saved settings, or the defaults on a first run or when the file could not be used. */
  getSettings(): Promise<Settings>;
  /** Saves the screen language and returns the settings as saved. Anything but "en" or "es" is refused. */
  setLanguage(language: Language): Promise<Settings>;
}

export const IPC_CHANNELS = {
  getAppInfo: "app:get-info",
  startMockGeneration: "generation:start-mock",
  cancelGeneration: "generation:cancel",
  generationUpdate: "generation:update",
  getSettings: "settings:get",
  setLanguage: "settings:set-language",
} as const;

/** Generation ids are UUIDs (crypto.randomUUID()); anything else is refused. */
export function isGenerationId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}
