import { realpath as realpathCallback } from "node:fs";
import { access, constants, open, readdir, rm, stat } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import type { CasesFolderState } from "../shared/api.ts";
import { TEMPORARY_SUFFIX } from "./durable-write.ts";

/*
 * The cases folder: "ABA Workbench" directly in the user's home folder (~/ABA Workbench,
 * %USERPROFILE%\ABA Workbench), unless the user chose another in Settings. Not in
 * Documents, which iCloud and OneDrive often sync (owner's decision, 2026-11-22).
 * Nothing here imports Electron, so it is unit-tested.
 *
 * The app never creates a folder the user did not ask for. The default folder is made
 * (one level, inside a home folder that must exist) only when the first case is
 * created; a folder the user chose and that has since gone (an unplugged drive, a folder
 * moved away) is reported missing, never made again.
 */

export const DEFAULT_CASES_FOLDER_NAME = "ABA Workbench";

/** `p` is only there so tests can check Windows paths on any machine. */
export function defaultCasesFolder(homeFolder: string, p: path.PlatformPath = path): string {
  return p.join(homeFolder, DEFAULT_CASES_FOLDER_NAME);
}

/**
 * The folder the installed app lives in, which an update or uninstalling deletes whole:
 * on Windows and Linux the folder holding the executable and its resources folder
 * (%LOCALAPPDATA%\Programs\aba-workbench for the installer's per-user install); on macOS
 * the .app bundle. Null when the app runs from the repository.
 */
export function installFolder(location: { isPackaged: boolean; resourcesPath: string }, platform: NodeJS.Platform = process.platform, p: path.PlatformPath = path): string | null {
  if (!location.isPackaged) return null;
  const resources = p.resolve(location.resourcesPath);
  // macOS: ABA Workbench.app/Contents/Resources; elsewhere: <install folder>/resources.
  return platform === "darwin" ? p.dirname(p.dirname(resources)) : p.dirname(resources);
}

/**
 * A Windows path as Win32 reads it: each name loses its trailing dots and spaces
 * ("aba-workbench.\Casos" is "aba-workbench\Casos"), which path.win32 keeps.
 */
export function win32Canonical(value: string): string {
  return value
    .split(/([\\/]+)/)
    .map((part, index) => (index % 2 === 1 || part === "." || part === ".." || /^[. ]+$/.test(part) ? part : part.replace(/[. ]+$/, "")))
    .join("");
}

/**
 * Whether `folder` is `parent` or inside it, as text. Windows and macOS compare without
 * case, as their file systems do by default, and Windows as Win32 reads names
 * (win32Canonical); `p` is only there so tests can check Windows paths on any machine.
 * Other names for the same folder (a link, a junction, an 8.3 short name) need
 * isInsideOnDisk.
 */
export function isSameOrInside(folder: string, parent: string, platform: NodeJS.Platform = process.platform, p: path.PlatformPath = path): boolean {
  const canonical = (value: string) => (platform === "win32" ? win32Canonical(value) : value);
  const fold = (value: string) => (platform === "linux" ? value : value.toLowerCase());
  const relative = p.relative(fold(p.resolve(canonical(parent))), fold(p.resolve(canonical(folder))));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${p.sep}`) && !p.isAbsolute(relative));
}

/** What isInsideOnDisk reads from the disk; tests replace it. */
export interface FolderLookup {
  /** The path with every link, junction and short name resolved (fs.realpath.native). */
  realpath: (folder: string) => Promise<string>;
  /** The folder's volume and file number, which no other name for it changes. */
  identity: (folder: string) => Promise<{ dev: bigint; ino: bigint }>;
}

const nativeRealpath = promisify(realpathCallback.native);

export const diskLookup: FolderLookup = {
  realpath: (folder) => nativeRealpath(folder),
  identity: async (folder) => {
    const info = await stat(folder, { bigint: true });
    return { dev: info.dev, ino: info.ino };
  },
};

/**
 * The real path of `folder`, even when it does not exist yet: the deepest part that
 * exists, resolved, then the rest as written.
 */
async function realPathOf(folder: string, lookup: FolderLookup): Promise<string> {
  const rest: string[] = [];
  for (let current = path.resolve(folder); ; current = path.dirname(current)) {
    try {
      return path.join(await lookup.realpath(current), ...rest.reverse());
    } catch {
      if (path.dirname(current) === current) return path.resolve(folder);
      rest.push(path.basename(current));
    }
  }
}

/**
 * Whether `folder` is `parent` or inside it on the disk, by any name: as text; then by
 * their real paths, which resolve links, junctions, 8.3 short names and Win32's trailing
 * dots; then by identity, every folder from `folder`'s real path up to its root compared
 * with `parent` by volume and file number, which also catches names a real path does not
 * unify (a network path to this computer, a drive letter made with subst). An identity
 * of 0 (a file system without file numbers) is never compared.
 */
export async function isInsideOnDisk(folder: string, parent: string, platform: NodeJS.Platform = process.platform, lookup: FolderLookup = diskLookup): Promise<boolean> {
  if (isSameOrInside(folder, parent, platform)) return true;
  let realParent: string;
  try {
    realParent = await lookup.realpath(parent);
  } catch {
    // The install folder cannot be read: only the text comparison above can say anything.
    return false;
  }
  const realFolder = await realPathOf(folder, lookup);
  if (isSameOrInside(realFolder, realParent, platform)) return true;
  let target: { dev: bigint; ino: bigint };
  try {
    target = await lookup.identity(realParent);
  } catch {
    return false;
  }
  if (target.ino === 0n) return false;
  for (let current = realFolder; ; current = path.dirname(current)) {
    const found = await lookup.identity(current).catch(() => null);
    if (found && found.dev === target.dev && found.ino === target.ino) return true;
    if (path.dirname(current) === current) return false;
  }
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
 * - "not-created-yet": the default folder, not made yet; the home folder is there.
 * - "missing": the folder (or, for the default, the home folder) does not exist.
 * - "not-a-folder": a file is in its place.
 * - "not-allowed": the system refuses to let the app look inside. On macOS this is the
 *   answer to "allow access to the Documents folder" (or Desktop, Downloads, a drive, a
 *   cloud storage folder) being no for a folder the user chose there (EPERM).
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
  // Like a save (src/main/durable-write.ts): an exclusive create under a free name, and the
  // removal of only the file this check created; a taken name is left alone.
  for (let attempt = 0; attempt < 100; attempt++) {
    const probeFile = path.join(folder, `${WRITE_CHECK_PREFIX}${process.pid}${attempt === 0 ? "" : `-${attempt}`}${TEMPORARY_SUFFIX}`);
    let handle;
    try {
      handle = await open(probeFile, "wx");
    } catch (error) {
      if (errorCode(error) === "EEXIST") continue;
      return false;
    }
    await handle.close().catch(() => undefined);
    await rm(probeFile, { force: true }).catch(() => undefined);
    return true;
  }
  return false;
}
