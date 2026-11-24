/*
 * A case's sources: what the assessment is drafted from. Shared by the main process
 * (src/main/case-sources.ts keeps them in aba-case.json) and the interface (the Sources
 * step). Plain data and checks only: no Node.js, no Electron.
 *
 * A source is either a text the clinician pasted (a CDE, her parent interview notes...)
 * or a PDF copied into the case's folder (a Vineland-3 or BASC-3 score report...). Each
 * has a type from SOURCE_TYPES, and optionally a short title and a date.
 */

/**
 * The types a source can have, as stored (stable ids: never rename one). One list for
 * pasted texts and PDFs. Their names are clinical terms, English in both languages
 * (SOURCE_TYPE_NAMES); "other" is the one the screen translates.
 */
export const SOURCE_TYPES = ["cde", "parent-interview", "direct-observation", "fba-questionnaire", "iep", "vineland-3", "basc-3", "ablls-r", "other"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

/** How the clinician and her forms name each type. "other" is translated by the screen. */
export const SOURCE_TYPE_NAMES: Record<Exclude<SourceType, "other">, string> = {
  cde: "CDE",
  "parent-interview": "Parent interview",
  "direct-observation": "Direct observation",
  "fba-questionnaire": "FBA questionnaire",
  iep: "IEP",
  "vineland-3": "Vineland-3",
  "basc-3": "BASC-3",
  "ablls-r": "ABLLS-R",
};

export function isSourceType(value: unknown): value is SourceType {
  return typeof value === "string" && (SOURCE_TYPES as readonly string[]).includes(value);
}

/**
 * A PDF's type, guessed from its file name ("Vineland-3 report.pdf" is a Vineland-3);
 * "other" when nothing matches. The clinician can change it.
 */
export function guessPdfType(fileName: string): SourceType {
  const name = fileName.toLowerCase();
  if (/vineland/.test(name)) return "vineland-3";
  if (/basc/.test(name)) return "basc-3";
  if (/ablls/.test(name)) return "ablls-r";
  if (/(^|[^a-z])iep([^a-z]|$)/.test(name)) return "iep";
  if (/(^|[^a-z])cde([^a-z]|$)|diagnostic/.test(name)) return "cde";
  if (/(^|[^a-z])(fba|qabf)([^a-z]|$)/.test(name)) return "fba-questionnaire";
  // FAST and MAS only as acronyms in capitals: "Fast track summary" is not a questionnaire.
  if (/(^|[^A-Za-z])(FAST|MAS)([^A-Za-z]|$)/.test(fileName)) return "fba-questionnaire";
  return "other";
}

/** The most characters one pasted text holds (a long CDE is about 100,000). */
export const MAX_SOURCE_TEXT_LENGTH = 1_000_000;
/** The most sources one case holds, removed ones included. */
export const MAX_SOURCES = 500;
export const MAX_SOURCE_TITLE_LENGTH = 120;
/** The largest PDF the app copies into a case: over any provider's limit, so it could never be sent anyway. */
export const MAX_PDF_BYTES = 200_000_000;

export type SourceTitleProblem = "too-long" | "control-characters";

/**
 * A source's title as it is saved: Unicode NFC, no spaces at either end, at most
 * MAX_SOURCE_TITLE_LENGTH characters, no control or text-direction characters. Empty
 * means no title (null): the screen then names the source by its type or file.
 */
export function checkSourceTitle(raw: string): { ok: true; title: string | null } | { ok: false; problem: SourceTitleProblem } {
  const title = raw.normalize("NFC").trim();
  if (title === "") return { ok: true, title: null };
  if (/[\p{Cc}\u{200E}\u{200F}\u{202A}-\u{202E}\u{2066}-\u{2069}]/u.test(title)) return { ok: false, problem: "control-characters" };
  if ([...title].length > MAX_SOURCE_TITLE_LENGTH) return { ok: false, problem: "too-long" };
  return { ok: true, title };
}

/** A calendar date as stored and as a date field gives it: "2026-10-02", a real day from 1900 to 2100. */
export function isSourceDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (year < 1900 || year > 2100) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Whether bytes look like a PDF: "%PDF-" within the first 1024 bytes, as PDF readers accept. */
export function looksLikePdf(bytes: Uint8Array): boolean {
  const marker = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"
  const end = Math.min(bytes.byteLength, 1024) - marker.length;
  for (let i = 0; i <= end; i++) if (marker.every((byte, j) => bytes[i + j] === byte)) return true;
  return false;
}

/** A pasted text as it is saved: line endings made "\n" (Windows pastes "\r\n"); nothing else changes. */
export function normalizeSourceText(raw: string): string {
  return raw.replace(/\r\n?/g, "\n");
}

/**
 * Whether a PDF is over what a provider accepts in one request, by its size alone:
 * "over-chatgpt" when OpenAI would refuse it (its 50 MB of files per request counts the
 * base64 text, about 37.5 MB of PDF), "over-all" when Claude would too (128 MB per
 * request, about 96 MB of PDF). Computed in the main process from src/lib/limits.ts.
 */
export type PdfSizeWarning = "over-chatgpt" | "over-all";

interface SourceSummaryBase {
  id: string;
  /** A type this version does not know (a newer app wrote it) is shown as "other" and kept in the file. */
  type: SourceType;
  title: string | null;
  /** "2026-10-02", or null. */
  date: string | null;
  addedAt: string;
  updatedAt: string;
  /** When it was removed from the case; null while it is one of the case's sources. */
  removedAt: string | null;
}

/** A source as the list shows it: never a pasted text's whole text (readSourceText gives it). */
export type SourceSummary =
  | (SourceSummaryBase & {
      kind: "text";
      /** Its length, in characters. */
      characters: number;
      /** Its first words, on one line, to recognize it. */
      preview: string;
    })
  | (SourceSummaryBase & {
      kind: "pdf";
      /** The copy's name in the case's folder. */
      fileName: string;
      bytes: number;
      /** False when the file is no longer in the case's folder (moved or renamed in Finder or Explorer). */
      present: boolean;
      sizeWarning: PdfSizeWarning | null;
    });

/** A case's sources and the PDFs in its folder, as the Sources step shows them. */
export interface CaseSources {
  /** Oldest first, removed ones included (removedAt). */
  sources: SourceSummary[];
  /** Every PDF at the top of the case's folder, by name. */
  files: Array<{ name: string; bytes: number; modifiedAt: string }>;
  /** The PDFs of the case's sources together, when that is over a provider's limit for one request. */
  totalPdfWarning: PdfSizeWarning | null;
  /** The largest PDF ChatGPT and Claude take in one request, in bytes, for the warnings' words. */
  pdfLimits: { chatgpt: number; claude: number };
  updatedAt: string;
}

/** What the clinician fills in for a new pasted text. */
export interface NewTextSource {
  type: SourceType;
  title?: string | null;
  date?: string | null;
  text: string;
}

/** A change to a source: only the keys given change. "text" only for a pasted text. */
export interface SourceChange {
  type?: SourceType;
  title?: string | null;
  date?: string | null;
  text?: string;
}

/** Why the case could not be changed: it is gone, unreadable or the cases folder cannot be used. */
export type SourceSaveFailure =
  /** The data file could not be written (a full disk, a read-only folder): nothing changed. */
  | { outcome: "not-saved" }
  /** The case's data file would grow past what the app reads back (MAX_CASE_FILE_BYTES): nothing changed. */
  | { outcome: "case-full" }
  /** The case is gone, unreadable, or the cases folder cannot be used. */
  | { outcome: "case-unavailable" }
  | { outcome: "source-not-found" };

export type SourceSaveResult = { outcome: "saved"; sources: CaseSources; sourceId: string } | SourceSaveFailure;

/** Why one PDF was not added. */
export type PdfProblem =
  | "not-a-pdf"
  | "too-large"
  | "cannot-read"
  /** Writing the copy into the case's folder failed (a full disk, say). */
  | "not-copied"
  /** Its exact bytes are already one of the case's sources. */
  | "already-added"
  /** Its exact bytes are a source the clinician removed: restore that one instead. */
  | "already-removed"
  | "too-many-sources";

export type AddPdfsResult =
  | {
      outcome: "done";
      sources: CaseSources;
      /** The new sources' ids. */
      added: string[];
      /** By the name the PDF had where it came from. */
      problems: Array<{ name: string; problem: PdfProblem }>;
    }
  | { outcome: "cancelled" }
  /**
   * PDFs were copied into the case's folder but the data file could not be saved: they are
   * not sources, and stay in the folder (nothing is deleted), in the Documents step's card for the PDFs in the folder not added.
   */
  | { outcome: "copied-not-added"; files: string[]; sources: CaseSources }
  | SourceSaveFailure;

/** A PDF dropped onto the window: its name and bytes, read by the interface. Never a path. */
export interface DroppedPdf {
  name: string;
  data: Uint8Array;
}

/**
 * A change to a case's sources that could not be saved, as the main process keeps it
 * (src/main/failed-saves.ts) until it is saved: a reload of the window does not forget it.
 */
/** Why a change could not be saved, as the interface explains it. */
export type FailedSaveFailure = Exclude<SourceSaveResult["outcome"], "saved"> | "error";

export interface FailedSave {
  id: string;
  caseId: string;
  /** The case's label, or null when the app has not seen the case (its folder is gone, say). */
  label: string | null;
  failure: FailedSaveFailure;
  /** What it changes: a source, a report section's text, her instructions for a section, her session notes, or an item of the case map. */
  about: "source" | "section" | "instructions" | "notes" | "map";
  /** The section, for "section" and "instructions". */
  sectionId: string | null;
  /** What she typed, kept while it is not saved (a section's text, instructions, notes): the box it came from shows it again after a reload. Null for a source's change. */
  text: string | null;
  /** For a section's text or a map item: the version that editing pass was writing to, or null. */
  editing: number | null;
  /** For a map item: "<part>/<items or groups>/<item id>"; null otherwise. */
  mapItem: string | null;
  /**
   * For a section's text: it came from a box of "Pegar lo que ya escribiste" (saved as "hers", also over an AI draft).
   * The paste screen puts back only these, and the section screen saves one it puts back with the same flag, so the
   * flag never changes when a kept text moves between the two screens (UX-6 review round 2, S1). False otherwise.
   */
  pasted: boolean;
}

export type ReadSourceTextResult = { outcome: "read"; text: string } | { outcome: "source-not-found" } | { outcome: "case-unavailable" };
