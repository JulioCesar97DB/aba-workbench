/*
 * The PdfReader the app uses: Mozilla's PDF.js (pdfjs-dist, Apache-2.0), its Node.js
 * build, bundled into the main process like the other packages (owner's decision,
 * 2026-11-22). It only reads text:
 * - its worker runs in this thread (the bundled module is handed to PDF.js, so no
 *   worker file is loaded from disk and no thread is started);
 * - no code from the PDF runs: this version of PDF.js no longer compiles fonts into
 *   JavaScript (the path of CVE-2024-4367; its isEvalSupported option is gone, checked in
 *   pdfjs-dist 6.5.438), and the PDF's own scripts and XFA forms are never run;
 * - fonts are not loaded and nothing is drawn; no file, URL or network is used.
 * At first use PDF.js warns once that it cannot set up drawing (no canvas): expected.
 */
import { getDocument, type PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import * as worker from "pdfjs-dist/legacy/build/pdf.worker.mjs";
import { PdfReadError, type PdfReader } from "./extract.ts";
import type { TextPiece } from "./layout.ts";

(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker;

/** PDF.js's error names for a password and for a file that is not a valid PDF. */
function readError(error: unknown): PdfReadError | unknown {
  const name = (error as { name?: string } | null)?.name;
  if (name === "PasswordException") return new PdfReadError("password");
  if (name === "InvalidPDFException") return new PdfReadError("damaged");
  return error;
}

export const pdfjsReader: PdfReader = {
  async open(bytes, signal) {
    const task = getDocument({
      // PDF.js takes over the buffer it is given: give it a copy.
      data: bytes.slice(),
      enableXfa: false,
      disableFontFace: true,
      useSystemFonts: false,
      useWorkerFetch: false,
      isOffscreenCanvasSupported: false,
      isImageDecoderSupported: false,
      stopAtErrors: false,
      // Errors only: the warnings PDF.js prints about odd but readable files are noise.
      verbosity: 0,
    });
    const abort = () => void task.destroy();
    signal.addEventListener("abort", abort, { once: true });
    let doc: PDFDocumentProxy;
    try {
      doc = await task.promise;
    } catch (error) {
      signal.removeEventListener("abort", abort);
      await task.destroy();
      throw readError(error);
    }
    return {
      pageCount: doc.numPages,
      async page(number: number): Promise<TextPiece[]> {
        const page = await doc.getPage(number);
        try {
          const content = await page.getTextContent();
          const pieces: TextPiece[] = [];
          for (const item of content.items) {
            if (!("str" in item)) continue;
            pieces.push({ str: item.str, x: item.transform[4], y: item.transform[5], width: item.width, height: item.height || Math.hypot(item.transform[2], item.transform[3]) });
          }
          return pieces;
        } finally {
          page.cleanup();
        }
      },
      async close() {
        signal.removeEventListener("abort", abort);
        await task.destroy();
      },
    };
  },
};
