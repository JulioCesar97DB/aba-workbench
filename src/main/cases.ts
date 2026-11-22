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
  type CasesFolderInfo,
  type CaseSummary,
  type CreateCaseResult,
  type OpenCaseResult,
  type UnreadableFolder,
  type UnreadableReason,
} from "../shared/api.ts";
import { CASE_FILE_NAME, ClientAgeSchema, MAX_CASE_FILE_BYTES, MAX_LISTED_FILES, newCaseData, nextUpdatedAt, readCaseFile, serializeCaseFile, type CaseData } from "./case-file.ts";
import { caseFolderNames } from "./case-folder-name.ts";
import { inspectCasesFolder } from "./cases-folder.ts";
import { removeStaleTemporaryFiles, writeFileDurably } from "./durable-write.ts";

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

function sameFiles(a: readonly CaseFile[], b: readonly CaseFile[]): boolean {
  return a.length === b.length && a.every((file, i) => file.name === b[i].name && file.bytes === b[i].bytes && file.modifiedAt === b[i].modifiedAt);
}

/** Newest first by created time (as times, not text), then by folder name, the same on every system. */
function newestFirst(a: { data: CaseData; name: string }, b: { data: CaseData; name: string }): number {
  const difference = Date.parse(b.data.createdAt) - Date.parse(a.data.createdAt);
  if (difference !== 0) return difference;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

export class CaseLibrary {
  /** Each case's folder, by id, as last listed, and the cases folder that listing read. */
  private folders = new Map<string, string>();
  private listedFolder: string | null = null;
  /** The folders the last listing showed as unreadable: the only ones that can be revealed. */
  private unreadableNames = new Set<string>();
  /** Saves of one case run one after another. */
  private queues = new Map<string, Promise<unknown>>();
  private readonly options: Required<CaseLibraryOptions>;

  constructor(options: CaseLibraryOptions) {
    this.options = {
      now: () => new Date(),
      newId: () => randomUUID(),
      log: (message) => console.warn(message),
      platform: process.platform,
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
      state = await inspectCasesFolder(folder, isDefault, this.options.platform, { probeWrite });
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
    for (const { name, read } of reads) {
      if (read.kind === "unreadable") unreadable.push({ folderName: name, reason: read.reason });
      else if (folders.has(read.data.id)) unreadable.push({ folderName: name, reason: "duplicate" });
      else {
        folders.set(read.data.id, path.join(folder, name));
        cases.push({ data: read.data, name });
      }
    }
    unreadable.sort((a, b) => (a.folderName < b.folderName ? -1 : a.folderName > b.folderName ? 1 : 0));
    this.folders = folders;
    this.listedFolder = folder;
    this.unreadableNames = new Set(unreadable.map((entry) => entry.folderName));
    cases.sort(newestFirst);
    return { folder: info, cases: cases.map(({ data }) => caseSummary(data)), unreadable };
  }

  async create(input: unknown): Promise<CreateCaseResult> {
    const parsed = NewCaseInputSchema.safeParse(input);
    if (!parsed.success) throw new Error("Refused: a new case needs a label and, optionally, an age in years and months.");
    const label = checkCaseLabel(parsed.data.label);
    if (!label.ok) throw new Error(`Refused: the label is ${label.problem}.`);

    const { folder, state } = await this.folderInfo({ probeWrite: true });
    if (state === "not-created-yet") {
      // The default folder, inside Documents, on the first case. One level: Documents must be there.
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
      await this.options.writeFile(path.join(caseFolder, CASE_FILE_NAME), serializeCaseFile(data));
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
      // A save cut short in an earlier run left a copy of the data file: remove it.
      await removeStaleTemporaryFiles(path.join(folder, CASE_FILE_NAME));
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
      const detail: CaseDetail = { ...caseSummary(data), files: data.files.map(({ name, bytes, modifiedAt }) => ({ name, bytes, modifiedAt })) };
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
        await removeStaleTemporaryFiles(path.join(folder, CASE_FILE_NAME));
        return this.write(folder, change(read.data), { strict: true });
      });
      if (saved !== "moved") return saved;
    }
    return null;
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
      await this.options.writeFile(path.join(folder, CASE_FILE_NAME), serializeCaseFile(next));
      return next;
    } catch (error) {
      this.options.log(`A case could not be saved (${(error as Error).message}).`);
      if (strict) throw new Error("The case could not be saved.", { cause: error });
      return data;
    }
  }

  private queued<T>(folder: string, work: () => Promise<T>): Promise<T> {
    const run = (this.queues.get(folder) ?? Promise.resolve()).then(work);
    this.queues.set(
      folder,
      run.catch(() => undefined),
    );
    return run;
  }
}
