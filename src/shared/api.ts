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
  | { state: "connected"; displayName: string | null }
  /**
   * Signed in, but it cannot be used: the user did not allow ABA Workbench to use their
   * ChatGPT plan ("plan-not-allowed"), or the session ended (revoked, disconnected in
   * ChatGPT's settings, or unused for 30 days: "session-ended") and needs a new sign-in.
   */
  | { state: "needs-attention"; reason: "plan-not-allowed" | "session-ended"; displayName: string | null };

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
  | { outcome: "unreachable" }
  | { outcome: "provider-error" };

export type RemoveConnectionResult = { outcome: "removed" } | { outcome: "not-saved" } | { outcome: "credentials-problem"; problem: CredentialsProblem };

/** How a ChatGPT sign-in ended. */
export type ChatGptSignInResult =
  /** Signed in with plan use allowed. `firstTime`: the first sign-in on this computer. */
  | { outcome: "signed-in"; firstTime: boolean }
  /** Signed in, but the user did not allow ABA Workbench to use their ChatGPT plan. */
  | { outcome: "plan-not-allowed" }
  /** The user declined in the browser; nothing was saved. */
  | { outcome: "declined" }
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
  /**
   * When the credentials file could not be used: renames it aside (never deleting it)
   * and starts with no saved connections. The interface asks the user to confirm first.
   */
  startOverConnections(): Promise<StartOverResult>;
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
  startOverConnections: "connections:start-over",
} as const;

/** Generation ids are UUIDs (crypto.randomUUID()); anything else is refused. */
export function isGenerationId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}
