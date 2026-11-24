import type { GenerationEvent } from "../lib/generation-events.ts";
import type { CaseMapSummary, CaseMapView, MapCollection, MapPartId, MapRequestKind } from "./case-map.ts";
import type { ReportSectionId } from "./report-sections.ts";
import type { SectionDetail, SectionRequestInput, SectionSummary } from "./sections.ts";
import type { AddPdfsResult, CaseSources, DroppedPdf, FailedSave, NewTextSource, ReadSourceTextResult, SourceChange, SourceSaveResult } from "./sources.ts";

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
 * interface explains, offering to choose another folder. "inside-app": the folder is in
 * the app's own install folder, which an update or uninstalling deletes whole (owner's
 * decision, 2026-11-23); it is never read or written.
 */
export type CasesFolderState = "ready" | "not-created-yet" | CasesFolderProblem;
export type CasesFolderProblem = "missing" | "not-a-folder" | "not-allowed" | "not-writable" | "inside-app";

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
  /**
   * The folder is inside the app's own install folder, which an update or uninstalling
   * deletes whole (owner's decision, 2026-11-23); the setting is unchanged.
   */
  | { outcome: "inside-app" }
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

/**
 * How far a case is, as Home shows it (owner's decisions T7 and P8: computed from the case's
 * data each time it is listed, nothing stored): its documents, its case map and its sections.
 */
export interface CaseProgress {
  /** Its documents, not counting removed ones. */
  sources: number;
  /** Its case map: parts with something in them, and how many of those are approved (src/shared/case-progress.ts). */
  caseMap: CaseMapSummary;
  /** The first part of the map, in the map's order, with something in it and not approved; null when none. */
  mapPartToApprove: MapPartId | null;
  /** Each section's state and whether it is copied for ABA Matrix (T8), in the report's order. */
  sections: Array<Pick<SectionSummary, "id" | "state" | "copied">>;
}

/** A case as Home lists it, with how far it is; null when that could not be read (the case is still listed). */
export interface ListedCase extends CaseSummary {
  progress: CaseProgress | null;
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
  /** Its sources (src/shared/sources.ts), and the PDFs in its folder again. */
  sources: CaseSources;
  /** Its report's sections, in the report's order (src/shared/sections.ts). */
  sections: SectionSummary[];
  /** Her notes for this session: the AI takes them into account in everything it drafts. */
  notes: string;
  /** Its case map (src/shared/case-map.ts): parts approved, out of parts with something in them. */
  caseMap: CaseMapSummary;
  /** How far it is when it was opened, as Home lists it; null when that could not be read. */
  progress: CaseProgress | null;
}

/* A case's map (src/shared/case-map.ts). */

/** Why a change to the case map could not be saved: as for a section, or the item is gone (another version is shown, say). */
export type MapSaveFailure = { outcome: "case-unavailable" } | { outcome: "not-saved" } | { outcome: "case-full" } | { outcome: "version-not-found" } | { outcome: "item-not-found" };

/**
 * A change to the case map, saved: the whole map as saved, its summary for the sidebar,
 * the version of the part the change wrote (her editing pass, which her next change
 * names), and the id of an item just added. version is null when nothing changed.
 */
export type MapSaveResult = { outcome: "saved"; map: CaseMapView; summary: CaseMapSummary; version: number | null; itemId: string | null } | MapSaveFailure;

/** The map, and her standing instructions for it (her thresholds, D16): empty until she confirms them. */
export type GetCaseMapResult = { outcome: "read"; map: CaseMapView; instructions: string } | { outcome: "case-unavailable" };

/* A case's report sections (src/shared/sections.ts). */

/** Why a change to a section could not be saved: the case is gone or unreadable, the disk refused, or the file would be too large. */
export type SectionSaveFailure =
  | { outcome: "case-unavailable" }
  | { outcome: "not-saved" }
  | { outcome: "case-full" }
  | { outcome: "version-not-found" }
  /** The AI's answer is longer than a section can be (MAX_SECTION_TEXT_LENGTH): nothing was saved. */
  | { outcome: "too-long" }
  /** A paragraph change answered with more than the paragraph (the whole section, say): nothing was saved. */
  | { outcome: "not-one-paragraph" };

/** A change to a section, saved: the section as saved, and every section's summary for the sidebar. */
export type SectionSaveResult = { outcome: "saved"; section: SectionDetail; sections: SectionSummary[] } | SectionSaveFailure;

export type GetSectionResult = { outcome: "read"; section: SectionDetail } | { outcome: "case-unavailable" };

export type NotesSaveResult = { outcome: "saved"; notes: string } | { outcome: "case-unavailable" } | { outcome: "not-saved" } | { outcome: "case-full" };

export type InstructionsSaveResult = { outcome: "saved" } | { outcome: "not-saved" };

/** The providers a section can be drafted with: the ones connected in Settings. */
export type DraftingProvider = "anthropic" | "openai";

export type StartSectionResult =
  | { outcome: "started" }
  /** That provider is not connected (or needs attention). */
  | { outcome: "not-connected" }
  /** The version the request names is not in the section. */
  | { outcome: "version-not-found" }
  | { outcome: "case-unavailable" }
  /** A generation is already running in this window. */
  | { outcome: "busy" };

/** The model used on each provider (chosen in Settings, or the default), and the provider she drafted with last. */
export interface AiPreferences {
  models: { anthropic: string; openai: string };
  lastProvider: DraftingProvider | null;
}

/**
 * A copy for ABA Matrix. `markers` counts the [MISSING]/[CHECK] markers in what was put on
 * the clipboard, and `allMissing` says whether every one is [MISSING] (the copied line's
 * words, P2). Once the clipboard holds it, the copy is marked in the case (owner's
 * decision T8): `marked` is the section and the sections as saved, or null when the mark
 * could not be saved (the clipboard holds the text all the same).
 */
export type CopySectionResult =
  | { outcome: "copied"; markers: number; allMissing: boolean; marked: { section: SectionDetail; sections: SectionSummary[] } | null }
  | { outcome: "version-not-found" }
  | { outcome: "case-unavailable" };

/** A section as Revisión y copia shows it: its summary and the text of the version she would copy (versionToCopy), null when none. */
export interface ReportSectionText {
  summary: SectionSummary;
  version: number | null;
  text: string | null;
}

/** Every section of the report, in ABA Matrix's order (Revisión y copia and "Leer todo"). */
export type ReadReportResult = { outcome: "read"; sections: ReportSectionText[] } | { outcome: "case-unavailable" };

/**
 * Why a folder inside the cases folder cannot be opened as a case:
 * - "not-a-case": it has no data file (aba-case.json).
 * - "damaged": its data file is not one this app can read (not JSON, a value missing or wrong).
 * - "newer-version": a newer version of the app wrote it; updating the app opens it.
 * - "duplicate": its data file has the same id as another case's (a copied folder).
 * - "cannot-read": the system did not let the app read it.
 * - "link": a symbolic link to a folder elsewhere, which the app never follows. (A Finder
 *   alias or a Windows shortcut is a file, not a folder: it is not listed at all.)
 * - "unfinished": a case the app was creating when it stopped (a crash, a power cut): it
 *   holds the temporary data file of that creation, and the app could not finish it.
 * The app never changes such a folder. The one thing it does in a case folder with no
 * data file is finish an interrupted creation: when the folder holds only the complete
 * temporary data file of a case, that file becomes its aba-case.json (src/main/cases.ts).
 */
export type UnreadableReason = "not-a-case" | "damaged" | "newer-version" | "duplicate" | "cannot-read" | "link" | "unfinished";

export interface UnreadableFolder {
  /** The folder's name inside the cases folder (not a path), to show and to reveal it. */
  folderName: string;
  reason: UnreadableReason;
}

export interface CaseList {
  folder: CasesFolderInfo;
  /** The case saved last first (updatedAt, then created, then folder name). Empty when the folder cannot be read. */
  cases: ListedCase[];
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

/**
 * What the main process reports about a generation, in order. A section's generation
 * that finished on its own ends with "saved" (the new version, or why it could not be
 * saved) before "finished". "finished" is always last.
 */
export type GenerationUpdateEvent =
  | GenerationEvent
  | { type: "saved"; result: SectionSaveResult }
  /** The consistency check that runs after each new AI version, saved with it. */
  | { type: "checked"; result: SectionSaveResult }
  /**
   * A case map draft at work (step 1, pull request 2): which of its two requests, what it is
   * doing (writing, asked again to fix its answer, asked again as plain JSON), and how much
   * of the answer has arrived.
   */
  | { type: "map-progress"; step: MapRequestKind; phase: "writing" | "repairing" | "plain-json"; characters: number }
  /** One request's parts saved: the whole map as saved, the parts written, and how many problems the checks still found. */
  | { type: "map-saved"; step: MapRequestKind; result: MapSaveResult; written: MapPartId[]; kept: MapPartId[]; problems: number }
  | { type: "finished"; cancelled: boolean };

export interface GenerationUpdate {
  generationId: string;
  event: GenerationUpdateEvent;
}


/* The AI connections (src/main/connections.ts). The interface only ever learns states, the
 * account's display name when the provider gives one, and safe messages: never a key, a
 * token or anything else from the credentials file. */

/** Why the credentials file could not be used. Both connections then show as not connected. */
export type CredentialsProblem = "damaged" | "newer-version" | "cannot-read";

export type ClaudeConnection =
  | { state: "not-connected" }
  | { state: "connected" }
  /** A key is saved, but Anthropic no longer accepts it (revoked or deleted in the Console). */
  | { state: "needs-attention"; reason: "key-rejected" };

export type ChatGptConnection =
  /**
   * `savedAccount`: a ChatGPT account signed in before and signed out; the next sign-in
   * goes back to it, and "Use a different ChatGPT account" forgets it.
   */
  | { state: "not-connected"; savedAccount: boolean }
  /**
   * The browser is open at OpenAI's sign-in page; the app waits for it to come back.
   * `otherPort`: another app held the usual port (1455), so the app listens on another one,
   * which OpenAI may refuse for a first sign-in.
   */
  | { state: "signing-in"; otherPort: boolean }
  /**
   * `showWelcome`: plan use was allowed for the first time on this computer and the user has
   * not dismissed "You're using your ChatGPT plan" yet (OpenAI's UI guidelines).
   */
  | { state: "connected"; displayName: string | null; showWelcome: boolean }
  /**
   * Signed in, but it cannot be used as it is:
   * - "plan-not-allowed": OpenAI gave no permission to use the ChatGPT plan (it was not
   *   allowed in the browser, or the account cannot use its plan in apps; OpenAI does not
   *   say which);
   * - "plan-not-eligible": OpenAI said the account's plan, workspace or a policy does not let
   *   it be used in apps (kept across restarts until the next sign-in or sign-out);
   * - "session-ended": revoked, disconnected in ChatGPT's settings, or unused for 30 days;
   *   it needs a new sign-in;
   * - "not-saved": it works, but its renewed sign-in could not be written to the disk, so
   *   it would be lost when the app quits.
   */
  | { state: "needs-attention"; reason: "plan-not-allowed" | "plan-not-eligible" | "session-ended" | "not-saved"; displayName: string | null };

export interface Connections {
  chatgpt: ChatGptConnection;
  claude: ClaudeConnection;
  /** Set when the credentials file could not be read: nothing in it is used, and nothing overwrites it. */
  problem: CredentialsProblem | null;
}

/** The longest text saveClaudeKey looks at; a real key is about a hundred characters. */
export const MAX_API_KEY_INPUT_LENGTH = 1000;

/** The outcome of pasting a Claude key: it is saved only when Anthropic accepted it. */
export type SaveClaudeKeyResult =
  | { outcome: "saved" }
  /** Empty, or not shaped like a Claude key (they start with sk-ant-); nothing was sent. */
  | { outcome: "not-a-key"; problem: "empty" | "not-a-claude-key" }
  /** Anthropic said this key is not valid. */
  | { outcome: "rejected" }
  /** Anthropic could not be reached (no internet, say); nothing was saved. */
  | { outcome: "unreachable" }
  /** Anthropic answered with another error; nothing was saved. */
  | { outcome: "provider-error" }
  /** Accepted, but the credentials file could not be written; nothing was saved. */
  | { outcome: "not-saved" }
  /** The credentials file could not be read; it is left as it is. */
  | { outcome: "credentials-problem"; problem: CredentialsProblem };

/** The outcome of checking a saved connection with a free call (the provider's model list). */
export type CheckConnectionResult =
  | { outcome: "working" }
  | { outcome: "not-connected" }
  /** The provider no longer accepts the key or the sign-in: the connection needs attention. */
  | { outcome: "rejected" }
  /** ChatGPT only: OpenAI said this account cannot use its plan in apps; the connection needs attention. */
  | { outcome: "not-eligible" }
  | { outcome: "unreachable" }
  | { outcome: "provider-error" };

export type RemoveConnectionResult = { outcome: "removed" } | { outcome: "not-saved" } | { outcome: "credentials-problem"; problem: CredentialsProblem };

/** How a ChatGPT sign-in ended. */
export type ChatGptSignInResult =
  /** Signed in with plan use allowed. */
  | { outcome: "signed-in" }
  /** Signed in, but OpenAI gave no permission to use the ChatGPT plan. */
  | { outcome: "plan-not-allowed" }
  /**
   * OpenAI ended the attempt with access_denied: it was not allowed in the browser, or the
   * account cannot use its plan in apps (OpenAI's answer does not say which); nothing was saved.
   */
  | { outcome: "access-denied" }
  /** Cancelled in the app. */
  | { outcome: "cancelled" }
  /** Nothing came back from the browser in time (closed, say). */
  | { outcome: "timed-out" }
  /** The app could not listen for the browser's answer: another app holds the port. */
  | { outcome: "port-in-use" }
  /** The browser signed in to another ChatGPT account than the one saved; nothing changed. */
  | { outcome: "different-account" }
  | { outcome: "unreachable" }
  /** OpenAI refused, or answered with something the app cannot verify; nothing was saved. */
  | { outcome: "failed" }
  | { outcome: "already-signing-in" }
  | { outcome: "not-saved" }
  | { outcome: "credentials-problem"; problem: CredentialsProblem };

/** The outcome of "Start over" when the credentials file could not be used. */
export type StartOverResult = { outcome: "started-over" } | { outcome: "not-needed" } | { outcome: "not-saved" };

export type ChatGptSignOutResult =
  /** Signed out here. `revocationConfirmed` false: OpenAI did not confirm it ended the session (offline, say). */
  | { outcome: "signed-out"; revocationConfirmed: boolean }
  | { outcome: "not-saved" }
  | { outcome: "credentials-problem"; problem: CredentialsProblem };

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

  /** The state of each AI connection. */
  getConnections(): Promise<Connections>;
  /** Called whenever a connection's state changes (a sign-in, a refresh that failed...); returns the function that unsubscribes. */
  onConnectionsChange(listener: (connections: Connections) => void): () => void;
  /** Checks the pasted Claude key with Anthropic (a free call: the model list) and saves it only if it is accepted. */
  saveClaudeKey(key: string): Promise<SaveClaudeKeyResult>;
  /** Checks the saved Claude key again. */
  checkClaudeKey(): Promise<CheckConnectionResult>;
  /** Removes the saved Claude key from this computer. */
  removeClaudeKey(): Promise<RemoveConnectionResult>;
  /** Opens OpenAI's sign-in page in the system browser and waits for it to come back. */
  signInToChatGpt(): Promise<ChatGptSignInResult>;
  /** Stops a sign-in that is waiting for the browser. */
  cancelChatGptSignIn(): Promise<void>;
  /** Checks the ChatGPT sign-in with a free call (the account's model list). */
  checkChatGpt(): Promise<CheckConnectionResult>;
  /** Ends the ChatGPT session with OpenAI and removes its tokens from this computer. */
  signOutOfChatGpt(): Promise<ChatGptSignOutResult>;
  /** Signed out: forgets the saved ChatGPT account, so the next sign-in can use another one. */
  forgetChatGptAccount(): Promise<RemoveConnectionResult>;
  /** Opens ChatGPT's usage settings (chatgpt.com/settings/usage) in the system browser. */
  openChatGptUsage(): Promise<void>;
  /** Remembers that "You're using your ChatGPT plan" was seen, so it is never shown again. */
  dismissChatGptWelcome(): Promise<void>;
  /**
   * When the credentials file could not be used: renames it aside (never deleting it)
   * and starts with no saved connections. The interface asks the user to confirm first.
   */
  startOverConnections(): Promise<StartOverResult>;
  /*
   * A case's sources (src/shared/sources.ts). Each change is saved at once and answers
   * with the case's sources as saved. Nothing is deleted: removing a source marks it.
   */
  /** Adds a pasted text. */
  addTextSource(caseId: string, input: NewTextSource): Promise<SourceSaveResult>;
  /** Changes a source's type, title, date or (a pasted text's) text. */
  changeSource(caseId: string, sourceId: string, change: SourceChange): Promise<SourceSaveResult>;
  /** Removes a source from the case (marked removed; its text and its PDF are kept). */
  removeSource(caseId: string, sourceId: string): Promise<SourceSaveResult>;
  /** Makes a removed source one of the case's sources again. */
  restoreSource(caseId: string, sourceId: string): Promise<SourceSaveResult>;
  /** A pasted text's whole text. */
  readSourceText(caseId: string, sourceId: string): Promise<ReadSourceTextResult>;
  /** Opens the system's file dialog; the PDFs chosen are copied into the case's folder and added. */
  choosePdfs(caseId: string): Promise<AddPdfsResult>;
  /** Copies a PDF dropped onto the window (its bytes, never a path) into the case's folder and adds it. */
  addDroppedPdf(caseId: string, pdf: DroppedPdf): Promise<AddPdfsResult>;
  /** Adds a PDF already in the case's folder (put there in Finder or Explorer) as a source. */
  addFolderPdf(caseId: string, fileName: string): Promise<AddPdfsResult>;
  /** Opens a PDF source's copy in the system's PDF viewer. False when it is not in the folder any more. */
  openSourcePdf(caseId: string, sourceId: string): Promise<boolean>;
  /**
   * Before the window closes or the app quits, the main process asks the interface to
   * save everything still waiting; `listener` answers once nothing is under way, `ok`
   * false when a change could not be saved (src/main/close-guard.ts). Returns the
   * function that stops listening.
   */
  onFlushSaves(listener: () => Promise<{ ok: boolean }>): () => void;
  /** The changes to sources that could not be saved, kept by the main process while the app runs (a reload does not forget them). */
  listFailedSaves(): Promise<FailedSave[]>;
  /** The interface put a kept text back in its box: that box's next save is built on it, so it may replace the kept one. */
  failedSaveShown(id: string): Promise<void>;
  /** Runs a change that could not be saved again (a source's, or what was typed in a section, its instructions or the notes). */
  retryFailedSave(id: string): Promise<SourceSaveResult | SectionSaveResult | NotesSaveResult | InstructionsSaveResult | MapSaveResult>;

  /*
   * A case's report sections (src/shared/sections.ts). Nothing is ever deleted: every
   * change by the AI or by her is a new version, and she can go back to any of them.
   */
  /** A section with all its versions and her standing instructions for it. */
  getSection(caseId: string, sectionId: ReportSectionId): Promise<GetSectionResult>;
  /**
   * Saves the text she writes herself (pasted from ABA Matrix, or an edit). `editing` is
   * the version this editing pass made and keeps updating; null starts a new version.
   * `pasted`: a box of "Pegar lo que ya escribiste", always saved as her own text ("hers"),
   * also over an AI draft (UX-6 review B1). Left out (false) for the section screen's saves.
   */
  saveSectionText(caseId: string, sectionId: ReportSectionId, text: string, editing: number | null, pasted?: boolean): Promise<SectionSaveResult>;
  /** Shows another version: nothing is lost, only which one is current changes. */
  setCurrentVersion(caseId: string, sectionId: ReportSectionId, version: number): Promise<SectionSaveResult>;
  /** Approves a version (null takes the approval back). */
  approveSection(caseId: string, sectionId: ReportSectionId, version: number | null): Promise<SectionSaveResult>;
  /**
   * Asks the AI for a draft, a change, a paragraph change or an improvement. The text
   * streams in as generation updates; the new version arrives in the "saved" update.
   */
  startSectionGeneration(caseId: string, sectionId: ReportSectionId, generationId: string, provider: DraftingProvider, request: SectionRequestInput): Promise<StartSectionResult>;
  /** Runs the consistency check again on one version (it failed, was stopped, or her sections changed since). Updates arrive like a request's; the result in "checked". */
  checkSection(caseId: string, sectionId: ReportSectionId, generationId: string, provider: DraftingProvider, version: number): Promise<StartSectionResult>;
  /**
   * Saves her standing instructions for a section, or for the case map ("case-map": her
   * definition thresholds, D16), for all her cases. `caseId` is the case she typed them in:
   * where a save that failed is shown again.
   */
  saveSectionInstructions(caseId: string, sectionId: ReportSectionId | "case-map", text: string): Promise<InstructionsSaveResult>;
  /** Saves her notes for this session, in the case. */
  saveSessionNotes(caseId: string, text: string): Promise<NotesSaveResult>;
  /** "Start a new session": archives the notes (kept in the case, never sent again) and empties the box. */
  startNewSession(caseId: string): Promise<NotesSaveResult>;
  /** The model used on each provider and the provider she drafted with last. */
  getAiPreferences(): Promise<AiPreferences>;
  /** Chooses the model for a provider among the ones offered (src/shared/models.ts). */
  setModel(provider: DraftingProvider, model: string): Promise<AiPreferences>;
  /** Puts a version on the clipboard the way ABA Matrix takes it; says how many markers are left. */
  copySection(caseId: string, sectionId: ReportSectionId, version: number): Promise<CopySectionResult>;
  /** Every section's summary and the text of the version she would copy, in ABA Matrix's order (Revisión y copia). Read only. */
  readReport(caseId: string): Promise<ReadReportResult>;
  /**
   * Development only, for pnpm eval (docs/evaluation.md): the evaluation's judge scores one
   * section against the rubric. The main process answers it only in a development build
   * started with --hidden; anywhere else the call is refused. `input` is a JudgeInput
   * (src/lib/judge.ts). The answer streams as generation updates ("text", then "done"); nothing is saved.
   */
  judgeSection(caseId: string, sectionId: ReportSectionId, generationId: string, provider: DraftingProvider, input: unknown): Promise<StartSectionResult>;

  /*
   * The case map (src/shared/case-map.ts). Nothing is ever deleted: each part keeps every
   * version, and she can go back to any of them. `editing` is the version of the part her
   * editing pass made and keeps updating (the last answer's `version`); null starts a new one.
   */
  /** The whole map, every part with its versions and the items of the version shown. */
  getCaseMap(caseId: string): Promise<GetCaseMapResult>;
  /** Saves her change to an item or a group as she types. `item` is the item's fields as JSON: values and [CHECK]s only. */
  saveMapItem(caseId: string, part: MapPartId, collection: MapCollection, itemId: string, item: string, editing: number | null): Promise<MapSaveResult>;
  /** Adds an item or a group (her own), with what she typed so far (JSON); the answer names its id. */
  addMapItem(caseId: string, part: MapPartId, collection: MapCollection, item: string, editing: number | null): Promise<MapSaveResult>;
  /** Removes an item or a group from the version she works in; earlier versions keep it. */
  removeMapItem(caseId: string, part: MapPartId, collection: MapCollection, itemId: string, editing: number | null): Promise<MapSaveResult>;
  /** Shows another version of a part: nothing is lost, only which one is current changes. */
  setMapPartVersion(caseId: string, part: MapPartId, version: number): Promise<MapSaveResult>;
  /** Approves a version of a part (null takes the approval back). */
  approveMapPart(caseId: string, part: MapPartId, version: number | null): Promise<MapSaveResult>;
  /**
   * "Draft the map" / "Update the map" (step 1, pull request 2): the AI's two requests, one
   * after the other. Progress arrives as "map-progress" updates, each request's saved parts
   * as "map-saved"; Stop is cancelGeneration.
   */
  startMapDraft(caseId: string, generationId: string, provider: DraftingProvider): Promise<StartSectionResult>;
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
  getConnections: "connections:get",
  connectionsChanged: "connections:changed",
  saveClaudeKey: "connections:claude-save",
  checkClaudeKey: "connections:claude-check",
  removeClaudeKey: "connections:claude-remove",
  signInToChatGpt: "connections:chatgpt-sign-in",
  cancelChatGptSignIn: "connections:chatgpt-cancel",
  checkChatGpt: "connections:chatgpt-check",
  signOutOfChatGpt: "connections:chatgpt-sign-out",
  forgetChatGptAccount: "connections:chatgpt-forget",
  openChatGptUsage: "connections:chatgpt-usage",
  dismissChatGptWelcome: "connections:chatgpt-welcome-seen",
  startOverConnections: "connections:start-over",
  addTextSource: "sources:add-text",
  changeSource: "sources:change",
  removeSource: "sources:remove",
  restoreSource: "sources:restore",
  readSourceText: "sources:read-text",
  choosePdfs: "sources:choose-pdfs",
  addDroppedPdf: "sources:add-dropped-pdf",
  addFolderPdf: "sources:add-folder-pdf",
  openSourcePdf: "sources:open-pdf",
  flushSaves: "saves:flush",
  savesFlushed: "saves:flushed",
  listFailedSaves: "saves:list-failed",
  retryFailedSave: "saves:retry-failed",
  failedSaveShown: "saves:failed-shown",
  getSection: "sections:get",
  saveSectionText: "sections:save-text",
  setCurrentVersion: "sections:set-current",
  approveSection: "sections:approve",
  startSectionGeneration: "sections:generate",
  checkSection: "sections:check",
  saveSectionInstructions: "sections:save-instructions",
  saveSessionNotes: "sections:save-notes",
  startNewSession: "sections:new-session",
  copySection: "sections:copy",
  readReport: "sections:read-report",
  judgeSection: "eval:judge-section",
  getCaseMap: "case-map:get",
  saveMapItem: "case-map:save-item",
  addMapItem: "case-map:add-item",
  removeMapItem: "case-map:remove-item",
  setMapPartVersion: "case-map:set-current",
  approveMapPart: "case-map:approve",
  startMapDraft: "case-map:draft",
  getAiPreferences: "settings:get-ai",
  setModel: "settings:set-model",
} as const;

/** Generation ids are UUIDs (crypto.randomUUID()); anything else is refused. */
export function isGenerationId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}
