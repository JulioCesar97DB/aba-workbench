/**
 * Checks the PDF reading process inside real Electron, where the unit tests cannot go:
 * the built child (out/main/pdf-text-child.js) runs as an Electron utility process with
 * the app's heap flag, reads an invented fixture, reports a scan, survives a text bomb
 * (stopped at the time limit, the main process never blocked), a whitespace bomb is killed
 * at the memory limit, the heap cap and the refusal of code from strings reach the child,
 * it sees none of the app's environment, and an out-of-memory ends only the child. Run with: pnpm check:pdf-reader
 * (builds first). No window opens; the two small probe scripts go to a temporary folder.
 */
import { app, utilityProcess } from "electron";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";

const root = path.resolve(import.meta.dirname, "..");
const child = path.join(root, "out", "main", "pdf-text-child.js");
// The same flags and limits as src/main/pdf-text/isolated.ts and electron-child.ts, read from the source so they cannot drift.
const isolated = readFileSync(path.join(root, "src", "main", "pdf-text", "isolated.ts"), "utf8");
const constant = (name) => Number(isolated.match(new RegExp(`export const ${name} = (\\d+);`))[1]);
const HEAP_MB = constant("CHILD_HEAP_MB");
const MEMORY_LIMIT_MB = constant("CHILD_MEMORY_LIMIT_MB");
const HEAP_FLAG = `--js-flags=--max-old-space-size=${HEAP_MB} --disallow-code-generation-from-strings`;
const LIMITS = { maxBytes: 20 * 1024 * 1024, maxPages: 300, maxPageCharacters: 200_000, maxCharacters: 2_000_000 };

/** One read in a utility process, killed at `timeoutMs` like extractPdfTextIsolated. */
function read(bytes, timeoutMs, script = child, execArgv = [HEAP_FLAG]) {
  return new Promise((resolve) => {
    const started = Date.now();
    const proc = utilityProcess.fork(script, [], { serviceName: "ABA Workbench PDF reader check", execArgv, env: { ABA_WORKBENCH_PDF_READER: "1" }, stdio: "ignore" });
    let done = false;
    let peakMb = 0;
    // The environment and the memory watch of electron-child.ts.
    const watch = setInterval(() => {
      const metric = app.getAppMetrics().find((m) => m.pid === proc.pid);
      if (!metric) return;
      peakMb = Math.max(peakMb, Math.round(metric.memory.workingSetSize / 1024));
      if (metric.memory.workingSetSize > MEMORY_LIMIT_MB * 1024) finish({ status: "unreadable", reason: "too-large" });
    }, 250);
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(watch);
      proc.kill();
      resolve({ ...result, ms: Date.now() - started, peakMb });
    };
    const timer = setTimeout(() => finish({ status: "unreadable", reason: "timed-out" }), timeoutMs);
    proc.on("message", (message) => finish(message));
    proc.on("exit", (code) => finish({ status: "unreadable", reason: "crashed", code }));
    proc.postMessage({ bytes, limits: { ...LIMITS, timeoutMs: Math.max(1, timeoutMs - 2_000) } });
  });
}

function whitespaceBomb(megabytes) {
  return onePage(Buffer.alloc(megabytes * 1024 * 1024, 0x20));
}

function textBomb(megabytes) {
  const op = Buffer.from("BT /F1 1 Tf 10 10 Td (A) Tj ET\n");
  return onePage(Buffer.alloc(Math.floor((megabytes * 1024 * 1024) / op.length) * op.length, op));
}

function onePage(content) {
  const data = deflateSync(content);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    Buffer.concat([Buffer.from(`<< /Filter /FlateDecode /Length ${data.length} >>\nstream\n`), data, Buffer.from("\nendstream")]),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const parts = [Buffer.from("%PDF-1.7\n")];
  const offsets = [];
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

const failures = [];
function check(name, ok, detail) {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(detail)}`);
  if (!ok) failures.push(name);
}

app.whenReady().then(async () => {
  const fixture = new Uint8Array(readFileSync(path.join(root, "fixtures", "cases", "case-a-mateo", "vineland-3.pdf")));
  const text = await read(fixture, 30_000);
  check("reads a fixture", text.status === "text" && text.text.split("\n").includes("Communication | 23 | 62 | 57–67 | 1 | Low"), { status: text.status, ms: text.ms });

  const scan = await read(new Uint8Array(readFileSync(path.join(root, "fixtures", "pdf-text", "scan.pdf"))), 30_000);
  check("reports a scan", scan.status === "no-text", scan);

  let lag = 0;
  let last = Date.now();
  const tick = setInterval(() => {
    lag = Math.max(lag, Date.now() - last - 50);
    last = Date.now();
  }, 50);
  const bomb = await read(textBomb(256), 6_000);
  clearInterval(tick);
  check("a text bomb is stopped, the main process never blocked", bomb.status === "unreadable" && bomb.ms < 8_000 && lag < 500, { ...bomb, lagMs: lag });

  const big = await read(whitespaceBomb(1024), 30_000);
  check(`a 1 GB whitespace bomb is killed at the memory limit (${MEMORY_LIMIT_MB} MB)`, big.reason === "too-large" && big.ms < 30_000, big);

  const probes = mkdtempSync(path.join(tmpdir(), "aba-pdf-reader-check-"));
  try {
    // The heap flag reaches the child (a bare --max-old-space-size does not).
    const heapScript = path.join(probes, "heap.mjs");
    writeFileSync(
      heapScript,
      'import v8 from "node:v8"; process.parentPort.on("message", () => { let evalBlocked = false; try { new Function("return 1")(); } catch { evalBlocked = true; } process.parentPort.postMessage({ heapMb: Math.round(v8.getHeapStatistics().heap_size_limit / 1048576), evalBlocked, envKeys: Object.keys(process.env).filter((k) => !/^(?:ABA_WORKBENCH_PDF_READER|ELECTRON_.*|__CF_USER_TEXT_ENCODING|MACH_PORT_RENDEZVOUS_PEER_VALDATION)$/.test(k)).length }); });',
    );
    const heap = await read(new Uint8Array(1), 10_000, heapScript);
    check("the child's heap is capped near 1 GB, code from strings is refused, and it sees no environment", heap.heapMb > 900 && heap.heapMb < 1400 && heap.evalBlocked && heap.envKeys === 0, heap);
    // An out-of-memory ends the child, not this process.
    const hogScript = path.join(probes, "hog.mjs");
    writeFileSync(hogScript, 'const hoard = []; process.parentPort.on("message", () => { for (;;) hoard.push(new Array(1e6).fill(1)); });');
    const hog = await read(new Uint8Array(1), 30_000, hogScript, ["--js-flags=--max-old-space-size=128"]);
    check("an out-of-memory ends only the child", hog.reason === "crashed" && hog.ms < 30_000, hog);
  } finally {
    rmSync(probes, { recursive: true, force: true });
  }

  if (failures.length) console.log(`${failures.length} check(s) failed`);
  app.exit(failures.length ? 1 : 0);
});
