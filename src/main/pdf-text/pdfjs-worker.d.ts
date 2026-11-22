// PDF.js's worker module ships without type declarations; the reader only hands it to PDF.js.
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs" {
  export const WorkerMessageHandler: unknown;
}
