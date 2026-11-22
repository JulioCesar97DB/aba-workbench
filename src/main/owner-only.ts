import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

/*
 * Keeping the credentials file readable by its owner only (owner's decision, 2026-11-22).
 * macOS and Linux: the file is created with mode 0600 (src/main/durable-write.ts).
 * Windows: the closest equivalent, an access list with one entry, full control for the
 * current user's security identifier (SID), and nothing inherited from the folder, set
 * with Windows' own icacls on the empty temporary file before any secret is written to it;
 * the rename that replaces the file keeps it. Nothing here imports Electron.
 *
 * The whole access list is set at once (icacls /restore with an SDDL string), not edited:
 * a new file can start with explicit entries of its own (SYSTEM and Administrators, from
 * the process's default access list, when its folder passes nothing down), which
 * "/inheritance:r /grant:r" would leave in place, as CI on Windows showed.
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

/**
 * The access list that leaves a file with one entry, full control (FA) for `sid`, and
 * protected (P) from anything its folder would pass down, in SDDL.
 */
export function ownerOnlySddl(sid: string): string {
  return `D:P(A;;FA;;;${sid})`;
}

/**
 * What icacls /restore reads: for each file, its name inside the folder given to icacls,
 * then its SDDL, in UTF-16LE as icacls /save writes it.
 */
export function ownerOnlyAclFile(fileName: string, sid: string): Buffer {
  return Buffer.from(`${fileName}\r\n${ownerOnlySddl(sid)}\r\n`, "utf16le");
}

/**
 * Makes `file` readable and writable by the current user only. On Windows it sets the
 * access list with icacls and throws if that fails (the save then fails: a secret is
 * never written to a file others may read). Elsewhere the file's mode already does it.
 */
export async function restrictToOwner(file: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform !== "win32") return;
  const sid = await currentUserSid();
  // The ACL file names only the file and the SID: nothing secret. It lives in its own
  // temporary folder, removed at once.
  const folder = await mkdtemp(path.join(tmpdir(), "aba-acl-"));
  try {
    const aclFile = path.join(folder, "acl.txt");
    await writeFile(aclFile, ownerOnlyAclFile(path.basename(file), sid));
    await run(system32("icacls.exe"), [path.dirname(file), "/restore", aclFile], { windowsHide: true });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/** Windows only: the access list's entries as icacls shows them, for tests and diagnostics. */
export async function describeAccess(file: string): Promise<string> {
  const { stdout } = await run(system32("icacls.exe"), [file], { windowsHide: true });
  return stdout;
}
