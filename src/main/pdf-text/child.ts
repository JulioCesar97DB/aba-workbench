/*
 * The process that reads one PDF (owner's decision, 2026-11-22): started by the main
 * process for each PDF, sent its bytes and limits, answers with the result, and exits.
 * A hostile PDF can only exhaust this process: it has its own heap cap, and the main
 * process kills it at a hard time limit (isolated.ts).
 *
 * Runs as an Electron utility process in the app (`process.parentPort`), and as a Node.js
 * child process in the unit tests (`process.send`): the same messages either way.
 */
import { extractPdfText, type PdfReadLimits } from "./extract.ts";
import { pdfjsReader } from "./pdfjs-reader.ts";

export interface ChildRequest {
  bytes: Uint8Array;
  limits: PdfReadLimits;
}

interface ParentPort {
  on(event: "message", listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;

function send(message: unknown): void {
  if (parentPort) parentPort.postMessage(message);
  else process.send?.(message);
}

async function handle(message: unknown): Promise<void> {
  const request = message as ChildRequest;
  const result = await extractPdfText(new Uint8Array(request.bytes), pdfjsReader, request.limits);
  send(result);
}

if (parentPort) parentPort.on("message", (event) => void handle(event.data));
else process.on("message", (message) => void handle(message));
