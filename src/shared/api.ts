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
  /** Which system's words to use ("Show in Finder", "Show in Explorer"). */
  platform: "mac" | "windows" | "linux";
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

/**
 * Whether the cases folder can be used (src/main/cases-folder.ts): "ready"; the default
 * folder not made yet ("not-created-yet", made with the first case); or a problem the
 * interface explains, offering to choose another folder.
 */
export type CasesFolderState = "ready" | "not-created-yet" | CasesFolderProblem;
export type CasesFolderProblem = "missing" | "not-a-folder" | "not-allowed" | "not-writable";

export interface CasesFolderInfo {
  /**
   * The folder's full path, to show the user where their cases are (owner's decision,
   * 2026-11-22). Display text only: no function of window.aba accepts a path.
   */
  displayPath: string;
  /** ABA Workbench in the home folder, not a folder chosen in Settings. */
  isDefault: boolean;
  state: CasesFolderState;
}

/** The outcome of choosing the cases folder in the system's dialog. */
export type ChooseCasesFolderResult =
  | { outcome: "chosen"; folder: CasesFolderInfo }
  | { outcome: "cancelled" }
  /** The folder chosen cannot be used; the setting is unchanged. */
  | { outcome: "unusable"; problem: CasesFolderProblem }
  /** The folder is usable but the settings file could not be saved; the setting is unchanged. */
  | { outcome: "not-saved" };

/* Cases. Each case is a folder inside the cases folder, holding its data file
 * (aba-case.json, src/main/case-file.ts) and its PDFs. The interface names a case by its
 * id, never by its folder or a path. */

/** A case's id: a version 4 UUID, written in lowercase in its data file. */
export function isCaseId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

/** The client's age, as reports give it: "4 years 2 months". */
export interface ClientAge {
  years: number;
  /** 0 to 11; left out when the user gave only years. */
  months?: number;
}
export const MAX_CLIENT_AGE_YEARS = 120;

export const MAX_CASE_LABEL_LENGTH = 100;
export type CaseLabelProblem = "empty" | "too-long" | "control-characters";

/**
 * The label the user typed, as it is saved: Unicode NFC, without spaces at either end.
 * 1 to 100 characters (code points), and no control or text-direction characters, which
 * could hide or reorder what the label shows.
 */
export function checkCaseLabel(raw: string): { ok: true; label: string } | { ok: false; problem: CaseLabelProblem } {
  const label = raw.normalize("NFC").trim();
  if (label === "") return { ok: false, problem: "empty" };
  if (/[\p{Cc}\u{200E}\u{200F}\u{202A}-\u{202E}\u{2066}-\u{2069}]/u.test(label)) return { ok: false, problem: "control-characters" };
  if ([...label].length > MAX_CASE_LABEL_LENGTH) return { ok: false, problem: "too-long" };
  return { ok: true, label };
}

export interface NewCaseInput {
  label: string;
  clientAge?: ClientAge | null;
}

/** A case as Home lists it. Times are ISO 8601, in UTC. */
export interface CaseSummary {
  id: string;
  label: string;
  clientAge: ClientAge | null;
  createdAt: string;
  updatedAt: string;
  /** How many PDFs the case's folder held when it was last opened. */
  pdfCount: number;
}

/** A PDF in the case's folder: its name only, never a path. */
export interface CaseFile {
  name: string;
  bytes: number;
  modifiedAt: string;
}

/** An opened case. */
export interface CaseDetail extends CaseSummary {
  files: CaseFile[];
}

/**
 * Why a folder inside the cases folder cannot be opened as a case:
 * - "not-a-case": it has no data file (aba-case.json).
 * - "damaged": its data file is not one this app can read (not JSON, a value missing or wrong).
 * - "newer-version": a newer version of the app wrote it; updating the app opens it.
 * - "duplicate": its data file has the same id as another case's (a copied folder).
 * - "cannot-read": the system did not let the app read it.
 * - "link": a symbolic link to a folder elsewhere, which the app never follows. (A Finder
 *   alias or a Windows shortcut is a file, not a folder: it is not listed at all.)
 * The app never changes such a folder.
 */
export type UnreadableReason = "not-a-case" | "damaged" | "newer-version" | "duplicate" | "cannot-read" | "link";

export interface UnreadableFolder {
  /** The folder's name inside the cases folder (not a path), to show and to reveal it. */
  folderName: string;
  reason: UnreadableReason;
}

export interface CaseList {
  folder: CasesFolderInfo;
  /** Newest first. Empty when the folder cannot be read. */
  cases: CaseSummary[];
  /** By folder name. */
  unreadable: UnreadableFolder[];
}

export type CreateCaseResult =
  | { outcome: "created"; case: CaseSummary }
  | { outcome: "folder-problem"; problem: CasesFolderProblem }
  /** The folder or the data file could not be written; nothing was left behind. */
  | { outcome: "not-saved" };

export type OpenCaseResult =
  | { outcome: "opened"; case: CaseDetail }
  | { outcome: "not-found" }
  | { outcome: "unreadable"; reason: UnreadableReason }
  | { outcome: "folder-problem"; problem: CasesFolderProblem };

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
  /** Where the cases are kept, and whether that folder can be used now. */
  getCasesFolder(): Promise<CasesFolderInfo>;
  /** Opens the system's folder dialog; a usable folder chosen there becomes the cases folder and is remembered. */
  chooseCasesFolder(): Promise<ChooseCasesFolderResult>;
  /** Opens the cases folder in Finder or Explorer. False when it cannot be opened (missing, say). */
  showCasesFolder(): Promise<boolean>;
  /** The cases in the cases folder, and the folders in it that cannot be opened. */
  listCases(): Promise<CaseList>;
  /** Makes the case's folder and data file. A label the checks refuse (checkCaseLabel) is refused. */
  createCase(input: NewCaseInput): Promise<CreateCaseResult>;
  /** Reads a case, and saves its list of PDFs if the folder's PDFs changed. */
  openCase(caseId: string): Promise<OpenCaseResult>;
  /** Shows a folder Home last listed as unreadable in Finder or Explorer, selected. False for any other name, or when it is gone. */
  showUnreadableFolder(folderName: string): Promise<boolean>;
}

export const IPC_CHANNELS = {
  getAppInfo: "app:get-info",
  startMockGeneration: "generation:start-mock",
  cancelGeneration: "generation:cancel",
  generationUpdate: "generation:update",
  getSettings: "settings:get",
  setLanguage: "settings:set-language",
  getCasesFolder: "cases-folder:get",
  chooseCasesFolder: "cases-folder:choose",
  showCasesFolder: "cases-folder:show",
  listCases: "cases:list",
  createCase: "cases:create",
  openCase: "cases:open",
  showUnreadableFolder: "cases:show-unreadable",
} as const;

/** Generation ids are UUIDs (crypto.randomUUID()); anything else is refused. */
export function isGenerationId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}
