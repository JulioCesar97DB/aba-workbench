/**
 * Checks the PDF reading process inside real Electron, through the app's own code:
 * spawnElectronPdfChild (src/main/pdf-text/electron-child.ts: its flags, its environment, its
 * memory watch) and extractPdfTextIsolated (src/main/pdf-text/isolated.ts: its hard time limit),
 * with the built child (out/main/pdf-text-child.js). It reads an invented fixture, reports a
 * scan, stops a text bomb without blocking the main process, kills a whitespace bomb at the
 * memory limit, gives the child its heap cap, its refusal of code built from strings and none of
 * the app's environment, and an out-of-memory ends only the child.
 * Run with: pnpm check:pdf-reader (builds the app and this script first). No window opens.
 */
import { app } from "electron";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { spawnElectronPdfChild } from "../src/main/pdf-text/electron-child.ts";
import { DEFAULT_LIMITS, type PdfTextResult } from "../src/main/pdf-text/extract.ts";
import { CHILD_MEMORY_LIMIT_MB, extractPdfTextIsolated } from "../src/main/pdf-text/isolated.ts";

// pnpm runs the check from the repository's root.
const root = process.cwd();
const child = path.join(root, "out", "main", "pdf-text-child.js");
const failures: string[] = [];

function check(name: string, ok: boolean, detail: unknown): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(detail)}`);
  if (!ok) failures.push(name);
}

async function read(bytes: Uint8Array, timeoutMs = DEFAULT_LIMITS.timeoutMs): Promise<PdfTextResult & { ms: number }> {
  const started = Date.now();
  const result = await extractPdfTextIsolated(bytes, () => spawnElectronPdfChild(child), { ...DEFAULT_LIMITS, timeoutMs });
  return { ...result, ms: Date.now() - started };
}

/** Runs a probe script with the app's own spawn: what it answers, or how it ended. */
function probe(script: string): Promise<unknown> {
  return new Promise((resolve) => {
    const handle = spawnElectronPdfChild(script);
    const timer = setTimeout(() => {
      handle.kill();
      resolve({ ended: "timed-out" });
    }, 30_000);
    handle.onMessage((message) => {
      clearTimeout(timer);
      handle.kill();
      resolve(message);
    });
    handle.onExit((code, reason) => {
      clearTimeout(timer);
      resolve({ ended: reason ?? "crashed", code });
    });
    handle.postMessage("go");
  });
}

function onePage(content: Buffer): Uint8Array {
  const data = deflateSync(content);
  const objects: Array<string | Buffer> = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    Buffer.concat([Buffer.from(`<< /Filter /FlateDecode /Length ${data.length} >>\nstream\n`), data, Buffer.from("\nendstream")]),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const parts: Buffer[] = [Buffer.from("%PDF-1.7\n")];
  const offsets: number[] = [];
  let length = parts[0].length;
  objects.forEach((body, i) => {
    const part = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), Buffer.isBuffer(body) ? body : Buffer.from(body), Buffer.from("\nendobj\n")]);
    offsets.push(length);
    length += part.length;
    parts.push(part);
  });
  parts.push(Buffer.from(`xref\n0 6\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`));
  return new Uint8Array(Buffer.concat(parts));
}

// Never hang: any error, or two minutes, ends the check as failed.
const deadline = setTimeout(() => {
  console.log("FAIL the check did not finish within 2 minutes");
  app.exit(1);
}, 120_000);
process.on("unhandledRejection", (error) => {
  console.log(`FAIL ${String(error)}`);
  app.exit(1);
});

app.whenReady().then(async () => {
  const fixture = await read(new Uint8Array(readFileSync(path.join(root, "fixtures", "cases", "case-a-mateo", "vineland-3.pdf"))));
  check("reads a fixture", fixture.status === "text" && fixture.text.split("\n").includes("Communication | 23 | 62 | 57–67 | 1 | Low"), { status: fixture.status, ms: fixture.ms });

  const scan = await read(new Uint8Array(readFileSync(path.join(root, "fixtures", "pdf-text", "scan.pdf"))));
  check("reports a scan", scan.status === "no-text", scan);

  let lag = 0;
  let last = Date.now();
  const tick = setInterval(() => {
    lag = Math.max(lag, Date.now() - last - 50);
    last = Date.now();
  }, 50);
  const op = Buffer.from("BT /F1 1 Tf 10 10 Td (A) Tj ET\n");
  const bomb = await read(onePage(Buffer.alloc(Math.floor((256 * 1024 * 1024) / op.length) * op.length, op)), 6_000);
  clearInterval(tick);
  check("a text bomb is stopped, the main process never blocked", bomb.status === "unreadable" && bomb.ms < 8_000 && lag < 500, { ...bomb, lagMs: lag });

  // 1.5 GB of spaces once decompressed: well past the memory limit (a 1 GB one peaks right at it, and may finish first).
  const whitespace = await read(onePage(Buffer.alloc(1536 * 1024 * 1024, 0x20)));
  check(`a 1.5 GB whitespace bomb is killed at the memory limit (${CHILD_MEMORY_LIMIT_MB} MB)`, whitespace.status === "unreadable" && whitespace.reason === "too-large" && whitespace.ms < 30_000, whitespace);

  const probes = mkdtempSync(path.join(tmpdir(), "aba-pdf-reader-check-"));
  try {
    const heapScript = path.join(probes, "heap.mjs");
    writeFileSync(
      heapScript,
      'import v8 from "node:v8"; process.parentPort.on("message", () => { let evalBlocked = false; try { new Function("return 1")(); } catch { evalBlocked = true; } process.parentPort.postMessage({ heapMb: Math.round(v8.getHeapStatistics().heap_size_limit / 1048576), evalBlocked, envKeys: Object.keys(process.env).filter((k) => !/^(?:ABA_WORKBENCH_PDF_READER|ELECTRON_.*|__CF_USER_TEXT_ENCODING|MACH_PORT_RENDEZVOUS_PEER_VALDATION)$/.test(k)).length }); });',
    );
    const heap = (await probe(heapScript)) as { heapMb: number; evalBlocked: boolean; envKeys: number };
    check("the child's heap is capped near 1 GB, code from strings is refused, and it sees no environment", heap.heapMb > 900 && heap.heapMb < 1400 && heap.evalBlocked && heap.envKeys === 0, heap);
    const hogScript = path.join(probes, "hog.mjs");
    writeFileSync(hogScript, 'const hoard = []; process.parentPort.on("message", () => { for (;;) hoard.push(new Array(1e6).fill(1)); });');
    const hog = (await probe(hogScript)) as { ended?: string };
    check("a process that eats memory ends, and only it ends", hog.ended === "crashed" || hog.ended === "too-large", hog);
  } finally {
    rmSync(probes, { recursive: true, force: true });
  }

  clearTimeout(deadline);
  if (failures.length) console.log(`${failures.length} check(s) failed`);
  app.exit(failures.length ? 1 : 0);
});
