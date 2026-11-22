import { z } from "zod";
import { checkCaseLabel, isCaseId, MAX_CLIENT_AGE_YEARS, type CaseFile, type ClientAge } from "../shared/api.ts";

/*
 * A case's data file: aba-case.json, inside the case's folder, next to its PDFs (which
 * stay as they are, never converted or embedded). JSON with a schema version, read back
 * through Zod. Nothing here imports Electron or touches the disk, so it is unit-tested.
 *
 * Version 1 holds what Phase 1 needs: the id, the label, the client's age if given, the
 * created and updated times, and the PDFs found in the folder. Later phases add their own
 * top-level keys (sources, behaviors, drafts) and raise the version, with a migration.
 *
 * Rules that keep a user's data safe:
 * - A key this version does not know is kept as it is when the file is saved.
 * - A file with a higher schemaVersion (a newer app wrote it) is never written to.
 * - An older file is migrated in memory, one version at a time (MIGRATIONS); it is
 *   written in the current version only when the case is next saved.
 */

export const CASE_FILE_NAME = "aba-case.json";
/** Raise it, and add a step to MIGRATIONS, when the shape changes. */
export const CASE_SCHEMA_VERSION = 1;
/** A data file larger than this is not one the app wrote (version 1 is a few kilobytes). */
export const MAX_CASE_FILE_BYTES = 5_000_000;
/** The most PDFs a case lists. */
export const MAX_LISTED_FILES = 10_000;

/** UTC only, as the app writes it ("2026-11-22T15:00:00.000Z"). */
const TimestampSchema = z.iso.datetime();

export const ClientAgeSchema = z.strictObject({
  years: z.int().min(0).max(MAX_CLIENT_AGE_YEARS),
  months: z.int().min(0).max(11).optional(),
});

/** A label is stored already checked: reading refuses one that checkCaseLabel would change. */
const StoredLabelSchema = z
  .string()
  .max(1000)
  .refine((value) => {
    const checked = checkCaseLabel(value);
    return checked.ok && checked.label === value;
  });

/** Unknown keys on an entry are kept too (a later version may add some). */
const FileEntrySchema = z.looseObject({
  name: z.string().min(1).max(255),
  bytes: z.int().min(0),
  modifiedAt: TimestampSchema,
});

const CaseFileSchema = z.looseObject({
  schemaVersion: z.literal(CASE_SCHEMA_VERSION),
  id: z.string().refine(isCaseId),
  label: StoredLabelSchema,
  clientAge: ClientAgeSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  files: z.array(FileEntrySchema).max(MAX_LISTED_FILES),
});

/** A case's data, as the app holds it; unknown keys ride along. */
export type CaseData = z.infer<typeof CaseFileSchema>;

/** Turns a version-n file's data into version n+1 (the runner sets schemaVersion). */
export type Migration = (data: Record<string, unknown>) => Record<string, unknown>;

/** MIGRATIONS[n] upgrades a version-n file. None yet: version 1 is the first. */
export const MIGRATIONS: Readonly<Record<number, Migration>> = {};

export type CaseFileProblem = "damaged" | "newer-version";

/**
 * Brings parsed JSON up to `current`, one step at a time. A missing or impossible
 * version, or a missing step, makes the file damaged; a higher one, newer-version.
 * `current` and `migrations` are parameters so tests can check the chain itself.
 */
export function migrateCaseData(
  json: unknown,
  current: number = CASE_SCHEMA_VERSION,
  migrations: Readonly<Record<number, Migration>> = MIGRATIONS,
): { ok: true; data: Record<string, unknown>; migratedFrom: number | null } | { ok: false; problem: CaseFileProblem } {
  if (typeof json !== "object" || json === null || Array.isArray(json)) return { ok: false, problem: "damaged" };
  let data = json as Record<string, unknown>;
  const version = data.schemaVersion;
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) return { ok: false, problem: "damaged" };
  if (version > current) return { ok: false, problem: "newer-version" };
  for (let step = version; step < current; step++) {
    const migrate = migrations[step];
    if (!migrate) return { ok: false, problem: "damaged" };
    data = { ...migrate(data), schemaVersion: step + 1 };
  }
  return { ok: true, data, migratedFrom: version === current ? null : version };
}

export type ReadCaseFileResult = { ok: true; data: CaseData; migratedFrom: number | null } | { ok: false; problem: CaseFileProblem };

/** Reads a data file's text. Never throws: a file it cannot use is "damaged" or "newer-version". */
export function readCaseFile(text: string): ReadCaseFileResult {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, problem: "damaged" };
  }
  const migrated = migrateCaseData(json);
  if (!migrated.ok) return migrated;
  const parsed = CaseFileSchema.safeParse(migrated.data);
  if (!parsed.success) return { ok: false, problem: "damaged" };
  return { ok: true, data: parsed.data, migratedFrom: migrated.migratedFrom };
}

/** The file's text: the known keys first, in a fixed order, then any others as they were. */
export function serializeCaseFile(data: CaseData): string {
  const { schemaVersion, id, label, clientAge, createdAt, updatedAt, files, ...rest } = data;
  const ordered = { schemaVersion, id, label, ...(clientAge ? { clientAge } : {}), createdAt, updatedAt, files, ...rest };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/** A new case's data. */
export function newCaseData(options: { id: string; label: string; clientAge: ClientAge | null; now: Date; files?: CaseFile[] }): CaseData {
  const time = options.now.toISOString();
  return {
    schemaVersion: CASE_SCHEMA_VERSION,
    id: options.id,
    label: options.label,
    ...(options.clientAge ? { clientAge: options.clientAge } : {}),
    createdAt: time,
    updatedAt: time,
    files: (options.files ?? []).map((file) => ({ ...file })),
  };
}

/**
 * The next updatedAt: now, or a millisecond after the last one if the clock says
 * otherwise (it went back, or two saves fell in the same millisecond), so it always moves.
 */
export function nextUpdatedAt(previous: string, now: Date): string {
  return new Date(Math.max(now.getTime(), Date.parse(previous) + 1)).toISOString();
}
