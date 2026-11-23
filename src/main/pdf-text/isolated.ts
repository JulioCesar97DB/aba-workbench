/*
 * Reads a PDF's text in a separate process (owner's decision, 2026-11-22): one process per
 * PDF, with its own heap cap and a memory limit the parent enforces, killed at a hard time
 * limit. A crash, an out-of-memory, too much memory or a hang ends only that process, and
 * the PDF is reported unreadable ("crashed", "too-large", "timed-out"); the main process
 * and the window never freeze.
 *
 * The process is started through SpawnChild: in the app an Electron utility process
 * (electron-child.ts), in the tests a Node.js child process running child.ts.
 */
import { DEFAULT_LIMITS, looksLikePdf, type PdfReadLimits, type PdfTextResult, type UnreadableReason } from "./extract.ts";

export interface ChildHandle {
  postMessage(message: unknown): void;
  onMessage(listener: (message: unknown) => void): void;
  /** `reason` when the process was ended on purpose ("too-large": it passed its memory limit). */
  onExit(listener: (code: number | null, reason?: UnreadableReason) => void): void;
  kill(): void;
}

export type SpawnChild = () => ChildHandle;

/** The heap cap of the reading process, in MB. */
export const CHILD_HEAP_MB = 1024;
/** Its whole memory (heap, decompressed streams, everything), checked by the parent every 250 ms; above it the process is killed. */
export const CHILD_MEMORY_LIMIT_MB = 1536;
/** V8 flags of the reading process: its heap cap, and no code built from strings (PDF.js 6.5 needs none). */
export const CHILD_JS_FLAGS = `--max-old-space-size=${CHILD_HEAP_MB} --disallow-code-generation-from-strings`;

const REASONS: ReadonlySet<UnreadableReason> = new Set(["not-a-pdf", "password", "damaged", "too-many-pages", "too-large", "timed-out", "crashed"]);
const pageList = (value: unknown) => Array.isArray(value) && value.every((n) => Number.isInteger(n) && n > 0);

/** The child's answer, checked: anything malformed counts as a crash. */
function checked(message: unknown): PdfTextResult {
  const m = message as Record<string, unknown> | null;
  if (m?.status === "text" && typeof m.text === "string" && Number.isInteger(m.pageCount) && pageList(m.pagesWithoutText) && pageList(m.pagesNeedingReview)) {
    return { status: "text", text: m.text, pageCount: m.pageCount as number, pagesWithoutText: m.pagesWithoutText as number[], pagesNeedingReview: m.pagesNeedingReview as number[] };
  }
  if (m?.status === "no-text" && Number.isInteger(m.pageCount)) return { status: "no-text", pageCount: m.pageCount as number };
  if (m?.status === "unreadable" && REASONS.has(m.reason as UnreadableReason)) return { status: "unreadable", reason: m.reason as UnreadableReason };
  return { status: "unreadable", reason: "crashed" };
}

export function extractPdfTextIsolated(bytes: Uint8Array, spawn: SpawnChild, limits: PdfReadLimits = DEFAULT_LIMITS): Promise<PdfTextResult> {
  if (bytes.length > limits.maxBytes) return Promise.resolve({ status: "unreadable", reason: "too-large" });
  if (!looksLikePdf(bytes)) return Promise.resolve({ status: "unreadable", reason: "not-a-pdf" });
  return new Promise((resolve) => {
    let child: ChildHandle;
    try {
      child = spawn();
    } catch {
      resolve({ status: "unreadable", reason: "crashed" });
      return;
    }
    let settled = false;
    const finish = (result: PdfTextResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(result);
    };
    // The hard limit: the process is killed, whatever it is doing.
    const timer = setTimeout(() => finish({ status: "unreadable", reason: "timed-out" }), limits.timeoutMs);
    child.onMessage((message) => finish(checked(message)));
    child.onExit((_code, reason) => finish({ status: "unreadable", reason: reason && REASONS.has(reason) ? reason : "crashed" }));
    // The child's own soft limit comes first, so a slow PDF it can stop gets its proper answer.
    child.postMessage({ bytes, limits: { ...limits, timeoutMs: Math.max(1, limits.timeoutMs - 2_000) } });
  });
}
