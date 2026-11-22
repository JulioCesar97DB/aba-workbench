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
import { writeFileDurably } from "./durable-write.ts";

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
    clientAge: data.clientAge ?? null,
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
    const result = readCaseFile(await readFile(file, "utf8"));
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

export class CaseLibrary {
  /** Each case's folder, by id, as last listed. */
  private folders = new Map<string, string>();
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

  async folderInfo(): Promise<CasesFolderInfo & { folder: string }> {
    const { folder, isDefault } = await this.options.location();
    let state: CasesFolderInfo["state"];
    try {
      state = await inspectCasesFolder(folder, isDefault, this.options.platform);
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
    const names = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();
    const reads = await Promise.all(names.map(async (name) => ({ name, read: await readCaseFolder(path.join(folder, name)) })));

    const folders = new Map<string, string>();
    const cases: CaseData[] = [];
    const unreadable: UnreadableFolder[] = [];
    for (const { name, read } of reads) {
      if (read.kind === "unreadable") unreadable.push({ folderName: name, reason: read.reason });
      else if (folders.has(read.data.id)) unreadable.push({ folderName: name, reason: "duplicate" });
      else {
        folders.set(read.data.id, path.join(folder, name));
        cases.push(read.data);
      }
    }
    this.folders = folders;
    cases.sort((a, b) => (a.createdAt === b.createdAt ? a.label.localeCompare(b.label) : a.createdAt < b.createdAt ? 1 : -1));
    return { folder: info, cases: cases.map(caseSummary), unreadable };
  }

  async create(input: unknown): Promise<CreateCaseResult> {
    const parsed = NewCaseInputSchema.safeParse(input);
    if (!parsed.success) throw new Error("Refused: a new case needs a label and, optionally, an age in years and months.");
    const label = checkCaseLabel(parsed.data.label);
    if (!label.ok) throw new Error(`Refused: the label is ${label.problem}.`);

    const { folder, state } = await this.folderInfo();
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
    this.folders.set(data.id, caseFolder);
    return { outcome: "created", case: caseSummary(data) };
  }

  async open(caseId: unknown): Promise<OpenCaseResult> {
    if (!isCaseId(caseId)) throw new Error("Refused: not a case id.");
    const { state } = await this.folderInfo();
    // The default folder not made yet holds no cases.
    if (state === "not-created-yet") return { outcome: "not-found" };
    if (state !== "ready" && state !== "not-writable") return { outcome: "folder-problem", problem: state };
    if (!this.folders.has(caseId)) await this.list();
    const folder = this.folders.get(caseId);
    if (!folder) return { outcome: "not-found" };
    return this.queued(folder, async () => {
      const read = await readCaseFolder(folder);
      if (read.kind === "unreadable") return read.reason === "not-a-case" ? { outcome: "not-found" } : { outcome: "unreadable", reason: read.reason };
      // The folder now holds another case (moved around outside the app).
      if (read.data.id !== caseId) return { outcome: "not-found" };
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
  }

  /**
   * Changes a case and saves it durably, with a new updatedAt. For later phases (sources,
   * behaviors, drafts); `change` gets the case as on disk now. Null if it cannot be read.
   */
  async update(caseId: string, change: (data: CaseData) => CaseData): Promise<CaseData | null> {
    if (!isCaseId(caseId)) throw new Error("Refused: not a case id.");
    if (!this.folders.has(caseId)) await this.list();
    const folder = this.folders.get(caseId);
    if (!folder) return null;
    return this.queued(folder, async () => {
      const read = await readCaseFolder(folder);
      if (read.kind === "unreadable" || read.data.id !== caseId) return null;
      return this.write(folder, change(read.data), { strict: true });
    });
  }

  /** The path of a folder Home lists as unreadable, to reveal it; null if it is not one now. */
  async unreadableFolderPath(folderName: unknown): Promise<string | null> {
    if (!FolderNameSchema.safeParse(folderName).success) throw new Error("Refused: not a folder name.");
    const { folder } = await this.options.location();
    const target = path.join(folder, folderName as string);
    if (path.dirname(target) !== folder) return null;
    try {
      return (await lstat(target)).isDirectory() ? target : null;
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
