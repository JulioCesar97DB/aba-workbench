/*
 * A PDF's text, extracted on the clinician's computer: the PDF itself is never sent.
 * Pages are marked "--- Page 2 of 3 ---", tables keep one row per line (layout.ts),
 * and a page with no text layer (a scan, a photo) is marked as such, so the interface
 * can ask her to paste those scores instead. A page with letter-spaced or overlapping
 * text is listed in `pagesNeedingReview`.
 *
 * In the app this runs in a separate process (isolated.ts), which the main process kills
 * at a hard time limit or above a memory limit; the limits here (bytes, pages, characters)
 * refuse a large PDF before or between pages, but a single page is parsed whole before
 * its text can be counted, so a one-page bomb runs until the time or memory limit. The
 * library that reads the PDF is behind PdfReader, so this logic is tested without it.
 */
import { garbledShare, layoutPage, readableCharacters, type TextPiece } from "./layout.ts";

export interface PdfReadLimits {
  /** The largest file accepted, in bytes. */
  maxBytes: number;
  maxPages: number;
  /** Characters of text on one page, and in the whole document. */
  maxPageCharacters: number;
  maxCharacters: number;
  /** Milliseconds for the whole document. */
  timeoutMs: number;
}

export const DEFAULT_LIMITS: PdfReadLimits = { maxBytes: 20 * 1024 * 1024, maxPages: 300, maxPageCharacters: 200_000, maxCharacters: 2_000_000, timeoutMs: 30_000 };

/** Opens a PDF and hands back each page's positioned text. Throws a PdfReadError when it cannot; stops when `signal` aborts. */
export interface PdfReader {
  open(bytes: Uint8Array, signal: AbortSignal): Promise<{
    pageCount: number;
    /** The page's text pieces; throws PdfReadError("too-large") past `maxCharacters`. */
    page(number: number, maxCharacters: number): Promise<TextPiece[]>;
    close(): Promise<void>;
  }>;
}

export type UnreadableReason = "not-a-pdf" | "password" | "damaged" | "too-many-pages" | "too-large" | "timed-out" | "crashed";

export class PdfReadError extends Error {
  readonly reason: UnreadableReason;
  constructor(reason: UnreadableReason) {
    super(`PDF unreadable: ${reason}`);
    this.reason = reason;
  }
}

export type PdfTextResult =
  /**
   * Text found. `pagesWithoutText` lists pages (1-based) that had none: probably scanned.
   * `pagesNeedingReview` lists pages whose text was letter-spaced or overlapping: rebuilt, but worth a look.
   */
  | { status: "text"; text: string; pageCount: number; pagesWithoutText: number[]; pagesNeedingReview: number[] }
  /** No page has text: almost always a scan. The interface asks her to paste the scores. */
  | { status: "no-text"; pageCount: number }
  | { status: "unreadable"; reason: UnreadableReason };

/** Fewer letters and digits than this, and a page counts as having no text. */
export const MIN_PAGE_CHARACTERS = 20;
/** More than this share of unreadable glyphs, and a page counts as having no text. */
export const MAX_GARBLED_SHARE = 0.3;

export const NO_TEXT_NOTE = "[No text on this page: it is probably a scanned image. Its content is not included.]";

export async function extractPdfText(bytes: Uint8Array, reader: PdfReader, limits: PdfReadLimits = DEFAULT_LIMITS): Promise<PdfTextResult> {
  if (bytes.length > limits.maxBytes) return { status: "unreadable", reason: "too-large" };
  if (!looksLikePdf(bytes)) return { status: "unreadable", reason: "not-a-pdf" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = new AbortController();
  // A soft limit: it can only fire between PDF.js's steps. The hard one is the process kill (isolated.ts).
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      stop.abort();
      reject(new PdfReadError("timed-out"));
    }, limits.timeoutMs);
  });
  try {
    return await Promise.race([read(bytes, reader, limits, stop.signal), timeout]);
  } catch (error) {
    if (error instanceof PdfReadError) return { status: "unreadable", reason: error.reason };
    return { status: "unreadable", reason: "damaged" };
  } finally {
    clearTimeout(timer);
  }
}

async function read(bytes: Uint8Array, reader: PdfReader, limits: PdfReadLimits, signal: AbortSignal): Promise<PdfTextResult> {
  const doc = await reader.open(bytes, signal);
  try {
    if (doc.pageCount > limits.maxPages) return { status: "unreadable", reason: "too-many-pages" };
    const parts: string[] = [];
    const pagesWithoutText: number[] = [];
    const pagesNeedingReview: number[] = [];
    let total = 0;
    for (let n = 1; n <= doc.pageCount; n++) {
      if (signal.aborted) throw new PdfReadError("timed-out");
      const budget = Math.min(limits.maxPageCharacters, limits.maxCharacters - total);
      if (budget <= 0) throw new PdfReadError("too-large");
      const { text, needsReview } = layoutPage(await doc.page(n, budget));
      total += text.length;
      const empty = readableCharacters(text) < MIN_PAGE_CHARACTERS || garbledShare(text) > MAX_GARBLED_SHARE;
      if (empty) pagesWithoutText.push(n);
      else if (needsReview) pagesNeedingReview.push(n);
      parts.push(`--- Page ${n} of ${doc.pageCount} ---\n${empty ? NO_TEXT_NOTE : text}`);
    }
    if (doc.pageCount === 0 || pagesWithoutText.length === doc.pageCount) return { status: "no-text", pageCount: doc.pageCount };
    return { status: "text", text: parts.join("\n\n"), pageCount: doc.pageCount, pagesWithoutText, pagesNeedingReview };
  } finally {
    await doc.close();
  }
}

/** "%PDF-" in the first kilobyte, as PDF readers accept. */
export function looksLikePdf(bytes: Uint8Array): boolean {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  return head.includes("%PDF-");
}
