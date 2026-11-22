import { open, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { MAX_PDF_BYTES } from "../shared/sources.ts";
import { pdfFileNames } from "./case-folder-name.ts";
import { flushFolder } from "./durable-write.ts";

/*
 * Copying a PDF into a case's folder, as it is: the bytes are never converted, and the
 * original is only ever read (a PDF chosen in the dialog) or never opened at all (a PDF
 * dropped onto the window arrives as bytes). Nothing here imports Electron, so it is
 * unit-tested.
 *
 * The copy gets the original's name made safe (pdfFileNames), " 2" when that name is
 * taken, and is made with an exclusive create, so no file in the folder is ever
 * overwritten. A copy that fails while the app is running (a full disk) removes the
 * partial file this same call created, and only that one: the same rule as a failed save
 * (src/main/durable-write.ts). A crash mid-copy can leave a partial PDF in the folder;
 * it is not one of the case's sources (the data file is saved after the copy), and the
 * Sources step lists it with the folder's other PDFs, never as a source.
 */

/** Whether bytes look like a PDF: "%PDF-" within the first 1024 bytes, as PDF readers accept. */
export function looksLikePdf(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 1024));
  return head.includes("%PDF-");
}

export type LoadedPdf = { ok: true; bytes: Uint8Array } | { ok: false; problem: "too-large" | "cannot-read" | "not-a-pdf" };

/** Reads a PDF the user chose in the system's dialog. Only reads: the original is never changed. */
export async function readChosenPdf(file: string): Promise<LoadedPdf> {
  try {
    const info = await stat(file);
    if (!info.isFile()) return { ok: false, problem: "cannot-read" };
    if (info.size > MAX_PDF_BYTES) return { ok: false, problem: "too-large" };
    const bytes = await readFile(file);
    if (bytes.byteLength > MAX_PDF_BYTES) return { ok: false, problem: "too-large" };
    return looksLikePdf(bytes) ? { ok: true, bytes } : { ok: false, problem: "not-a-pdf" };
  } catch {
    return { ok: false, problem: "cannot-read" };
  }
}

/** Checks dropped bytes the same way. */
export function checkDroppedPdf(bytes: Uint8Array): LoadedPdf {
  if (bytes.byteLength > MAX_PDF_BYTES) return { ok: false, problem: "too-large" };
  return looksLikePdf(bytes) ? { ok: true, bytes } : { ok: false, problem: "not-a-pdf" };
}

/**
 * The PDF at the top of the folder with exactly these bytes, if there is one: adding a
 * file already there makes no second copy. Only files of the same size are read.
 */
export async function findSamePdf(folder: string, bytes: Uint8Array, candidates: ReadonlyArray<{ name: string; bytes: number }>): Promise<string | null> {
  for (const candidate of candidates) {
    if (candidate.bytes !== bytes.byteLength) continue;
    try {
      const existing = await readFile(path.join(folder, candidate.name));
      if (Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).equals(existing)) return candidate.name;
    } catch {
      // Gone or unreadable: not the same file.
    }
  }
  return null;
}

/**
 * Writes `bytes` as a new PDF in `folder`, named from `originalName`, and returns the
 * name it got. Never replaces a file: each name is created exclusively ("wx"), and a
 * taken one, even one that appeared a moment ago, moves on to the next.
 */
export async function copyPdfIntoFolder(folder: string, originalName: string, bytes: Uint8Array, write = writeNewFile): Promise<string> {
  const taken = await readdir(folder);
  let attempts = 0;
  for (const name of pdfFileNames(path.basename(originalName.replaceAll("\\", "/")), taken)) {
    try {
      await write(path.join(folder, name), bytes);
      await flushFolder(folder);
      return name;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || ++attempts > 1000) throw error;
    }
  }
  throw new Error("No free name for the PDF.");
}

/** Creates `file` (it must not exist), writes `bytes` and flushes them to the disk. */
export async function writeNewFile(file: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(file, "wx");
  let complete = false;
  try {
    await handle.writeFile(bytes);
    await handle.datasync();
    complete = true;
  } finally {
    await handle.close().catch(() => undefined);
    // Only the file this call created, and only when its copy failed.
    if (!complete) await rm(file, { force: true }).catch(() => undefined);
  }
}
