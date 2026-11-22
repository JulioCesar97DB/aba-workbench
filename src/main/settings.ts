import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { LANGUAGES, isLanguage, type Language, type Settings } from "../shared/api.ts";

/*
 * The user's settings, in one JSON file in the app's own data folder
 * (app.getPath("userData"): ~/Library/Application Support/ABA Workbench on macOS,
 * %APPDATA%\ABA Workbench on Windows, ~/.config/ABA Workbench on Linux). Only the main process reads or writes it; the
 * interface asks through window.aba. Nothing here imports Electron, so it is unit-tested.
 *
 * Reading never fails: a missing file means a first run, and a file that is not JSON, or
 * holds values this version does not know, falls back to the defaults field by field, so
 * one bad value does not cost the others. The next save writes a clean file.
 */

export const SETTINGS_FILE_NAME = "settings.json";
/** Written into the file. Raise it, and add a step to readStoredSettings, when the shape changes. */
export const SETTINGS_FILE_VERSION = 1;

/** What a settings file may hold. Unknown keys are dropped; a bad value becomes "missing". */
const StoredSettingsSchema = z
  .object({
    language: z.enum(LANGUAGES).optional().catch(undefined),
  })
  .catch({});

export type SettingsProblem = "unreadable" | "invalid";

export interface ReadResult {
  settings: Settings;
  /** Why some or all of the file was ignored, for the main-process log; null when it was used whole. */
  problem: SettingsProblem | null;
}

/**
 * Turns the file's text (null when there is no file) into settings, filling in the
 * defaults for anything missing or not understood.
 */
export function readStoredSettings(text: string | null, defaults: Settings): ReadResult {
  if (text === null) return { settings: defaults, problem: null };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { settings: defaults, problem: "unreadable" };
  }
  const stored = StoredSettingsSchema.parse(json);
  const settings: Settings = { language: stored.language ?? defaults.language };
  const usedWhole =
    typeof json === "object" &&
    json !== null &&
    !Array.isArray(json) &&
    (json as Record<string, unknown>).version === SETTINGS_FILE_VERSION &&
    stored.language !== undefined;
  return { settings, problem: usedWhole ? null : "invalid" };
}

export function serializeSettings(settings: Settings): string {
  return `${JSON.stringify({ version: SETTINGS_FILE_VERSION, language: settings.language }, null, 2)}\n`;
}

/**
 * The first-run language: the first of the system's preferred languages that the app
 * has (Spanish for "es-US", "es-419", "es"...), English otherwise.
 */
export function defaultLanguage(preferredSystemLanguages: readonly string[]): Language {
  for (const tag of preferredSystemLanguages) {
    const base = tag.toLowerCase().split(/[-_]/)[0];
    if (isLanguage(base)) return base;
  }
  return "en";
}

export class SettingsStore {
  private current: Settings | null = null;
  /** Saves run one after another, so the last one asked for is the one on disk. */
  private queue: Promise<unknown> = Promise.resolve();

  private readonly file: string;
  private readonly defaults: () => Settings;
  private readonly log: (message: string) => void;

  constructor(file: string, defaults: () => Settings, log: (message: string) => void = (message) => console.warn(message)) {
    this.file = file;
    this.defaults = defaults;
    this.log = log;
  }

  async get(): Promise<Settings> {
    if (this.current) return this.current;
    let text: string | null = null;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.log(`The settings file could not be read (${(error as Error).message}); using the defaults.`);
    }
    const { settings, problem } = readStoredSettings(text, this.defaults());
    if (problem === "unreadable") this.log("The settings file is not valid JSON; using the defaults. The next change rewrites it.");
    if (problem === "invalid") this.log("Parts of the settings file were missing or not understood; the defaults fill them in. The next change rewrites it.");
    this.current ??= settings;
    return this.current;
  }

  async setLanguage(language: unknown): Promise<Settings> {
    if (!isLanguage(language)) throw new Error("Refused: unknown language.");
    const save = this.queue.then(async () => {
      const next: Settings = { ...(await this.get()), language };
      await this.write(next);
      this.current = next;
      return next;
    });
    this.queue = save.catch(() => undefined);
    return save;
  }

  /**
   * Writes a temporary file next to the real one, flushes it to the disk, then renames it
   * over the real one: a crash or a power cut mid-save leaves the old file or the new one,
   * never half of either. A failed save removes the temporary file.
   */
  private async write(settings: Settings): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    try {
      const handle = await open(temporary, "w");
      try {
        await handle.writeFile(serializeSettings(settings), "utf8");
        await handle.datasync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.file);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
