import { open, readdir, rename, rm } from "node:fs/promises";
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
 * Removes the temporary files an earlier run left next to `file` when it stopped
 * mid-save (a crash, a power cut): exactly "<name>.<process id>.tmp", never anything
 * else. They are full or partial copies of the file and would otherwise stay for good,
 * since each run's temporary name holds its own process id. Only one copy of the app
 * runs at a time (src/main/index.ts), and the caller runs this where no save of `file`
 * is in flight, so none of them is in use. Failures are ignored.
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
  const own = path.basename(temporaryFileFor(file));
  for (const name of names) {
    if (name === own || !name.startsWith(`${base}.`) || !/^\.[0-9]+\.tmp$/.test(name.slice(base.length))) continue;
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
