import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { LANGUAGES, isLanguage, type Language } from "../shared/api.ts";
import { removeLeftoverAppDataTemporaryFiles, writeFileDurably } from "./durable-write.ts";

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

/**
 * Everything the settings file holds. The interface sees only the language (Settings in
 * src/shared/api.ts); the cases folder's path stays in the main process.
 */
export interface StoredSettings {
  language: Language;
  /** The cases folder the user chose in Settings, or null for the default (ABA Workbench in the home folder). */
  casesFolder: string | null;
}

/** Long enough for any real folder, short enough that a hostile file cannot make it a burden. */
export const MAX_FOLDER_PATH_LENGTH = 4096;

/** An absolute path with no NUL character: anything else in the file is ignored. */
const FolderPathSchema = z
  .string()
  .max(MAX_FOLDER_PATH_LENGTH)
  .refine((value) => !value.includes("\0") && (path.isAbsolute(value) || path.win32.isAbsolute(value)));

/** What a settings file may hold. Unknown keys are dropped; a bad value becomes "missing". */
const StoredSettingsSchema = z
  .object({
    language: z.enum(LANGUAGES).optional().catch(undefined),
    casesFolder: FolderPathSchema.optional().catch(undefined),
  })
  .catch({});

export type SettingsProblem = "unreadable" | "invalid";

export interface ReadResult {
  settings: StoredSettings;
  /** Why some or all of the file was ignored, for the main-process log; null when it was used whole. */
  problem: SettingsProblem | null;
}

/**
 * Turns the file's text (null when there is no file) into settings, filling in the
 * defaults for anything missing or not understood.
 */
export function readStoredSettings(text: string | null, defaults: StoredSettings): ReadResult {
  if (text === null) return { settings: defaults, problem: null };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { settings: defaults, problem: "unreadable" };
  }
  const stored = StoredSettingsSchema.parse(json);
  const settings: StoredSettings = { language: stored.language ?? defaults.language, casesFolder: stored.casesFolder ?? defaults.casesFolder };
  const record = typeof json === "object" && json !== null && !Array.isArray(json) ? (json as Record<string, unknown>) : null;
  const usedWhole =
    record !== null &&
    record.version === SETTINGS_FILE_VERSION &&
    stored.language !== undefined &&
    // A cases folder in the file that could not be used (not an absolute path, say).
    (record.casesFolder === undefined || stored.casesFolder !== undefined);
  return { settings, problem: usedWhole ? null : "invalid" };
}

/** The default cases folder is not written: only a folder the user chose is. */
export function serializeSettings(settings: StoredSettings): string {
  const body = settings.casesFolder === null ? {} : { casesFolder: settings.casesFolder };
  return `${JSON.stringify({ version: SETTINGS_FILE_VERSION, language: settings.language, ...body }, null, 2)}\n`;
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
  private current: StoredSettings | null = null;
  /** Saves run one after another, so the last one asked for is the one on disk. */
  private queue: Promise<unknown> = Promise.resolve();

  private readonly file: string;
  private readonly defaults: () => StoredSettings;
  private readonly log: (message: string) => void;

  constructor(file: string, defaults: () => StoredSettings, log: (message: string) => void = (message) => console.warn(message)) {
    this.file = file;
    this.defaults = defaults;
    this.log = log;
  }

  /** The settings as saved (or the defaults): a failed save leaves them as they were. */
  async get(): Promise<StoredSettings> {
    if (this.current) return this.current;
    // A save cut short by a crash in an earlier run left its temporary file behind.
    await removeLeftoverAppDataTemporaryFiles(this.file);
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

  async setLanguage(language: unknown): Promise<StoredSettings> {
    if (!isLanguage(language)) throw new Error("Refused: unknown language.");
    return this.update({ language });
  }

  /**
   * Remembers the cases folder. Only the main process calls it, with a folder the user
   * chose in the system's dialog and that was checked (src/main/cases-folder.ts).
   */
  async setCasesFolder(folder: string): Promise<StoredSettings> {
    if (!FolderPathSchema.safeParse(folder).success) throw new Error("Refused: not an absolute folder path.");
    return this.update({ casesFolder: folder });
  }

  private update(change: Partial<StoredSettings>): Promise<StoredSettings> {
    const save = this.queue.then(async () => {
      const next: StoredSettings = { ...(await this.get()), ...change };
      await this.write(next);
      this.current = next;
      return next;
    });
    this.queue = save.catch(() => undefined);
    return save;
  }

  /**
   * Durable (src/main/durable-write.ts): a crash or a power cut mid-save leaves the old
   * file or the new one, never half of either. The app's data folder is Electron's own,
   * so creating it is expected.
   */
  private async write(settings: StoredSettings): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFileDurably(this.file, serializeSettings(settings));
  }
}
