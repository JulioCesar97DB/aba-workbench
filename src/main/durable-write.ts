import { open, rename, rm } from "node:fs/promises";
import path from "node:path";

/*
 * Writing a file so that a crash or a power cut mid-save leaves the old file or the new
 * one, never half of either. Used for the settings file and for every case's data file.
 * Nothing here imports Electron, so it is unit-tested.
 */

/** The suffix of the temporary file a save writes first; listings skip such files. */
export const TEMPORARY_SUFFIX = ".tmp";

/** The temporary file a save of `file` writes before renaming it over `file`. */
export function temporaryFileFor(file: string): string {
  return `${file}.${process.pid}${TEMPORARY_SUFFIX}`;
}

/**
 * Writes `text` to a temporary file next to `file`, flushes it to the disk, renames it
 * over `file`, then flushes the folder so the rename itself survives a power cut (on
 * macOS and Linux; Windows cannot open a folder for that, and NTFS journals the rename).
 * A failed save removes the temporary file and throws; `file` is left as it was.
 * The folder must exist: this never creates one.
 */
export async function writeFileDurably(file: string, text: string): Promise<void> {
  const temporary = temporaryFileFor(file);
  try {
    // "wx": never reuses a temporary file left by a crash; a stale one is removed first.
    await rm(temporary, { force: true });
    const handle = await open(temporary, "wx");
    try {
      await handle.writeFile(text, "utf8");
      await handle.datasync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  await flushFolder(path.dirname(file));
}

async function flushFolder(folder: string): Promise<void> {
  if (process.platform === "win32") return;
  let handle;
  try {
    handle = await open(folder, "r");
    await handle.sync();
  } catch {
    // Some file systems refuse to sync a folder; the file itself is already on the disk.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
