import { lstat, open, readdir, rename, rm } from "node:fs/promises";
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
 * How long another process's temporary file must have been untouched before it is
 * treated as left behind by a save that was cut short. A save takes milliseconds; this
 * leaves room for a slow disk or network volume. It is a guess from the file's modified
 * time, so it can be wrong (a network server's clock far behind, a save hung for over a
 * minute); it is only used to decide when to finish a case's interrupted creation
 * (src/main/cases.ts), never to delete anything.
 */
export const STALE_TEMPORARY_AFTER_MS = 60_000;

/** Whether `name` is a temporary file a save of `fileName` makes: exactly "<fileName>.<digits>.tmp". */
export function isTemporaryFileOf(fileName: string, name: string): boolean {
  return name.startsWith(`${fileName}.`) && /^\.[0-9]+\.tmp$/.test(name.slice(fileName.length));
}

/** Whether `name` is this process's own temporary file (a save it may be making now). */
function isOwnTemporaryFile(name: string): boolean {
  return name.endsWith(`.${process.pid}${TEMPORARY_SUFFIX}`);
}

/**
 * Whether the temporary file `name` in `folder` was left behind by a save cut short (a
 * crash, a power cut): a plain file (lstat: a link is never followed), not this process's
 * own, and untouched for STALE_TEMPORARY_AFTER_MS. One copy of the app runs per profile
 * (src/main/index.ts), but two profiles or two computers can share a cases folder (a
 * network or synced folder): a file untouched for a minute is treated as left behind.
 */
export async function isLeftBehind(folder: string, name: string, now = Date.now()): Promise<boolean> {
  if (isOwnTemporaryFile(name)) return false;
  try {
    const info = await lstat(path.join(folder, name));
    return info.isFile() && now - info.mtimeMs >= STALE_TEMPORARY_AFTER_MS;
  } catch {
    return false;
  }
}

/**
 * Finishes a save a crash interrupted between flushing its temporary file and renaming
 * it: renames `temporary` to `file` and flushes the folder, as writeFileDurably would
 * have. Never replaces an existing `file`: false if one is there, or if the rename fails.
 */
export async function finishInterruptedSave(temporary: string, file: string): Promise<boolean> {
  try {
    await lstat(file);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }
  try {
    await rename(temporary, file);
  } catch {
    return false;
  }
  await flushFolder(path.dirname(file));
  return true;
}

/**
 * The settings file only (never a case folder: there the app deletes nothing, see
 * src/main/cases.ts): removes the temporary files a save cut short left next to `file`,
 * exactly "<name>.<digits>.tmp" and plain files, but not this process's own. One copy of
 * the app runs per profile, so no other process writes this profile's settings, and no
 * age is needed. A settings file holds only the app's own preferences, rewritten whole by
 * the next save. Failures are ignored.
 */
export async function removeLeftoverSettingsTemporaryFiles(file: string): Promise<void> {
  const folder = path.dirname(file);
  const base = path.basename(file);
  let names: string[];
  try {
    names = await readdir(folder);
  } catch {
    return;
  }
  for (const name of names) {
    if (!isTemporaryFileOf(base, name) || isOwnTemporaryFile(name)) continue;
    const isFile = await lstat(path.join(folder, name)).then(
      (info) => info.isFile(),
      () => false,
    );
    if (isFile) await rm(path.join(folder, name), { force: true }).catch(() => undefined);
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
