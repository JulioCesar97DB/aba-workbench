import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { DEFAULT_LIMITS } from "../src/main/pdf-text/extract.ts";
import { extractPdfTextIsolated } from "../src/main/pdf-text/isolated.ts";
import { spawnNodeChild, STAND_IN, started } from "./pdf-child.ts";
import { textBomb } from "./hostile-pdfs.ts";

/*
 * The PDF is read in a separate process (owner's decision, 2026-11-22). In the app it is
 * an Electron utility process; here the same child code runs as a Node.js child process.
 */
const fixtures = path.join(import.meta.dirname, "..", "fixtures");
const PDF = new TextEncoder().encode("%PDF-1.7 invented");

after(async () => {
  // Every reading process a test started has ended.
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(started.filter((c) => !c.exited()).map((c) => c.pid), []);
});

test("isolated: the child process reads a fixture PDF and answers with its text", async () => {
  const bytes = new Uint8Array(readFileSync(path.join(fixtures, "cases", "case-a-mateo", "vineland-3.pdf")));
  const result = await extractPdfTextIsolated(bytes, spawnNodeChild());
  assert.equal(result.status, "text");
  assert.ok(result.status === "text" && result.text.split("\n").includes("Communication | 23 | 62 | 57–67 | 1 | Low"));
});

test("isolated: a process that hangs or loops is killed at the hard time limit", async () => {
  for (const mode of ["hang", "busy"]) {
    const start = Date.now();
    const result = await extractPdfTextIsolated(PDF, spawnNodeChild(STAND_IN, [mode]), { ...DEFAULT_LIMITS, timeoutMs: 1_500 });
    assert.deepEqual(result, { status: "unreadable", reason: "timed-out" }, mode);
    assert.ok(Date.now() - start < 5_000, mode);
  }
});

test("isolated: a crash, an out-of-memory or a malformed answer is reported, never thrown", async () => {
  assert.deepEqual(await extractPdfTextIsolated(PDF, spawnNodeChild(STAND_IN, ["crash"])), { status: "unreadable", reason: "crashed" });
  assert.deepEqual(await extractPdfTextIsolated(PDF, spawnNodeChild(STAND_IN, ["garbage"])), { status: "unreadable", reason: "crashed" });
  assert.deepEqual(await extractPdfTextIsolated(PDF, spawnNodeChild(STAND_IN, ["memory"], 64), { ...DEFAULT_LIMITS, timeoutMs: 20_000 }), { status: "unreadable", reason: "crashed" });
  assert.deepEqual(await extractPdfTextIsolated(PDF, () => { throw new Error("cannot start"); }), { status: "unreadable", reason: "crashed" });
});

test("isolated: a text bomb (a 650 KB PDF of 256 MB of text operators) never blocks this process", async () => {
  const bytes = textBomb(256);
  let lag = 0;
  let last = Date.now();
  const tick = setInterval(() => {
    lag = Math.max(lag, Date.now() - last - 50);
    last = Date.now();
  }, 50);
  const result = await extractPdfTextIsolated(bytes, spawnNodeChild(), { ...DEFAULT_LIMITS, timeoutMs: 4_000 });
  clearInterval(tick);
  assert.equal(result.status, "unreadable");
  assert.ok(result.status === "unreadable" && ["timed-out", "too-large", "crashed"].includes(result.reason), JSON.stringify(result));
  // This (main) process stayed responsive the whole time.
  assert.ok(lag < 500, `event loop lag ${lag} ms`);
});

test("isolated: files too large or not PDFs are refused before any process starts", async () => {
  let spawned = 0;
  const spawn = () => {
    spawned++;
    throw new Error("not expected");
  };
  assert.deepEqual(await extractPdfTextIsolated(new Uint8Array(11), spawn, { ...DEFAULT_LIMITS, maxBytes: 10 }), { status: "unreadable", reason: "too-large" });
  assert.deepEqual(await extractPdfTextIsolated(new TextEncoder().encode("PK zip"), spawn), { status: "unreadable", reason: "not-a-pdf" });
  assert.equal(spawned, 0);
});
