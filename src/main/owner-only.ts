import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

/*
 * Keeping the credentials file readable by its owner only (owner's decision, 2026-11-22).
 * macOS and Linux: the file is created with mode 0600 (src/main/durable-write.ts).
 * Windows: the closest equivalent, an access list with one entry, full control for the
 * current user's security identifier (SID), and nothing inherited from the folder, set
 * with Windows' own icacls on the empty temporary file before any secret is written to it;
 * the rename that replaces the file keeps it. Nothing here imports Electron.
 */

const run = promisify(execFile);

/** Runs a Windows tool from System32 by its full path, so a program of the same name elsewhere on PATH is never run. */
function system32(tool: string): string {
  return path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", tool);
}

let currentSid: Promise<string> | null = null;

/** The current user's SID ("S-1-5-21-..."), from whoami. Asked once per run. */
export function currentUserSid(): Promise<string> {
  currentSid ??= run(system32("whoami.exe"), ["/user", "/fo", "csv", "/nh"], { windowsHide: true }).then(({ stdout }) => {
    const sid = parseWhoamiSid(stdout);
    if (!sid) throw new Error("whoami did not give the current user's SID.");
    return sid;
  });
  currentSid.catch(() => (currentSid = null));
  return currentSid;
}

/** The SID in whoami /user /fo csv /nh's answer: "desktop\\ana","S-1-5-21-...". */
export function parseWhoamiSid(stdout: string): string | null {
  const match = /"(S-1-[0-9]+(?:-[0-9]+)+)"\s*$/m.exec(stdout.trim());
  return match ? match[1] : null;
}

/** The icacls arguments that leave `file` with one entry: full control for `sid`, nothing inherited. */
export function ownerOnlyIcaclsArgs(file: string, sid: string): string[] {
  return [file, "/inheritance:r", "/grant:r", `*${sid}:(F)`];
}

/**
 * Makes `file` readable and writable by the current user only. On Windows it sets the
 * access list with icacls and throws if that fails (the save then fails: a secret is
 * never written to a file others may read). Elsewhere the file's mode already does it.
 */
export async function restrictToOwner(file: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform !== "win32") return;
  const sid = await currentUserSid();
  await run(system32("icacls.exe"), ownerOnlyIcaclsArgs(file, sid), { windowsHide: true });
}

/** Windows only: the access list's entries as icacls shows them, for tests and diagnostics. */
export async function describeAccess(file: string): Promise<string> {
  const { stdout } = await run(system32("icacls.exe"), [file], { windowsHide: true });
  return stdout;
}
