/*
 * A PDF's text, extracted on the clinician's computer: the PDF itself is never sent.
 * Pages are marked "--- Page 2 of 3 ---", tables keep one row per line (layout.ts),
 * and a page with no text layer (a scan, a photo) is marked as such, so the interface
 * can ask her to paste those scores instead. The library that reads the PDF is
 * behind PdfReader, so this logic is tested without it.
 */
import { garbledShare, pageText, readableCharacters, type TextPiece } from "./layout.ts";

export interface PdfReadLimits {
  maxPages: number;
  /** Milliseconds for the whole document. */
  timeoutMs: number;
}

export const DEFAULT_LIMITS: PdfReadLimits = { maxPages: 300, timeoutMs: 60_000 };

/** Opens a PDF and hands back each page's positioned text. Throws a PdfReadError when it cannot; stops when `signal` aborts. */
export interface PdfReader {
  open(bytes: Uint8Array, signal: AbortSignal): Promise<{ pageCount: number; page(number: number): Promise<TextPiece[]>; close(): Promise<void> }>;
}

export type UnreadableReason = "not-a-pdf" | "password" | "damaged" | "too-many-pages" | "timed-out";

export class PdfReadError extends Error {
  readonly reason: UnreadableReason;
  constructor(reason: UnreadableReason) {
    super(`PDF unreadable: ${reason}`);
    this.reason = reason;
  }
}

export type PdfTextResult =
  /** Text found. `pagesWithoutText` lists pages (1-based) that had none: probably scanned. */
  | { status: "text"; text: string; pageCount: number; pagesWithoutText: number[] }
  /** No page has text: almost always a scan. The interface asks her to paste the scores. */
  | { status: "no-text"; pageCount: number }
  | { status: "unreadable"; reason: UnreadableReason };

/** Fewer letters and digits than this, and a page counts as having no text. */
export const MIN_PAGE_CHARACTERS = 20;
/** More than this share of unreadable glyphs, and a page counts as having no text. */
export const MAX_GARBLED_SHARE = 0.3;

export const NO_TEXT_NOTE = "[No text on this page: it is probably a scanned image. Its content is not included.]";

export async function extractPdfText(bytes: Uint8Array, reader: PdfReader, limits: PdfReadLimits = DEFAULT_LIMITS): Promise<PdfTextResult> {
  if (!looksLikePdf(bytes)) return { status: "unreadable", reason: "not-a-pdf" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = new AbortController();
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // The reader stops and frees the document; reading resolves as timed out at once.
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
    for (let n = 1; n <= doc.pageCount; n++) {
      if (signal.aborted) throw new PdfReadError("timed-out");
      const text = pageText(await doc.page(n));
      const empty = readableCharacters(text) < MIN_PAGE_CHARACTERS || garbledShare(text) > MAX_GARBLED_SHARE;
      if (empty) pagesWithoutText.push(n);
      parts.push(`--- Page ${n} of ${doc.pageCount} ---\n${empty ? NO_TEXT_NOTE : text}`);
    }
    if (doc.pageCount === 0 || pagesWithoutText.length === doc.pageCount) return { status: "no-text", pageCount: doc.pageCount };
    return { status: "text", text: parts.join("\n\n"), pageCount: doc.pageCount, pagesWithoutText };
  } finally {
    await doc.close();
  }
}

/** "%PDF-" in the first kilobyte, as PDF readers accept. */
export function looksLikePdf(bytes: Uint8Array): boolean {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  return head.includes("%PDF-");
}
