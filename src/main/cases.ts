import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rmdir, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  checkCaseLabel,
  isCaseId,
  type CaseDetail,
  type CaseFile,
  type CaseList,
  type CaseProgress,
  type CasesFolderInfo,
  type CaseSummary,
  type ListedCase,
  type CreateCaseResult,
  type OpenCaseResult,
  type UnreadableFolder,
  type UnreadableReason,
} from "../shared/api.ts";
import { guessPdfType, MAX_SOURCES, type AddPdfsResult, type CaseSources, type PdfProblem, type ReadSourceTextResult, type SourceSaveResult } from "../shared/sources.ts";
import { CASE_FILE_NAME, ClientAgeSchema, MAX_CASE_FILE_BYTES, MAX_LISTED_FILES, newCaseData, nextUpdatedAt, readableCaseFileText, readCaseFile, type CaseData } from "./case-file.ts";
import { checkDroppedPdf, copyPdfIntoFolder, findSamePdf, isPdfFile, readChosenPdf, type LoadedPdf } from "./case-pdfs.ts";
import {
  addPdfSource,
  addTextSource,
  caseSources,
  changeSource,
  DroppedPdfSchema,
  FolderPdfNameSchema,
  NewTextSourceSchema,
  setRemoved,
  SourceChangeSchema,
  SourceIdSchema,
  SourceInputError,
  sourceText,
} from "./case-sources.ts";
import { caseFolderNames } from "./case-folder-name.ts";
import { SectionInputError, sectionSummaries, sessionNotes } from "./case-sections.ts";
import { mapProgress } from "../shared/case-progress.ts";
import { caseMapSummary, caseMapView, planSummaryOf } from "./case-map.ts";
import { inspectCasesFolder } from "./cases-folder.ts";
import { finishInterruptedSave, isLeftBehind, isTemporaryFileOf, writeFileDurably } from "./durable-write.ts";

/*
 * The cases in the cases folder: listing, creating, opening and saving them. Only the
 * main process runs this; the interface reaches it through window.aba and names a case
 * by its id. Nothing here imports Electron, so it is unit-tested.
 *
 * Every input from the interface is checked here, whatever the interface already checked:
 * an id must be a case id, a new case's input must match NewCaseInputSchema, a folder name
 * must be a plain name inside the cases folder. Anything else is refused with a message
 * that starts with "Refused:" and carries nothing from the disk.
 */

/** A new case, as the interface sends it. Strings are capped before anything else looks at them. */
export const NewCaseInputSchema = z.strictObject({
  label: z.string().max(1000),
  clientAge: ClientAgeSchema.nullable().optional(),
});

/** A folder name inside the cases folder: one plain name, never a path. */
const FolderNameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((name) => name !== "." && name !== ".." && !/[/\\\p{Cc}]/u.test(name));

export interface CasesFolderLocation {
  folder: string;
  isDefault: boolean;
}

export interface CaseLibraryOptions {
  /** Where the cases are now (the settings can change it at any time). */
  location: () => Promise<CasesFolderLocation>;
  now?: () => Date;
  newId?: () => string;
  log?: (message: string) => void;
  platform?: NodeJS.Platform;
  /**
   * Whether a folder is inside the app's own install folder (the packaged app's check,
   * isInsideOnDisk). Such a cases folder, even one saved in the settings before, is
   * reported as "inside-app" and never listed, read or written.
   */
  insideApp?: (folder: string) => Promise<boolean>;
  /** How a data file is saved; tests replace it to make a save fail. */
  writeFile?: (file: string, text: string) => Promise<void>;
}

type FolderRead = { kind: "case"; data: CaseData } | { kind: "unreadable"; reason: UnreadableReason };

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

export function caseSummary(data: CaseData): CaseSummary {
  return {
    id: data.id,
    label: data.label,
    // Only the two values the interface knows; a key a later version added stays in the file.
    clientAge: data.clientAge ? { years: data.clientAge.years, ...(data.clientAge.months === undefined ? {} : { months: data.clientAge.months }) } : null,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    pdfCount: data.files.length,
  };
}

/**
 * How far a case is, for Home and the case summary (owner's decisions T7, P8): read from its
 * data as it is now, through the sections' and the case map's own read functions, each map
 * part's view built once (review round 1, M6); nothing is stored. The map's counts are its
 * parts with something in them, approved or not (mapProgress).
 */
export function caseProgress(data: CaseData): CaseProgress {
  return {
    sources: data.sources.filter((source) => !source.removedAt).length,
    ...mapProgress(caseMapView(data).parts),
    sections: sectionSummaries(data).map(({ id, state, copied }) => ({ id, state, copied })),
    plan: planSummaryOf(data),
  };
}

/**
 * A case as Home lists it. Its progress is read with code that a file a later version wrote
 * could surprise: if it throws, the case is still listed, without its progress, and the
 * others are not affected (review round 1, M6).
 */
export function listedCase(data: CaseData, log: (message: string) => void, progressOf: (data: CaseData) => CaseProgress = caseProgress): ListedCase {
  let progress: CaseProgress | null;
  try {
    progress = progressOf(data);
  } catch (error) {
    log(`A case's progress could not be read (${(error as Error).message}).`);
    progress = null;
  }
  return { ...caseSummary(data), progress };
}

/** Reads one folder of the cases folder as a case. Never throws, never writes. */
export async function readCaseFolder(folder: string): Promise<FolderRead> {
  const file = path.join(folder, CASE_FILE_NAME);
  try {
    const info = await lstat(file);
    // A folder or a link where the data file should be is not something the app wrote.
    if (!info.isFile() || info.size > MAX_CASE_FILE_BYTES) return { kind: "unreadable", reason: "damaged" };
    // The bytes, not a string: decoding with replacement characters would hide a file
    // that is not UTF-8 and the next save would lose what it held (readCaseFile).
    const result = readCaseFile(await readFile(file));
    return result.ok ? { kind: "case", data: result.data } : { kind: "unreadable", reason: result.problem };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { kind: "unreadable", reason: "not-a-case" };
    return { kind: "unreadable", reason: "cannot-read" };
  }
}

/** The PDFs at the top of a case's folder, by name. Links and hidden files are left out. */
export async function scanCaseFiles(folder: string): Promise<CaseFile[]> {
  const entries = await readdir(folder, { withFileTypes: true });
  const files: CaseFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith(".") || !/\.pdf$/i.test(entry.name)) continue;
    try {
      const info = await stat(path.join(folder, entry.name));
      files.push({ name: entry.name, bytes: info.size, modifiedAt: info.mtime.toISOString() });
    } catch {
      // Gone between the listing and the look: it is not there.
    }
  }
  files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return files.slice(0, MAX_LISTED_FILES);
}

/*
 * A case the app was creating when it stopped (a crash or a power cut) leaves a folder
 * with no aba-case.json, only the temporary file the save was writing. The app never
 * deletes a case folder or anything in it (owner's decision, 2026-11-22): it finishes
 * the creation if it can, or shows the folder as unfinished and changes nothing.
 */

type Unfinished = { kind: "none" } | { kind: "unfinished"; recoverable: { temporary: string; data: CaseData } | null };

/**
 * What a case folder with no data file holds of one being created. "none": no temporary
 * data file at all (an ordinary "not-a-case" folder). "unfinished": at least one plain file
 * named "aba-case.json.<digits>.tmp"; it is recoverable only when the folder holds that one
 * file and nothing else (a plain file, checked with lstat so a link is never followed), it
 * is not still being written (isLeftBehind: not one this process is writing, untouched for
 * a minute), and it reads as a complete case under the same strict reading as
 * aba-case.json. Reads only; never writes.
 */
export async function inspectUnfinishedCase(folder: string): Promise<Unfinished> {
  let names: string[];
  try {
    names = await readdir(folder);
  } catch {
    return { kind: "none" };
  }
  const plainFile = async (name: string) =>
    lstat(path.join(folder, name)).then(
      (info) => info.isFile(),
      () => false,
    );
  const temporaries: string[] = [];
  for (const name of names) if (isTemporaryFileOf(CASE_FILE_NAME, name) && (await plainFile(name))) temporaries.push(name);
  if (temporaries.length === 0) return { kind: "none" };
  // Exactly one file, and it is the temporary data file: two would mean two saves were
  // attempted, and which one the user wants (a partial one may be the newer change)
  // cannot be told, so the app does not choose.
  if (names.length !== 1 || temporaries.length !== 1) return { kind: "unfinished", recoverable: null };
  const complete: Array<{ temporary: string; data: CaseData }> = [];
  for (const name of temporaries) {
    if (!(await isLeftBehind(folder, name))) return { kind: "unfinished", recoverable: null };
    const file = path.join(folder, name);
    try {
      if ((await lstat(file)).size > MAX_CASE_FILE_BYTES) continue;
      const read = readCaseFile(await readFile(file));
      if (read.ok) complete.push({ temporary: file, data: read.data });
    } catch {
      // Unreadable: not one to recover.
    }
  }
  return { kind: "unfinished", recoverable: complete.length === 1 ? complete[0] : null };
}

function sameFiles(a: readonly CaseFile[], b: readonly CaseFile[]): boolean {
  return a.length === b.length && a.every((file, i) => file.name === b[i].name && file.bytes === b[i].bytes && file.modifiedAt === b[i].modifiedAt);
}

/**
 * The case saved last first (owner's decision on UX-5 review round 1, S1, as mockup 01): by
 * updatedAt, then by created time (as times, not text), then by folder name, the same on every
 * system. Home's "Sigue donde lo dejaste" is the first one. Opening a case does not move it:
 * it is rewritten only when the PDFs in its folder changed.
 */
function lastSavedFirst(a: { data: CaseData; name: string }, b: { data: CaseData; name: string }): number {
  const saved = Date.parse(b.data.updatedAt) - Date.parse(a.data.updatedAt);
  if (saved !== 0) return saved;
  const created = Date.parse(b.data.createdAt) - Date.parse(a.data.createdAt);
  if (created !== 0) return created;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** What withCase found: the case could not be used, nothing was saved (with work's answer), it was saved, or saving failed. */
type CaseWork<T> =
  | { kind: "unavailable" }
  | { kind: "unchanged"; value: T; sources: CaseSources; data: CaseData }
  | { kind: "saved"; sources: CaseSources; data: CaseData; value: T }
  | { kind: "failed"; outcome: "not-saved" | "case-full"; sources: CaseSources };

function checkCaseId(caseId: unknown): string {
  if (!isCaseId(caseId)) throw new Error("Refused: not a case id.");
  return caseId;
}

function checkSourceId(sourceId: unknown): string {
  if (!SourceIdSchema.safeParse(sourceId).success) throw new Error("Refused: not a source id.");
  return sourceId as string;
}

/** Adding PDFs: what was added and what was not, with the case's sources as they are now. */
function pdfsOutcome(result: CaseWork<null>, added: string[], problems: Array<{ name: string; problem: PdfProblem }>, copied: string[] = []): AddPdfsResult {
  switch (result.kind) {
    case "saved":
    case "unchanged":
      return { outcome: "done", sources: result.sources, added: result.kind === "saved" ? added : [], problems };
    case "failed":
      // A copy stays in the folder (nothing is deleted): say where it is.
      return copied.length > 0 ? { outcome: "copied-not-added", files: copied, sources: result.sources } : { outcome: result.outcome };
    default:
      return { outcome: "case-unavailable" };
  }
}

export class CaseLibrary {
  /** Each case's folder, by id, as last listed, and the cases folder that listing read. */
  private folders = new Map<string, string>();
  private listedFolder: string | null = null;
  /** The folders the last listing showed as unreadable: the only ones that can be revealed. */
  private unreadableNames = new Set<string>();
  /** Saves of one case run one after another. */
  private queues = new Map<string, Promise<unknown>>();
  /** Changes to one case's sources, by case id, in the order they were asked for (withCase). */
  private caseCalls = new Map<string, Promise<unknown>>();
  /** Case work under way or waiting: saves, changes to sources, PDFs being copied. */
  private active = 0;
  /** Each case's label, as last read: what a change that could not be saved is shown under. */
  private labels = new Map<string, string>();

  /** A case's label as last read, or null. */
  labelOf(caseId: string): string | null {
    return this.labels.get(caseId) ?? null;
  }

  /** Whether case work is under way: quitting waits for it (src/main/index.ts). */
  get busy(): boolean {
    return this.active > 0;
  }

  /** Resolves true once no case work is under way, or false after `timeoutMs`. */
  async idle(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.active > 0) {
      const left = deadline - Date.now();
      if (left <= 0) return false;
      await Promise.race([Promise.allSettled([...this.caseCalls.values(), ...this.queues.values()]), new Promise((resolve) => setTimeout(resolve, Math.min(left, 50)))]);
    }
    return true;
  }
  private readonly options: Required<CaseLibraryOptions>;

  constructor(options: CaseLibraryOptions) {
    this.options = {
      now: () => new Date(),
      newId: () => randomUUID(),
      log: (message) => console.warn(message),
      platform: process.platform,
      insideApp: async () => false,
      writeFile: writeFileDurably,
      ...options,
    };
  }

  /**
   * Where the cases are and whether that folder can be used. `probeWrite` makes Windows'
   * write check (one file made and removed): only creating a case asks for it, so listing
   * and opening never touch the folder (each probe can raise a Windows Security notice
   * under Controlled folder access, or a sync in OneDrive).
   */
  async folderInfo({ probeWrite = false } = {}): Promise<CasesFolderInfo & { folder: string }> {
    const { folder, isDefault } = await this.options.location();
    let state: CasesFolderInfo["state"];
    try {
      state = (await this.options.insideApp(folder)) ? "inside-app" : await inspectCasesFolder(folder, isDefault, this.options.platform, { probeWrite });
    } catch (error) {
      this.options.log(`The cases folder could not be checked (${(error as Error).message}).`);
      state = "not-allowed";
    }
    return { folder, displayPath: folder, isDefault, state };
  }

  async list(): Promise<CaseList> {
    const { folder, ...info } = await this.folderInfo();
    const empty = { folder: info, cases: [], unreadable: [] };
    if (info.state !== "ready" && info.state !== "not-writable") return empty;
    let entries;
    try {
      entries = await readdir(folder, { withFileTypes: true });
    } catch (error) {
      this.options.log(`The cases folder could not be listed (${(error as Error).message}).`);
      return { ...empty, folder: { ...info, state: "not-allowed" } };
    }
    const visible = entries.filter((entry) => !entry.name.startsWith("."));
    const names = visible
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    // A link to a folder is never followed (it could lead out of the cases folder), but it
    // is shown, so nothing in the cases folder is silently missing from Home.
    const links: string[] = [];
    for (const entry of visible) {
      if (!entry.isSymbolicLink()) continue;
      const target = await stat(path.join(folder, entry.name)).catch(() => null);
      if (target?.isDirectory()) links.push(entry.name);
    }
    const reads = await Promise.all(names.map(async (name) => ({ name, read: await readCaseFolder(path.join(folder, name)) })));

    const folders = new Map<string, string>();
    const cases: Array<{ data: CaseData; name: string }> = [];
    const unreadable: UnreadableFolder[] = links.map((name) => ({ folderName: name, reason: "link" }));
    // Cases the app was creating when it stopped: finished (their complete temporary file
    // becomes aba-case.json) after every readable case is known, so a recovered one never
    // takes the id of a case that is already there; otherwise shown as unfinished.
    const unfinished: Array<{ name: string; state: Extract<Unfinished, { kind: "unfinished" }> }> = [];
    for (const { name, read } of reads) {
      if (read.kind === "unreadable" && read.reason === "not-a-case") {
        const state = await inspectUnfinishedCase(path.join(folder, name));
        if (state.kind === "unfinished") {
          unfinished.push({ name, state });
          continue;
        }
      }
      if (read.kind === "unreadable") unreadable.push({ folderName: name, reason: read.reason });
      else if (folders.has(read.data.id)) unreadable.push({ folderName: name, reason: "duplicate" });
      else {
        folders.set(read.data.id, path.join(folder, name));
        this.labels.set(read.data.id, read.data.label);
        cases.push({ data: read.data, name });
      }
    }
    for (const { name, state } of unfinished) {
      const caseFolder = path.join(folder, name);
      const recoverable = state.recoverable;
      if (recoverable && !folders.has(recoverable.data.id) && (await finishInterruptedSave(recoverable.temporary, path.join(caseFolder, CASE_FILE_NAME)))) {
        // Read back as any case is, so what is listed is what is now on disk.
        const read = await readCaseFolder(caseFolder);
        if (read.kind === "case" && read.data.id === recoverable.data.id) {
          this.options.log("A case whose creation was interrupted was finished.");
          folders.set(read.data.id, caseFolder);
          cases.push({ data: read.data, name });
          continue;
        }
      }
      unreadable.push({ folderName: name, reason: "unfinished" });
    }
    unreadable.sort((a, b) => (a.folderName < b.folderName ? -1 : a.folderName > b.folderName ? 1 : 0));
    this.folders = folders;
    this.listedFolder = folder;
    this.unreadableNames = new Set(unreadable.map((entry) => entry.folderName));
    cases.sort(lastSavedFirst);
    return { folder: info, cases: cases.map(({ data }) => listedCase(data, this.options.log)), unreadable };
  }

  async create(input: unknown): Promise<CreateCaseResult> {
    const parsed = NewCaseInputSchema.safeParse(input);
    if (!parsed.success) throw new Error("Refused: a new case needs a label and, optionally, an age in years and months.");
    const label = checkCaseLabel(parsed.data.label);
    if (!label.ok) throw new Error(`Refused: the label is ${label.problem}.`);

    const { folder, state } = await this.folderInfo({ probeWrite: true });
    if (state === "not-created-yet") {
      // The default folder, in the home folder, on the first case. One level: the home folder must be there.
      try {
        await mkdir(folder);
      } catch (error) {
        if (errorCode(error) !== "EEXIST") {
          this.options.log(`The cases folder could not be made (${(error as Error).message}).`);
          return { outcome: "folder-problem", problem: "not-writable" };
        }
      }
    } else if (state !== "ready") {
      return { outcome: "folder-problem", problem: state };
    }

    let caseFolder: string | null = null;
    try {
      const taken = await readdir(folder);
      let attempts = 0;
      for (const name of caseFolderNames(label.label, taken)) {
        try {
          // Exclusive: fails if anything has that name, so nothing is ever overwritten.
          await mkdir(path.join(folder, name));
          caseFolder = path.join(folder, name);
          break;
        } catch (error) {
          if (errorCode(error) !== "EEXIST" || ++attempts > 1000) throw error;
        }
      }
    } catch (error) {
      this.options.log(`The case's folder could not be made (${(error as Error).message}).`);
      return { outcome: "not-saved" };
    }
    if (!caseFolder) return { outcome: "not-saved" };

    const data = newCaseData({ id: this.options.newId(), label: label.label, clientAge: parsed.data.clientAge ?? null, now: this.options.now() });
    try {
      const text = readableCaseFileText(data);
      if (text === null) throw new Error("the new case would not read back whole");
      await this.options.writeFile(path.join(caseFolder, CASE_FILE_NAME), text);
    } catch (error) {
      this.options.log(`The case's data file could not be written (${(error as Error).message}).`);
      // The folder is new and empty: remove it, so no half-made case is left. rmdir never removes a folder with files in it.
      await rmdir(caseFolder).catch(() => undefined);
      return { outcome: "not-saved" };
    }
    if (this.listedFolder !== folder) {
      // The cases folder changed since the last listing: what it remembered is about another folder.
      this.folders = new Map();
      this.unreadableNames = new Set();
      this.listedFolder = folder;
    }
    this.folders.set(data.id, caseFolder);
    this.labels.set(data.id, data.label);
    return { outcome: "created", case: caseSummary(data) };
  }

  /**
   * The folder of a case in the current cases folder, listing it again when the last
   * listing was of another cases folder (the user chose a new one) or does not know the
   * id. Null when no case there has that id.
   */
  private async caseFolder(caseId: string, casesFolder: string, { relist = false } = {}): Promise<string | null> {
    if (relist || this.listedFolder !== casesFolder || !this.folders.has(caseId)) await this.list();
    const folder = this.folders.get(caseId);
    // Never a folder outside the cases folder in use now.
    return folder && this.listedFolder === casesFolder && path.dirname(folder) === casesFolder ? folder : null;
  }

  async open(caseId: unknown): Promise<OpenCaseResult> {
    if (!isCaseId(caseId)) throw new Error("Refused: not a case id.");
    const { folder: casesFolder, state } = await this.folderInfo();
    // The default folder not made yet holds no cases.
    if (state === "not-created-yet") return { outcome: "not-found" };
    if (state !== "ready" && state !== "not-writable") return { outcome: "folder-problem", problem: state };
    let result = await this.openIn(caseId, casesFolder, false);
    // Gone from where it was (renamed or moved in Finder or Explorer while the app was
    // open): list again, once, to find it under its new name.
    if (result === "moved") result = await this.openIn(caseId, casesFolder, true);
    return result === "moved" ? { outcome: "not-found" } : result;
  }

  private async openIn(caseId: string, casesFolder: string, relist: boolean): Promise<OpenCaseResult | "moved"> {
    const folder = await this.caseFolder(caseId, casesFolder, { relist });
    if (!folder) return { outcome: "not-found" };
    const result = await this.queued(folder, async (): Promise<OpenCaseResult | "moved"> => {
      const read = await readCaseFolder(folder);
      // The folder is gone, or now holds another case.
      if (read.kind === "unreadable" && read.reason === "not-a-case") return "moved";
      if (read.kind === "unreadable") return { outcome: "unreadable", reason: read.reason };
      if (read.data.id !== caseId) return "moved";
      // A temporary file a save cut short left next to the data file is never removed: it
      // may hold the user's latest change. It stays, untouched, for the user to see.
      let data = read.data;
      let files: CaseFile[];
      try {
        files = await scanCaseFiles(folder);
      } catch {
        files = data.files;
      }
      if (!sameFiles(files, data.files)) {
        const byName = new Map(data.files.map((file) => [file.name, file]));
        // Keys a later version added to an entry are kept for the files still there.
        data = { ...data, files: files.map((file) => ({ ...byName.get(file.name), ...file })) };
        data = await this.write(folder, data);
      }
      const detail: CaseDetail = {
        ...caseSummary(data),
        files: data.files.map(({ name, bytes, modifiedAt }) => ({ name, bytes, modifiedAt })),
        sources: caseSources(data, files),
        sections: sectionSummaries(data),
        notes: sessionNotes(data),
        caseMap: caseMapSummary(data),
        plan: planSummaryOf(data),
        // The same progress as Home's, so the summary names the map part to approve at once (review round 1, M1).
        progress: listedCase(data, this.options.log).progress,
      };
      return { outcome: "opened", case: detail };
    });
    return result;
  }

  /**
   * Changes a case and saves it durably, with a new updatedAt. For later phases (sources,
   * behaviors, drafts); `change` gets the case as on disk now. Null if it cannot be read.
   */
  async update(caseId: string, change: (data: CaseData) => CaseData): Promise<CaseData | null> {
    if (!isCaseId(caseId)) throw new Error("Refused: not a case id.");
    const { folder: casesFolder } = await this.options.location();
    for (const relist of [false, true]) {
      const folder = await this.caseFolder(caseId, casesFolder, { relist });
      if (!folder) return null;
      const saved = await this.queued(folder, async (): Promise<CaseData | null | "moved"> => {
        const read = await readCaseFolder(folder);
        if (read.kind === "unreadable" && read.reason === "not-a-case") return "moved";
        // Damaged, newer or unreadable: never written to.
        if (read.kind === "unreadable") return null;
        if (read.data.id !== caseId) return "moved";
        return this.write(folder, change(read.data), { strict: true });
      });
      if (saved !== "moved") return saved;
    }
    return null;
  }

  /*
   * Sources (src/main/case-sources.ts). Each change runs in the case's save queue: the
   * data file is read as on disk, changed, and written durably, so two quick changes
   * never lose one another. The PDFs in the folder are looked at again each time, so the
   * answer always says which are there.
   */

  async addTextSource(caseId: unknown, input: unknown): Promise<SourceSaveResult> {
    const id = checkCaseId(caseId);
    const parsed = NewTextSourceSchema.safeParse(input);
    if (!parsed.success) throw new Error("Refused: a pasted text needs a known type, a text, and optionally a title and a date.");
    const sourceId = this.options.newId();
    return this.saveSource(id, sourceId, (data, now) => addTextSource(data, parsed.data, { id: sourceId, now }));
  }

  async changeSource(caseId: unknown, sourceId: unknown, change: unknown): Promise<SourceSaveResult> {
    const id = checkCaseId(caseId);
    const source = checkSourceId(sourceId);
    const parsed = SourceChangeSchema.safeParse(change);
    if (!parsed.success) throw new Error("Refused: a change gives a known type, a title, a date or a text.");
    return this.saveSource(id, source, (data, now) => changeSource(data, source, parsed.data, now));
  }

  /** Removes a source from the case (`removed`), or restores it: only a mark, nothing is deleted. */
  async setSourceRemoved(caseId: unknown, sourceId: unknown, removed: boolean): Promise<SourceSaveResult> {
    const id = checkCaseId(caseId);
    const source = checkSourceId(sourceId);
    return this.saveSource(id, source, (data, now) => setRemoved(data, source, removed, now));
  }

  async readSourceText(caseId: unknown, sourceId: unknown): Promise<ReadSourceTextResult> {
    const id = checkCaseId(caseId);
    const source = checkSourceId(sourceId);
    const result = await this.withCase(id, async (data) => ({ save: null, value: sourceText(data, source) }));
    if (result.kind !== "unchanged") return { outcome: "case-unavailable" };
    return result.value === null ? { outcome: "source-not-found" } : { outcome: "read", text: result.value };
  }

  /**
   * Copies PDFs into the case's folder and adds each as a source, in one save. Each
   * PDF's bytes are loaded only once the case's queue reaches them. A PDF whose exact
   * bytes are already in the folder is not copied again: it becomes a source if no source
   * uses that file, and is reported as already added (or removed) otherwise.
   */
  async addPdfs(caseId: unknown, pdfs: ReadonlyArray<{ name: string; load: () => Promise<LoadedPdf> }>): Promise<AddPdfsResult> {
    const id = checkCaseId(caseId);
    const added: string[] = [];
    const copied: string[] = [];
    const problems: Array<{ name: string; problem: PdfProblem }> = [];
    const result = await this.withCase(id, async (data, folder, files) => {
      let next = data;
      const now = this.nextTime(data);
      let known = files;
      for (const pdf of pdfs) {
        const loaded = await pdf.load();
        if (!loaded.ok) {
          problems.push({ name: pdf.name, problem: loaded.problem });
          continue;
        }
        if (next.sources.length >= MAX_SOURCES) {
          problems.push({ name: pdf.name, problem: "too-many-sources" });
          continue;
        }
        const same = await findSamePdf(folder, loaded.bytes, known);
        const user = same === null ? undefined : next.sources.find((source) => source.kind === "pdf" && source.file === same);
        if (user) {
          problems.push({ name: pdf.name, problem: user.removedAt ? "already-removed" : "already-added" });
          continue;
        }
        let fileName = same;
        if (fileName === null) {
          try {
            fileName = await copyPdfIntoFolder(folder, pdf.name, loaded.bytes);
            copied.push(fileName);
          } catch (error) {
            this.options.log(`A PDF could not be copied into a case (${(error as Error).message}).`);
            problems.push({ name: pdf.name, problem: "not-copied" });
            continue;
          }
          known = [...known, { name: fileName, bytes: loaded.bytes.byteLength, modifiedAt: now }];
        }
        const sourceId = this.options.newId();
        next = addPdfSource(next, { id: sourceId, file: fileName, bytes: loaded.bytes.byteLength, type: guessPdfType(pdf.name), now });
        added.push(sourceId);
      }
      return { save: added.length > 0 ? next : null, value: null };
    });
    return pdfsOutcome(result, added, problems, copied);
  }

  /** PDFs the user chose in the system's dialog: read, never changed. */
  async addChosenPdfs(caseId: unknown, files: readonly string[]): Promise<AddPdfsResult> {
    return this.addPdfs(
      caseId,
      files.map((file) => ({ name: path.basename(file), load: () => readChosenPdf(file) })),
    );
  }

  /** A PDF dropped onto the window: its name and bytes, checked here again. */
  async addDroppedPdf(caseId: unknown, pdf: unknown): Promise<AddPdfsResult> {
    const parsed = DroppedPdfSchema.safeParse(pdf);
    if (!parsed.success) throw new Error("Refused: a dropped PDF is a name and at most 200 MB of bytes.");
    const { name, data } = parsed.data;
    return this.addPdfs(caseId, [{ name, load: async () => checkDroppedPdf(data) }]);
  }

  /** A PDF already at the top of the case's folder (put there in Finder or Explorer), added as a source as it is. */
  async addFolderPdf(caseId: unknown, fileName: unknown): Promise<AddPdfsResult> {
    const id = checkCaseId(caseId);
    const parsed = FolderPdfNameSchema.safeParse(fileName);
    if (!parsed.success) throw new Error("Refused: not a file name.");
    const name = parsed.data;
    const added: string[] = [];
    const problems: Array<{ name: string; problem: PdfProblem }> = [];
    const result = await this.withCase(id, async (data, folder, files) => {
      const refuse = (problem: PdfProblem) => {
        problems.push({ name, problem });
        return { save: null, value: null };
      };
      const entry = files.find((file) => file.name === name);
      if (!entry) return refuse("cannot-read");
      const user = data.sources.find((source) => source.kind === "pdf" && source.file === name);
      if (user) return refuse(user.removedAt ? "already-removed" : "already-added");
      if (data.sources.length >= MAX_SOURCES) return refuse("too-many-sources");
      // Read only to check it is a PDF; the file stays exactly as it is.
      const loaded = await readChosenPdf(path.join(folder, name));
      if (!loaded.ok) return refuse(loaded.problem);
      const sourceId = this.options.newId();
      added.push(sourceId);
      return { save: addPdfSource(data, { id: sourceId, file: name, bytes: loaded.bytes.byteLength, type: guessPdfType(name), now: this.nextTime(data) }), value: null };
    });
    return pdfsOutcome(result, added, problems);
  }

  /**
   * The path of a PDF source's copy, to open it in the system's viewer: only a plain
   * file at the top of the case's folder, named ".pdf", whose first bytes are a PDF's.
   * A data file copied or received from elsewhere could name any file ("report.command"),
   * which the system would run rather than show; such a file is never handed over.
   */
  async sourcePdfPath(caseId: unknown, sourceId: unknown): Promise<string | null> {
    const id = checkCaseId(caseId);
    const source = checkSourceId(sourceId);
    const result = await this.withCase(id, async (data, folder) => {
      const entry = data.sources.find((item) => item.id === source);
      if (entry?.kind !== "pdf" || !/\.pdf$/i.test(entry.file)) return { save: null, value: null };
      const file = path.join(folder, entry.file);
      if (path.dirname(file) !== folder) return { save: null, value: null };
      return { save: null, value: (await isPdfFile(file)) ? file : null };
    });
    return result.kind === "unchanged" ? result.value : null;
  }

  /** The time a change records: now, or a millisecond after the case's last save if the clock says otherwise. */
  private nextTime(data: CaseData): string {
    return nextUpdatedAt(data.updatedAt, this.options.now());
  }

  /** One change to one source, saved, answered with the case's sources as saved. */
  private async saveSource(caseId: string, sourceId: string, change: (data: CaseData, now: string) => CaseData | null): Promise<SourceSaveResult> {
    const result = await this.withCase(caseId, async (data) => {
      const next = change(data, this.nextTime(data));
      return { save: next, value: next === null ? ("source-not-found" as const) : null };
    });
    switch (result.kind) {
      case "saved":
        return { outcome: "saved", sources: result.sources, sourceId };
      case "unchanged":
        return { outcome: "source-not-found" };
      case "failed":
        return { outcome: result.outcome };
      default:
        return { outcome: "case-unavailable" };
    }
  }

  /**
   * Runs `work` on a case as it is on disk now, in its save queue, with its folder and
   * the PDFs in it. When `work` gives data to save, it is written durably with a new
   * updatedAt and the PDFs found in the folder (refused, never cut short, when the file
   * would be larger than MAX_CASE_FILE_BYTES). A case that is gone, damaged, from a newer
   * version, or in a cases folder that cannot be used, is never written to. An input
   * `work` refuses (SourceInputError) is thrown as a refusal.
   */
  private withCase<T>(caseId: string, work: (data: CaseData, folder: string, files: CaseFile[]) => Promise<{ save: CaseData | null; value: T }>): Promise<CaseWork<T>> {
    // In line before anything is awaited, so changes run in the order they were asked for:
    // two quick saves of a text never land older-last.
    this.active++;
    const run = (this.caseCalls.get(caseId) ?? Promise.resolve()).then(() => this.withCaseNow(caseId, work)).finally(() => this.active--);
    this.caseCalls.set(
      caseId,
      run.catch(() => undefined),
    );
    return run;
  }

  private async withCaseNow<T>(caseId: string, work: (data: CaseData, folder: string, files: CaseFile[]) => Promise<{ save: CaseData | null; value: T }>): Promise<CaseWork<T>> {
    const { folder: casesFolder, state } = await this.folderInfo();
    if (state !== "ready" && state !== "not-writable") return { kind: "unavailable" };
    for (const relist of [false, true]) {
      const folder = await this.caseFolder(caseId, casesFolder, { relist });
      if (!folder) return { kind: "unavailable" };
      const outcome = await this.queued(folder, async (): Promise<CaseWork<T> | "moved"> => {
        const read = await readCaseFolder(folder);
        if (read.kind === "unreadable" && read.reason === "not-a-case") return "moved";
        if (read.kind === "unreadable") return { kind: "unavailable" };
        if (read.data.id !== caseId) return "moved";
        this.labels.set(caseId, read.data.label);
        const scan = async (fallback: CaseFile[]) => scanCaseFiles(folder).catch(() => fallback);
        const before = await scan(read.data.files);
        let done: { save: CaseData | null; value: T };
        try {
          done = await work(read.data, folder, before);
        } catch (error) {
          if (error instanceof SourceInputError || error instanceof SectionInputError) throw new Error(error.message, { cause: error });
          throw error;
        }
        if (done.save === null) return { kind: "unchanged", value: done.value, sources: caseSources(read.data, before), data: read.data };
        // A PDF the work copied in is in the folder now.
        const files = await scan(before);
        const byName = new Map(done.save.files.map((file) => [file.name, file]));
        const next: CaseData = {
          ...done.save,
          files: files.map((file) => ({ ...byName.get(file.name), ...file })),
          updatedAt: nextUpdatedAt(read.data.updatedAt, this.options.now()),
        };
        const text = readableCaseFileText(next);
        if (text === null) {
          // Never write what would make the case unreadable (review B1): refuse the save, keep the file as it is.
          this.options.log("A case was not saved: the change would not read back whole.");
          return { kind: "failed", outcome: "not-saved", sources: caseSources(read.data, files) };
        }
        if (Buffer.byteLength(text, "utf8") > MAX_CASE_FILE_BYTES) return { kind: "failed", outcome: "case-full", sources: caseSources(read.data, files) };
        try {
          await this.options.writeFile(path.join(folder, CASE_FILE_NAME), text);
        } catch (error) {
          this.options.log(`A case could not be saved (${(error as Error).message}).`);
          return { kind: "failed", outcome: "not-saved", sources: caseSources(read.data, files) };
        }
        return { kind: "saved", sources: caseSources(next, files), data: next, value: done.value };
      });
      if (outcome !== "moved") return outcome;
    }
    return { kind: "unavailable" };
  }

  /**
   * Runs `work` on a case as it is on disk now, in its save queue (the report's sections
   * use it: src/main/sections.ts). When `work` gives data to save, it is written durably,
   * and the answer holds the case as saved. A case that is gone, damaged, from a newer
   * version, or in a cases folder that cannot be used, is never written to.
   */
  async changeCase<T>(
    caseId: unknown,
    work: (data: CaseData, folder: string, now: string) => Promise<{ save: CaseData | null; value: T }> | { save: CaseData | null; value: T },
  ): Promise<{ kind: "saved" | "unchanged"; data: CaseData; value: T; folder: string } | { kind: "failed"; outcome: "not-saved" | "case-full" } | { kind: "unavailable" }> {
    const id = checkCaseId(caseId);
    let folderUsed = "";
    const result = await this.withCase(id, async (data, folder) => {
      folderUsed = folder;
      return work(data, folder, this.nextTime(data));
    });
    if (result.kind === "saved") return { kind: "saved", data: result.data, value: result.value, folder: folderUsed };
    if (result.kind === "unchanged") return { kind: "unchanged", data: result.data, value: result.value, folder: folderUsed };
    if (result.kind === "failed") return { kind: "failed", outcome: result.outcome };
    return { kind: "unavailable" };
  }

  /**
   * The path of a folder Home lists as unreadable, to reveal it: only a name the last
   * listing of the current cases folder showed as unreadable. Null otherwise, or if it is gone.
   */
  async unreadableFolderPath(folderName: unknown): Promise<string | null> {
    if (!FolderNameSchema.safeParse(folderName).success) throw new Error("Refused: not a folder name.");
    const { folder } = await this.options.location();
    if (this.listedFolder !== folder || !this.unreadableNames.has(folderName as string)) return null;
    const target = path.join(folder, folderName as string);
    if (path.dirname(target) !== folder) return null;
    try {
      // The folder itself, or the link itself (revealing a link shows it, without following it).
      const info = await lstat(target);
      return info.isDirectory() || info.isSymbolicLink() ? target : null;
    } catch {
      return null;
    }
  }

  /**
   * Saves with a new updatedAt. When opening, a failed save (a read-only folder, say)
   * is logged and the case still opens with what was found; `strict` makes it throw.
   */
  private async write(folder: string, data: CaseData, { strict = false } = {}): Promise<CaseData> {
    const next = { ...data, updatedAt: nextUpdatedAt(data.updatedAt, this.options.now()) };
    try {
      const text = readableCaseFileText(next);
      if (text === null) throw new Error("the change would not read back whole");
      await this.options.writeFile(path.join(folder, CASE_FILE_NAME), text);
      return next;
    } catch (error) {
      this.options.log(`A case could not be saved (${(error as Error).message}).`);
      if (strict) throw new Error("The case could not be saved.", { cause: error });
      return data;
    }
  }

  private queued<T>(folder: string, work: () => Promise<T>): Promise<T> {
    this.active++;
    const run = (this.queues.get(folder) ?? Promise.resolve()).then(work).finally(() => this.active--);
    this.queues.set(
      folder,
      run.catch(() => undefined),
    );
    return run;
  }
}
