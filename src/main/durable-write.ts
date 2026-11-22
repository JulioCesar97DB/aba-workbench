import { open, readdir, rename, rm, stat } from "node:fs/promises";
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

/**
 * How old another process's temporary file must be before it counts as left behind. A
 * save takes milliseconds; this leaves room for a slow disk or network volume.
 */
export const STALE_TEMPORARY_AFTER_MS = 60_000;

/** Whether `name` is a temporary file a save of `fileName` makes: exactly "<fileName>.<digits>.tmp". */
export function isTemporaryFileOf(fileName: string, name: string): boolean {
  return name.startsWith(`${fileName}.`) && /^\.[0-9]+\.tmp$/.test(name.slice(fileName.length));
}

/**
 * Whether the temporary file `name` in `folder` was left behind by a save cut short (a
 * crash, a power cut): not this process's own, and untouched for STALE_TEMPORARY_AFTER_MS.
 * One copy of the app runs per profile (src/main/index.ts), but two profiles or two
 * computers can share a cases folder (a network or synced folder); the age keeps one from
 * removing a temporary file the other is still writing.
 */
export async function isLeftBehind(folder: string, name: string, now = Date.now()): Promise<boolean> {
  if (name.endsWith(`.${process.pid}${TEMPORARY_SUFFIX}`)) return false;
  try {
    return now - (await stat(path.join(folder, name))).mtimeMs >= STALE_TEMPORARY_AFTER_MS;
  } catch {
    return false;
  }
}

/**
 * Removes the temporary files a save cut short left next to `file` (isLeftBehind):
 * exactly "<name>.<digits>.tmp", never anything else. They are full or partial copies of
 * the file and would otherwise stay for good, since each run's temporary name holds its
 * own process id. Failures are ignored.
 */
export async function removeStaleTemporaryFiles(file: string): Promise<void> {
  const folder = path.dirname(file);
  const base = path.basename(file);
  let names: string[];
  try {
    names = await readdir(folder);
  } catch {
    return;
  }
  for (const name of names) {
    if (!isTemporaryFileOf(base, name) || !(await isLeftBehind(folder, name))) continue;
    await rm(path.join(folder, name), { force: true }).catch(() => undefined);
  }
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
