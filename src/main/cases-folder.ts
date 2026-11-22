import { access, constants, open, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { CasesFolderState } from "../shared/api.ts";
import { TEMPORARY_SUFFIX } from "./durable-write.ts";

/*
 * The cases folder: Documents/ABA Workbench unless the user chose another in Settings.
 * Nothing here imports Electron, so it is unit-tested.
 *
 * The app never creates a folder the user did not ask for. The default folder is made
 * (one level, inside a Documents folder that must exist) only when the first case is
 * created; a folder the user chose and that has since gone (an unplugged drive, a folder
 * moved away) is reported missing, never made again.
 */

export const DEFAULT_CASES_FOLDER_NAME = "ABA Workbench";

/** `p` is only there so tests can check Windows paths on any machine. */
export function defaultCasesFolder(documentsFolder: string, p: path.PlatformPath = path): string {
  return p.join(documentsFolder, DEFAULT_CASES_FOLDER_NAME);
}

/** The file a write check makes and removes at once (Windows only, see canWrite). */
const WRITE_CHECK_PREFIX = ".aba-workbench-write-check-";

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * Whether the app can use `folder` as its cases folder, without changing anything (on
 * Windows, with `probeWrite`, a write check makes one empty file and removes it).
 *
 * - "ready": a folder the app can read and write.
 * - "not-created-yet": the default folder, not made yet; Documents is there.
 * - "missing": the folder (or, for the default, Documents) does not exist.
 * - "not-a-folder": a file is in its place.
 * - "not-allowed": the system refuses to let the app look inside. On macOS this is the
 *   answer to "allow access to the Documents folder" being no (EPERM).
 * - "not-writable": the app can read it but cannot save into it.
 */
export async function inspectCasesFolder(
  folder: string,
  isDefault: boolean,
  platform: NodeJS.Platform = process.platform,
  { probeWrite = true }: { probeWrite?: boolean } = {},
): Promise<CasesFolderState> {
  let info;
  try {
    info = await stat(folder);
  } catch (error) {
    const code = errorCode(error);
    if (code === "EPERM" || code === "EACCES") return "not-allowed";
    if (code === "ENOENT" && isDefault) return (await isFolder(path.dirname(folder))) ? "not-created-yet" : "missing";
    if (code === "ENOENT" || code === "ENOTDIR") return "missing";
    throw error;
  }
  if (!info.isDirectory()) return "not-a-folder";
  try {
    // Reading its list is what Home does; macOS's privacy refusal shows here too.
    await readdir(folder);
  } catch (error) {
    const code = errorCode(error);
    if (code === "EPERM" || code === "EACCES") return "not-allowed";
    throw error;
  }
  return (await canWrite(folder, platform, probeWrite)) ? "ready" : "not-writable";
}

async function isFolder(folder: string): Promise<boolean> {
  try {
    return (await stat(folder)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * On macOS and Linux the permission bits answer it. On Windows they do not (access
 * rights, Controlled folder access): there the only reliable check is to make a file,
 * done only when `probe` is set (choosing a folder, creating a case). Without it, a
 * readable folder on Windows counts as writable until a save says otherwise.
 */
async function canWrite(folder: string, platform: NodeJS.Platform, probe: boolean): Promise<boolean> {
  if (platform !== "win32") {
    try {
      await access(folder, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }
  if (!probe) return true;
  const probeFile = path.join(folder, `${WRITE_CHECK_PREFIX}${process.pid}${TEMPORARY_SUFFIX}`);
  try {
    const handle = await open(probeFile, "wx");
    await handle.close();
    await rm(probeFile, { force: true });
    return true;
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      await rm(probeFile, { force: true }).catch(() => undefined);
      return true;
    }
    return false;
  }
}
