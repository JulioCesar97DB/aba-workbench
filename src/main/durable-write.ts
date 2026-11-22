import { lstat, open, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";

/*
 * Writing a file so that a crash or a power cut mid-save leaves the old file or the new
 * one, never half of either. Used for the settings file and for every case's data file.
 * Nothing here imports Electron, so it is unit-tested.
 */

/** The suffix of the temporary file a save writes first; listings skip such files. */
export const TEMPORARY_SUFFIX = ".tmp";

/**
 * The temporary file a save of `file` tries first ("<file>.<process id>.tmp"), and the
 * ones it tries next when that name is taken ("<file>.<process id><n>.tmp"): every name
 * is "<file>.<digits>.tmp" (isTemporaryFileOf).
 */
export function temporaryFileFor(file: string, attempt = 0): string {
  return `${file}.${process.pid}${attempt === 0 ? "" : attempt}${TEMPORARY_SUFFIX}`;
}

/** How many names a save tries before it gives up (each taken one is left alone). */
const MAX_TEMPORARY_NAMES = 1000;

/**
 * The temporary files this process is writing right now. Names cannot say it: an earlier
 * run that crashed may have had the same process id.
 */
const inFlight = new Set<string>();

/**
 * Writes `text` to a temporary file next to `file`, flushes it to the disk, renames it
 * over `file`, then flushes the folder so the rename itself survives a power cut (on
 * macOS and Linux; Windows cannot open a folder for that, and NTFS journals the rename).
 * The folder must exist: this never creates one.
 *
 * It never touches a file it did not create (owner's decision, 2026-11-22). The temporary
 * file is created exclusively ("wx"); when a name is taken (a crashed earlier run with the
 * same process id left a file that may hold the user's latest change), the next name is
 * tried and the existing file is left as it is. A failed save removes the temporary file
 * this same call created, and only that one (`created`), and throws; `file` is left as it was.
 */
export async function writeFileDurably(file: string, text: string): Promise<void> {
  let temporary: string | null = null;
  let created = false;
  try {
    let handle;
    for (let attempt = 0; !handle; attempt++) {
      if (attempt >= MAX_TEMPORARY_NAMES) throw new Error("No free name for a temporary file.");
      const candidate = temporaryFileFor(file, attempt);
      try {
        handle = await open(candidate, "wx");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw error;
      }
      temporary = candidate;
      created = true;
      inFlight.add(temporary);
    }
    try {
      await handle.writeFile(text, "utf8");
      await handle.datasync();
    } finally {
      await handle.close();
    }
    await rename(temporary!, file);
    created = false;
  } catch (error) {
    // Only the file this call created: never one another run left behind.
    if (created && temporary) await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    if (temporary) inFlight.delete(temporary);
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

/** Whether `folder`/`name` is a temporary file this process is writing right now. */
function isInFlight(folder: string, name: string): boolean {
  return inFlight.has(path.join(folder, name));
}

/**
 * Whether the temporary file `name` in `folder` was left behind by a save cut short (a
 * crash, a power cut): a plain file (lstat: a link is never followed), not one this
 * process is writing now, and untouched for STALE_TEMPORARY_AFTER_MS. One copy of the app runs per profile
 * (src/main/index.ts), but two profiles or two computers can share a cases folder (a
 * network or synced folder): a file untouched for a minute is treated as left behind.
 */
export async function isLeftBehind(folder: string, name: string, now = Date.now()): Promise<boolean> {
  if (isInFlight(folder, name)) return false;
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
 * exactly "<name>.<digits>.tmp" and plain files, but not one this process is writing. One copy of
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
    if (!isTemporaryFileOf(base, name) || isInFlight(folder, name)) continue;
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
