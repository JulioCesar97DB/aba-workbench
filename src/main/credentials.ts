import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { CredentialsProblem } from "../shared/api.ts";
import { decodeCaseFile, parsesWithoutLoss } from "./case-file.ts";
import { removeLeftoverAppDataTemporaryFiles, writeFileDurably } from "./durable-write.ts";
import { restrictToOwner } from "./owner-only.ts";

/*
 * The credentials file: the Claude key, the ChatGPT tokens and the client id OpenAI issued,
 * in credentials.json in the app's own data folder, next to settings.json (owner's
 * decisions, 2026-11-22). Readable by its owner only (src/main/owner-only.ts), written
 * durably (src/main/durable-write.ts), read back through Zod. No keychain encryption.
 *
 * Only the main process touches it. Nothing in it is ever logged, put in an error message,
 * sent to the interface or written anywhere else. A file this version cannot use
 * (damaged, unreadable, from a newer app) is never written to: both connections show as
 * not connected until the user chooses "Start over", which renames it aside, never
 * deleting it. Nothing here imports Electron, so it is unit-tested.
 */

export const CREDENTIALS_FILE_NAME = "credentials.json";
/** Written into the file. Raise it, and add a step to MIGRATIONS, when the shape changes. */
export const CREDENTIALS_FILE_VERSION = 1;
/** Far more than the file ever holds (a few tokens of a few kilobytes each). */
export const MAX_CREDENTIALS_FILE_BYTES = 1_000_000;

/** OpenAI's issuer for Sign in with ChatGPT; the only one the file may name. */
export const OPENAI_ISSUER = "https://auth.openai.com";

const Timestamp = z.iso.datetime();
/** A token or a key: never empty, never huge. */
const Secret = z.string().min(1).max(20_000);

/** This computer's ext_agent_host_id: urn:uuid: and a version 4 UUID, made once and never changed (owner's decision). */
const HostIdSchema = z.string().regex(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

const ClaudeRecordSchema = z.looseObject({
  apiKey: z.string().min(1).max(400),
  savedAt: Timestamp,
});

/** What stays of a ChatGPT registration after a sign-out: enough to sign in again to the same account. */
const RegistrationShape = {
  issuer: z.literal(OPENAI_ISSUER),
  clientId: z.string().min(1).max(200),
  subject: z.string().min(1).max(500),
};

const ChatGptSignedOutSchema = z.looseObject({
  ...RegistrationShape,
  /**
   * Absent for a registration whose first sign-in did not finish (the code exchange or the
   * ID token failed after OpenAI issued the client id): kept so the next attempt reuses
   * that client id instead of registering another app, as OpenAI's docs ask.
   */
  subject: RegistrationShape.subject.optional(),
  signedOut: z.literal(true),
  /** Set when the session ended on OpenAI's side (revoked, expired), not by the user's sign-out. */
  sessionEnded: z.literal(true).optional(),
});

const ChatGptSignedInSchema = z.looseObject({
  ...RegistrationShape,
  /** From the validated ID token; used only as login_hint for a later sign-in. */
  email: z.string().max(320).nullable(),
  /** From the validated ID token; the one thing the interface shows of the account. */
  name: z.string().max(200).nullable(),
  idToken: Secret,
  accessToken: Secret,
  refreshToken: Secret,
  tokenType: z.literal("Bearer"),
  expiresAt: Timestamp,
  earliestRefreshAt: Timestamp.nullable(),
  scopes: z.array(z.string().min(1).max(200)).max(50),
  savedAt: Timestamp,
  /**
   * Set when OpenAI answered subscription_sharing_user_not_eligible: this account's plan,
   * workspace or a policy does not let it be used in apps. Kept across restarts; the next
   * sign-in, a sign-out or a check that works clears it.
   */
  planNotEligible: z.literal(true).optional(),
});

const CredentialsFileSchema = z.looseObject({
  version: z.literal(CREDENTIALS_FILE_VERSION),
  hostId: HostIdSchema,
  claude: ClaudeRecordSchema.nullable(),
  // Signed out first: a signed-in record has no signedOut key.
  chatgpt: z.union([ChatGptSignedOutSchema, ChatGptSignedInSchema]).nullable(),
});

export type ClaudeRecord = z.infer<typeof ClaudeRecordSchema>;
export type ChatGptSignedIn = z.infer<typeof ChatGptSignedInSchema>;
export type ChatGptSignedOut = z.infer<typeof ChatGptSignedOutSchema>;
export type ChatGptRecord = ChatGptSignedIn | ChatGptSignedOut;
/** Everything the file holds, its version left out; keys this version does not know are kept as they are. */
export interface StoredCredentials {
  hostId: string;
  claude: ClaudeRecord | null;
  chatgpt: ChatGptRecord | null;
  [key: string]: unknown;
}

export function isSignedIn(record: ChatGptRecord | null): record is ChatGptSignedIn {
  return record !== null && !("signedOut" in record && record.signedOut === true);
}

/** Turns version n into n + 1. None yet: version 1 is the first. */
const MIGRATIONS: Readonly<Record<number, (data: Record<string, unknown>) => Record<string, unknown>>> = {};

export type ParsedCredentials = { ok: true; credentials: StoredCredentials } | { ok: false; problem: "damaged" | "newer-version" };

/**
 * Reads the file's bytes under the same strict rules as a case's data file: UTF-8 with
 * nothing replaced, no repeated keys, no number JSON cannot hold exactly, then the schema.
 * A higher version is "newer-version"; anything else that does not fit is "damaged".
 */
export function parseCredentials(bytes: Uint8Array): ParsedCredentials {
  const text = decodeCaseFile(bytes);
  if (text === null) return { ok: false, problem: "damaged" };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, problem: "damaged" };
  }
  if (!parsesWithoutLoss(text) || typeof json !== "object" || json === null || Array.isArray(json)) return { ok: false, problem: "damaged" };
  let data = json as Record<string, unknown>;
  const version = data.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return { ok: false, problem: "damaged" };
  if (version > CREDENTIALS_FILE_VERSION) return { ok: false, problem: "newer-version" };
  for (let from = version; from < CREDENTIALS_FILE_VERSION; from++) {
    const step = MIGRATIONS[from];
    if (!step) return { ok: false, problem: "damaged" };
    data = { ...step(data), version: from + 1 };
  }
  const parsed = CredentialsFileSchema.safeParse(data);
  if (!parsed.success) return { ok: false, problem: "damaged" };
  const credentials: Record<string, unknown> = { ...parsed.data };
  delete credentials.version;
  return { ok: true, credentials: credentials as StoredCredentials };
}

/** The file's text: the known keys first, in a fixed order, then any others as they were. */
export function serializeCredentials(credentials: StoredCredentials): string {
  const { hostId, claude, chatgpt, ...rest } = credentials;
  return `${JSON.stringify({ version: CREDENTIALS_FILE_VERSION, hostId, claude, chatgpt, ...rest }, null, 2)}\n`;
}

/** A new ext_agent_host_id. */
export function newHostId(): string {
  return `urn:uuid:${randomUUID()}`;
}

/** What the file holds: null before anything was ever saved. */
export type CredentialsRead = { ok: true; credentials: StoredCredentials | null } | { ok: false; problem: CredentialsProblem };

/** The name "Start over" gives the old file: credentials.json.unreadable-2026-11-22T18-05-48Z (no colons, for Windows). */
export function unreadableFileName(now: Date, attempt = 0): string {
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, "Z").replaceAll(":", "-");
  return `${CREDENTIALS_FILE_NAME}.unreadable-${stamp}${attempt === 0 ? "" : `-${attempt + 1}`}`;
}

export class CredentialsStore {
  private current: CredentialsRead | null = null;
  /** Saves run one after another, so the last one asked for is the one on disk. */
  private queue: Promise<unknown> = Promise.resolve();

  private readonly file: string;
  private readonly platform: NodeJS.Platform;
  private readonly log: (message: string) => void;
  private readonly restrict: (file: string) => Promise<void>;
  /**
   * Set when a change is kept in memory because it could not be written (a refreshed
   * sign-in whose rotated refresh token must not be lost): the next successful save writes
   * it, and until then the interface says the sign-in is not saved.
   */
  private unsavedChange = false;

  constructor(
    file: string,
    options: {
      platform?: NodeJS.Platform;
      log?: (message: string) => void;
      /** Sets owner-only access on Windows; tests on other systems pass a recorder. */
      restrict?: (file: string, platform: NodeJS.Platform) => Promise<void>;
    } = {},
  ) {
    this.file = file;
    this.platform = options.platform ?? process.platform;
    this.log = options.log ?? ((message) => console.warn(message));
    const restrict = options.restrict ?? restrictToOwner;
    this.restrict = (target) => restrict(target, this.platform);
  }

  /** What the file holds, or why it cannot be used. Read once, then kept; never throws. */
  async read(): Promise<CredentialsRead> {
    if (this.current) return this.current;
    const result = await this.readFromDisk();
    this.current ??= result;
    return this.current;
  }

  /**
   * Changes the credentials and saves them. Refused when the file cannot be used (it is
   * never overwritten); when there is no file yet, it starts one with a new host id.
   * Throws when the file cannot be written; the credentials then stay as they were.
   */
  update(change: (current: StoredCredentials) => StoredCredentials): Promise<StoredCredentials> {
    const save = this.queue.then(async () => {
      const read = await this.read();
      if (!read.ok) throw new Error(`Refused: the credentials file cannot be used (${read.problem}).`);
      const next = change(read.credentials ?? { hostId: newHostId(), claude: null, chatgpt: null });
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeFileDurably(this.file, serializeCredentials(next), { mode: 0o600, prepare: this.restrict });
      this.current = { ok: true, credentials: next };
      this.unsavedChange = false;
      return next;
    });
    this.queue = save.catch(() => undefined);
    return save;
  }

  /**
   * Keeps a change in memory when it could not be saved, so what the app uses is the
   * latest (OpenAI rotates the refresh token on every refresh: the replaced one must never
   * be sent again). The next update, or saveUnsaved, writes it.
   */
  keepUnsaved(change: (current: StoredCredentials) => StoredCredentials): void {
    if (!this.current?.ok || !this.current.credentials) return;
    this.current = { ok: true, credentials: change(this.current.credentials) };
    this.unsavedChange = true;
  }

  /** True while a change kept by keepUnsaved is not on the disk. */
  get hasUnsavedChange(): boolean {
    return this.unsavedChange;
  }

  /** Tries again to write a change kept by keepUnsaved. True when it is now on the disk. */
  async saveUnsaved(): Promise<boolean> {
    if (!this.unsavedChange) return true;
    try {
      await this.update((current) => current);
      return true;
    } catch {
      return false;
    }
  }

  /** This computer's ext_agent_host_id, saved before it is first used and never changed. */
  async hostId(): Promise<string> {
    const read = await this.read();
    if (read.ok && read.credentials) return read.credentials.hostId;
    return (await this.update((current) => current)).hostId;
  }

  /**
   * "Start over" (owner's decision, 2026-11-22): a file this version cannot use is renamed
   * to credentials.json.unreadable-<UTC time> in the same folder, keeping its owner-only
   * permissions, never deleted; the app then starts with no credentials. False when the
   * rename failed (the file stays as it was), or when there was nothing to set aside.
   */
  startOver(now = new Date()): Promise<boolean> {
    const run = this.queue.then(async () => {
      const read = await this.read();
      if (read.ok) return false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const target = path.join(path.dirname(this.file), unreadableFileName(now, attempt));
        const taken = await lstat(target).then(
          () => true,
          () => false,
        );
        if (taken) continue;
        try {
          await rename(this.file, target);
        } catch (error) {
          this.log(`The unreadable credentials file could not be set aside (${(error as NodeJS.ErrnoException).code ?? "error"}).`);
          return false;
        }
        // The file set aside may still hold secrets: owner-only, whatever its mode was.
        await this.makeOwnerOnly(target);
        this.current = { ok: true, credentials: null };
        return true;
      }
      return false;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async readFromDisk(): Promise<CredentialsRead> {
    // A save cut short by a crash in an earlier run left its temporary file behind.
    await removeLeftoverAppDataTemporaryFiles(this.file);
    let info;
    try {
      info = await lstat(this.file);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { ok: true, credentials: null };
      this.log(`The credentials file could not be checked (${code ?? "error"}).`);
      return { ok: false, problem: "cannot-read" };
    }
    // A link, a folder or a huge file is not one this app wrote: never followed or read.
    if (!info.isFile() || info.size > MAX_CREDENTIALS_FILE_BYTES) {
      this.log("The credentials file is not a file this app wrote; it is left as it is.");
      return { ok: false, problem: "damaged" };
    }
    // Someone widened its permissions (macOS and Linux): back to owner-only, whether or not
    // it can be read, since even a damaged one may hold a key.
    if (this.platform !== "win32" && (info.mode & 0o077) !== 0) await this.makeOwnerOnly(this.file);
    let bytes: Uint8Array;
    try {
      bytes = await readFile(this.file);
    } catch (error) {
      this.log(`The credentials file could not be read (${(error as NodeJS.ErrnoException).code ?? "error"}).`);
      return { ok: false, problem: "cannot-read" };
    }
    const parsed = parseCredentials(bytes);
    if (!parsed.ok) {
      this.log(parsed.problem === "newer-version" ? "The credentials file was saved by a newer version of the app; it is left as it is." : "The credentials file is damaged; it is left as it is.");
      return parsed;
    }
    return { ok: true, credentials: parsed.credentials };
  }

  /** Owner-only access for a file the app keeps: mode 0600, or on Windows the current user's access list only. Logged when it fails. */
  private async makeOwnerOnly(target: string): Promise<void> {
    try {
      if (this.platform === "win32") await this.restrict(target);
      else await chmod(target, 0o600);
    } catch (error) {
      this.log(`A credentials file could not be made owner-only (${(error as NodeJS.ErrnoException).code ?? "error"}).`);
    }
  }
}
