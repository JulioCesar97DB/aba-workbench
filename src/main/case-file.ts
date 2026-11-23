import { z } from "zod";
import { checkCaseLabel, isCaseId, MAX_CLIENT_AGE_YEARS, type CaseFile, type ClientAge } from "../shared/api.ts";
import { checkSourceTitle, isSourceDate, MAX_SOURCE_TEXT_LENGTH, MAX_SOURCES } from "../shared/sources.ts";
import { MAX_NOTES_LENGTH, MAX_REQUEST_LENGTH, MAX_SECTION_TEXT_LENGTH } from "../shared/section-text.ts";
import { MAX_CONSISTENCY_ITEM_LENGTH } from "../lib/rules.ts";
import { CaseMapSchema } from "./case-map.ts";

/*
 * A case's data file: aba-case.json, inside the case's folder, next to its PDFs (which
 * stay as they are, never converted or embedded). JSON with a schema version, read back
 * through Zod. Nothing here imports Electron or touches the disk, so it is unit-tested.
 *
 * Version 1 held what Phase 1 needed: the id, the label, the client's age if given, the
 * created and updated times, and the PDFs found in the folder. Version 2 adds the case's
 * sources (pasted texts, and PDFs copied into the folder). Version 3 adds the report's
 * sections (every version of each, hers and the AI's) and her notes for the session.
 * Version 4 adds the case map (src/main/case-map.ts), which a case has only once she
 * drafts or types one. Later phases add their own top-level keys and raise the version,
 * with a migration.
 *
 * Rules that keep a user's data safe:
 * - A key this version does not know is kept as it is when the file is saved.
 * - A file with a higher schemaVersion (a newer app wrote it) is never written to.
 * - An older file is migrated in memory, one version at a time (MIGRATIONS); it is
 *   written in the current version only when the case is next saved.
 */

export const CASE_FILE_NAME = "aba-case.json";
/** Raise it, and add a step to MIGRATIONS, when the shape changes. */
export const CASE_SCHEMA_VERSION = 4;
/**
 * A data file larger than this is not one the app wrote, and a save that would make one
 * is refused. Pasted texts live in the file: a case with a dozen long reports is a few
 * megabytes.
 */
export const MAX_CASE_FILE_BYTES = 50_000_000;
/** The most PDFs a case lists. */
export const MAX_LISTED_FILES = 10_000;

/** UTC only, as the app writes it ("2026-11-22T15:00:00.000Z"). */
const TimestampSchema = z.iso.datetime();

/** The age the interface sends for a new case: nothing else is accepted. */
export const ClientAgeSchema = z.strictObject({
  years: z.int().min(0).max(MAX_CLIENT_AGE_YEARS),
  months: z.int().min(0).max(11).optional(),
});

/** The age as stored: a key a later version adds is kept, like everywhere else in the file. */
const StoredClientAgeSchema = z.looseObject(ClientAgeSchema.shape);

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

/** A source's title is stored already checked: reading refuses one checkSourceTitle would change. */
const StoredSourceTitleSchema = z
  .string()
  .max(1000)
  .refine((value) => {
    const checked = checkSourceTitle(value);
    return checked.ok && checked.title === value;
  });

/** A file name inside the case's folder: one plain name, never a path. */
const StoredFileNameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((name) => name !== "." && name !== ".." && !/[/\\\p{Cc}]/u.test(name));

/*
 * A source (version 2). The type is kept as written, even one this version does not know
 * (a newer app's), so a save never changes it; the interface shows an unknown one as
 * "other". "removedAt" marks a source the clinician removed: it stays in the file, with
 * its text, and its PDF stays in the folder (nothing is ever deleted).
 */
const SourceShape = {
  id: z.string().refine(isCaseId),
  type: z
    .string()
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/),
  title: StoredSourceTitleSchema.optional(),
  date: z.string().refine(isSourceDate).optional(),
  addedAt: TimestampSchema,
  updatedAt: TimestampSchema,
  removedAt: TimestampSchema.optional(),
};

const TextSourceSchema = z.looseObject({
  ...SourceShape,
  kind: z.literal("text"),
  text: z.string().max(MAX_SOURCE_TEXT_LENGTH),
});

const PdfSourceSchema = z.looseObject({
  ...SourceShape,
  kind: z.literal("pdf"),
  /** The copy's name in the case's folder. */
  file: StoredFileNameSchema,
  bytes: z.int().min(0),
});

const SourceSchema = z.discriminatedUnion("kind", [TextSourceSchema, PdfSourceSchema]);
export type StoredSource = z.infer<typeof SourceSchema>;
export type StoredTextSource = z.infer<typeof TextSourceSchema>;
export type StoredPdfSource = z.infer<typeof PdfSourceSchema>;

/*
 * The report's sections (version 3), by section id. Each keeps every version ever made,
 * hers and the AI's: nothing is removed or rewritten, except the version she is typing in
 * (her pasted text, or an edit), which is updated as she types. "currentVersion" is the
 * one shown, "approvedVersion" the one she approved.
 */
const VersionNumberSchema = z.int().min(1).max(1_000_000);

/** The tokens of one AI request, as the provider reported them (src/lib/providers/types.ts, TokenUsage). */
const UsageRecordSchema = z.looseObject({
  uncachedInputTokens: z.int().min(0),
  cacheWriteTokens: z.int().min(0),
  cacheReadTokens: z.int().min(0),
  outputTokens: z.int().min(0),
  /** The reasoning share of outputTokens, when the provider reports it (absent in files written before it was kept). */
  reasoningTokens: z.int().min(0).nullable().optional(),
});

/** What an AI version was made from and by, so any version can be traced back. */
const GenerationRecordSchema = z.looseObject({
  provider: z.string().max(32),
  requestedModel: z.string().max(200),
  servedModel: z.string().max(200),
  effort: z.string().max(16),
  rulesVersions: z.record(z.string().max(100), z.string().max(100)),
  /** The sources sent, by id and title as the model saw them. */
  sourcesUsed: z.array(z.looseObject({ id: z.string().max(64), title: z.string().max(1000) })).max(MAX_SOURCES),
  /** Her other sections sent as context, by id and version. */
  sectionsUsed: z.array(z.looseObject({ id: z.string().max(64), version: VersionNumberSchema })).max(100),
  /** Her standing instructions and session notes as they were sent. */
  instructions: z.string().max(MAX_NOTES_LENGTH * 2).optional(),
  notes: z.string().max(MAX_NOTES_LENGTH * 2).optional(),
  /** Whether the client's details were hidden before sending. */
  deidentified: z.boolean(),
  usage: UsageRecordSchema,
  costUsd: z.number().min(0).nullable(),
});

const StoredVersionSchema = z.looseObject({
  number: VersionNumberSchema,
  /** "hers", "draft", "change", "paragraph", "improve", "edited"; a kind a newer app writes is kept as it is. */
  kind: z.string().regex(/^[a-z][a-z-]{0,31}$/),
  createdAt: TimestampSchema,
  /** Her own text changes while she types in it; AI versions never change. */
  updatedAt: TimestampSchema.optional(),
  basedOn: VersionNumberSchema.optional(),
  /** Her edit of the version she had approved: final for the other sections, like her own text (review round 2, L1). */
  fromApproved: z.literal(true).optional(),
  request: z.string().max(MAX_REQUEST_LENGTH).optional(),
  paragraphIndex: z.int().min(0).max(10_000).optional(),
  text: z.string().max(MAX_SECTION_TEXT_LENGTH),
  generation: GenerationRecordSchema.optional(),
  /** The consistency check run on an AI version right after it was saved. */
  consistency: z
    .looseObject({
      status: z.string().max(32),
      items: z.array(z.string().max(MAX_CONSISTENCY_ITEM_LENGTH)).max(100),
      checkedAt: TimestampSchema,
      model: z.string().max(200).nullable(),
      costUsd: z.number().min(0).nullable(),
      /** Her sections it compared against, by id and version. */
      sectionsCompared: z.array(z.looseObject({ id: z.string().max(64), version: VersionNumberSchema })).max(100),
      /** Her own text of this section it compared against, by version (absent: none, or written before it was compared). */
      ownTextCompared: VersionNumberSchema.nullable().optional(),
      /** The check's tokens, as for a version (absent: no request was answered, or written before they were kept). */
      usage: UsageRecordSchema.optional(),
      /** What the earlier checks of this version cost and used, before "Check again" replaced them (kept in the totals). */
      earlierCostUsd: z.number().min(0).optional(),
      earlierUsage: UsageRecordSchema.optional(),
    })
    .optional(),
});

const StoredSectionSchema = z.looseObject({
  currentVersion: VersionNumberSchema.nullable(),
  approvedVersion: VersionNumberSchema.nullable(),
  approvedAt: TimestampSchema.optional(),
  versions: z
    .array(StoredVersionSchema)
    .max(10_000)
    .refine((versions) => new Set(versions.map((version) => version.number)).size === versions.length),
});

/** Her notes for the session under way: used in every request until she starts a new session. */
const SessionNotesSchema = z.looseObject({
  text: z.string().max(MAX_NOTES_LENGTH),
  startedAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

/** A session's notes after "Start a new session": kept, never shown to the AI again. */
const ArchivedNotesSchema = z.looseObject({
  text: z.string().max(MAX_NOTES_LENGTH),
  startedAt: TimestampSchema,
  updatedAt: TimestampSchema,
  endedAt: TimestampSchema,
});

export type StoredVersion = z.infer<typeof StoredVersionSchema>;
export type StoredSection = z.infer<typeof StoredSectionSchema>;
export type GenerationRecord = z.infer<typeof GenerationRecordSchema>;
export type StoredUsage = z.infer<typeof UsageRecordSchema>;

const CaseFileSchema = z.looseObject({
  schemaVersion: z.literal(CASE_SCHEMA_VERSION),
  id: z.string().refine(isCaseId),
  label: StoredLabelSchema,
  clientAge: StoredClientAgeSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  files: z.array(FileEntrySchema).max(MAX_LISTED_FILES),
  // Each id once: a change names its source by id.
  sources: z
    .array(SourceSchema)
    .max(MAX_SOURCES)
    .refine((sources) => new Set(sources.map((source) => source.id)).size === sources.length),
  // A section id this version does not know (a newer app's) is kept as it is.
  sections: z.record(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/), StoredSectionSchema),
  sessionNotes: SessionNotesSchema.optional(),
  sessionNotesArchive: z.array(ArchivedNotesSchema).max(10_000).optional(),
  /** The case map (version 4): absent until she drafts or types one. */
  caseMap: CaseMapSchema.optional(),
});

/** A case's data, as the app holds it; unknown keys ride along. */
export type CaseData = z.infer<typeof CaseFileSchema>;

/** Turns a version-n file's data into version n+1 (the runner sets schemaVersion). */
export type Migration = (data: Record<string, unknown>) => Record<string, unknown>;

/**
 * MIGRATIONS[n] upgrades a version-n file. A version 1 file is read as version 2 with no
 * sources, a version 2 file as version 3 with no sections, and a version 3 file as
 * version 4 with no case map (D7: no map until she drafts or types one); it is written in
 * the current version only when the case is next saved.
 */
export const MIGRATIONS: Readonly<Record<number, Migration>> = {
  // A key "sources" in a version 1 file (none was ever written) is kept and must then read as version 2's.
  1: (data) => ("sources" in data ? data : { ...data, sources: [] }),
  // A version 2 file has no sections yet; a key "sections" in one (none was ever written) is kept and must read as version 3's.
  2: (data) => ("sections" in data ? data : { ...data, sections: {} }),
  // Nothing to add: the case map is optional. A key "caseMap" in a version 3 file (none was ever written) is kept and must read as version 4's.
  3: (data) => data,
};

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

/**
 * A number written in JSON as a canonical decimal: sign, significant digits and exponent
 * ("-0.0150" and "-1.5e-2" both give "-15e-3"). Zero is "0" or "-0".
 */
function canonicalNumber(token: string): string {
  const match = /^(-?)([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(token);
  if (!match) return token;
  const [, sign, whole, fraction = "", exponent = "0"] = match;
  let digits = `${whole}${fraction}`.replace(/^0+/, "");
  if (digits === "") return `${sign}0`;
  let power = Number(exponent) - fraction.length;
  const trimmed = digits.replace(/0+$/, "");
  power += digits.length - trimmed.length;
  digits = trimmed;
  return `${sign}${digits}e${power}`;
}

/**
 * Whether a JSON number token reads back as itself: a save writes the number JSON.parse
 * made of it, which must be the same value. Not so for one too large for any number
 * (1e400), one that loses digits (2^53 + 1, 0.30000000000000000001, 1e-400 read as 0), or
 * -0 (written back as 0). Numbers the app writes always pass: they come from JSON.stringify.
 */
export function numberReadsExactly(token: string): boolean {
  const value = Number(token);
  if (!Number.isFinite(value)) return false;
  return canonicalNumber(token) === canonicalNumber(JSON.stringify(value));
}

/**
 * Whether JSON.parse kept everything in `text`, so a save would write back all of it.
 * It does not when an object repeats a key (the last one wins), when a key is "__proto__"
 * (rebuilding the object turns it into the object's prototype, and a save drops it), or
 * when a number does not read back as itself (numberReadsExactly). `text` must already
 * be valid JSON. A file that fails this is damaged and never written to.
 */
export function parsesWithoutLoss(text: string): boolean {
  const stack: Array<{ keys: Set<string> | null; expectKey: boolean }> = [];
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === '"') {
      let end = i + 1;
      while (text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      const top = stack.at(-1);
      if (top?.keys && top.expectKey) {
        const key = JSON.parse(text.slice(i, end + 1)) as string;
        if (key === "__proto__" || top.keys.has(key)) return false;
        top.keys.add(key);
        top.expectKey = false;
      }
      i = end + 1;
    } else if (char === "{" || char === "[") {
      stack.push({ keys: char === "{" ? new Set() : null, expectKey: char === "{" });
      i++;
    } else if (char === "}" || char === "]") {
      stack.pop();
      i++;
    } else if (char === ",") {
      const top = stack.at(-1);
      if (top?.keys) top.expectKey = true;
      i++;
    } else if (char === "-" || (char >= "0" && char <= "9")) {
      let end = i + 1;
      while (end < text.length && /[0-9.eE+-]/.test(text[end])) end++;
      if (!numberReadsExactly(text.slice(i, end))) return false;
      i = end;
    } else {
      i++;
    }
  }
  return true;
}

/** Decodes a data file's bytes. Null when they are not valid UTF-8: nothing is replaced or guessed. */
export function decodeCaseFile(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Reads a data file. Never throws: a file it cannot use is "damaged" or "newer-version".
 * Bytes that are not valid UTF-8 (a file saved as Latin-1, say), repeated keys and
 * numbers JSON cannot hold exactly make it damaged, so it is never rewritten with less
 * than it held.
 */
export function readCaseFile(input: string | Uint8Array): ReadCaseFileResult {
  const text = typeof input === "string" ? input : decodeCaseFile(input);
  if (text === null) return { ok: false, problem: "damaged" };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, problem: "damaged" };
  }
  if (!parsesWithoutLoss(text)) return { ok: false, problem: "damaged" };
  const migrated = migrateCaseData(json);
  if (!migrated.ok) return migrated;
  const parsed = CaseFileSchema.safeParse(migrated.data);
  if (!parsed.success) return { ok: false, problem: "damaged" };
  return { ok: true, data: parsed.data, migratedFrom: migrated.migratedFrom };
}

/** A source's keys in a fixed order (optional ones only when present), then any others as they were. */
function orderedSource(source: StoredSource): Record<string, unknown> {
  const { id, kind, type, title, date, addedAt, updatedAt, removedAt, ...rest } = source;
  const optional = { ...(title === undefined ? {} : { title }), ...(date === undefined ? {} : { date }) };
  const head = { id, kind, type, ...optional, addedAt, updatedAt, ...(removedAt === undefined ? {} : { removedAt }) };
  if (source.kind === "text") {
    const { text, ...others } = rest as { text: string };
    return { ...head, text, ...others };
  }
  const { file, bytes, ...others } = rest as { file: string; bytes: number };
  return { ...head, file, bytes, ...others };
}

/** The file's text: the known keys first, in a fixed order, then any others as they were. */
export function serializeCaseFile(data: CaseData): string {
  const { schemaVersion, id, label, clientAge, createdAt, updatedAt, files, sources, sessionNotes, sessionNotesArchive, sections, caseMap, ...rest } = data;
  const ordered = {
    schemaVersion,
    id,
    label,
    ...(clientAge ? { clientAge } : {}),
    createdAt,
    updatedAt,
    files,
    sources: sources.map(orderedSource),
    ...(sessionNotes ? { sessionNotes } : {}),
    ...(sessionNotesArchive ? { sessionNotesArchive } : {}),
    sections,
    ...(caseMap ? { caseMap } : {}),
    ...rest,
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/**
 * The file's text, only when it reads back whole under the same rules it is read with
 * (readCaseFile: UTF-8, lossless JSON, the schema and every limit in it); null otherwise.
 * Every write of a data file goes through it, so nothing the app writes can make a case
 * unreadable: a value past a limit (a model's answer longer than the schema allows, say)
 * refuses the save instead of locking the clinician out of the whole case.
 */
export function readableCaseFileText(data: CaseData): string | null {
  const text = serializeCaseFile(data);
  const read = readCaseFile(text);
  return read.ok && read.migratedFrom === null ? text : null;
}

/** A new case's data. */
export function newCaseData(options: { id: string; label: string; clientAge: ClientAge | null; now: Date; files?: CaseFile[] }): CaseData {
  const time = options.now.toISOString();
  return {
    schemaVersion: CASE_SCHEMA_VERSION,
    id: options.id,
    label: options.label,
    ...(options.clientAge ? { clientAge: { ...options.clientAge } } : {}),
    createdAt: time,
    updatedAt: time,
    files: (options.files ?? []).map((file) => ({ ...file })),
    sources: [],
    sections: {},
  };
}

/**
 * The next updatedAt: now, or a millisecond after the last one if the clock says
 * otherwise (it went back, or two saves fell in the same millisecond), so it always moves.
 */
export function nextUpdatedAt(previous: string, now: Date): string {
  return new Date(Math.max(now.getTime(), Date.parse(previous) + 1)).toISOString();
}
