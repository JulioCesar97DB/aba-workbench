import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { LARGEST_PDF_FOR, pdfSizeWarning } from "../src/lib/limits.ts";
import { CASE_FILE_NAME, MAX_CASE_FILE_BYTES, newCaseData, readCaseFile, serializeCaseFile } from "../src/main/case-file.ts";
import { pdfFileNames } from "../src/main/case-folder-name.ts";
import { copyPdfIntoFolder, findSamePdf, looksLikePdf, writeNewFile } from "../src/main/case-pdfs.ts";
import { addTextSource, caseSources, changeSource, setRemoved, textPreview } from "../src/main/case-sources.ts";
import { CaseLibrary } from "../src/main/cases.ts";
import { writeFileDurably } from "../src/main/durable-write.ts";
import { checkSourceTitle, guessPdfType, isSourceDate, MAX_SOURCE_TEXT_LENGTH, normalizeSourceText } from "../src/shared/sources.ts";

// Invented cases and invented PDFs only.
const NOW = new Date("2026-11-22T15:00:00.000Z");
const CASE_ID = "3f0c1a2b-4c5d-4e6f-8a9b-0c1d2e3f4a5b";
const PDF = (label: string) => Buffer.from(`%PDF-1.4\n% invented: ${label}\n%%EOF\n`);
const isPosixRoot = process.platform !== "win32" && process.getuid?.() === 0;

const folders: string[] = [];
after(() => folders.forEach((folder) => rmSync(folder, { recursive: true, force: true })));
function tempFolder(): string {
  const folder = mkdtempSync(path.join(tmpdir(), "aba-sources-test-"));
  folders.push(folder);
  return folder;
}

function library(folder: string, extra: Partial<ConstructorParameters<typeof CaseLibrary>[0]> = {}) {
  let ids = 0;
  const lib = new CaseLibrary({
    location: async () => ({ folder, isDefault: false }),
    now: () => NOW,
    newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
    log: () => undefined,
    ...extra,
  });
  return lib;
}

async function newCase(folder: string, extra: Partial<ConstructorParameters<typeof CaseLibrary>[0]> = {}) {
  const lib = library(folder, extra);
  const created = await lib.create({ label: "M.F. initial assessment" });
  assert.ok(created.outcome === "created");
  return { lib, id: created.case.id, caseFolder: path.join(folder, "M.F. initial assessment") };
}

function dataOf(caseFolder: string) {
  return JSON.parse(readFileSync(path.join(caseFolder, CASE_FILE_NAME), "utf8"));
}

function first<T>(items: Iterable<T>, count: number): T[] {
  const out: T[] = [];
  for (const item of items) {
    if (out.length >= count) break;
    out.push(item);
  }
  return out;
}

/* The shared checks */

test("sources: titles, dates, text and the type a PDF's name suggests", () => {
  assert.deepEqual(checkSourceTitle("  CDE, psychologist's report "), { ok: true, title: "CDE, psychologist's report" });
  assert.deepEqual(checkSourceTitle("   "), { ok: true, title: null });
  assert.deepEqual(checkSourceTitle("a\nb"), { ok: false, problem: "control-characters" });
  assert.deepEqual(checkSourceTitle("x".repeat(121)), { ok: false, problem: "too-long" });
  // Unicode NFC: an accent typed as two characters is saved as one.
  assert.deepEqual(checkSourceTitle(`Jos${"e"}${String.fromCharCode(0x301)}`), { ok: true, title: `Jos${String.fromCharCode(0xe9)}` });
  for (const good of ["2026-10-02", "2024-02-29", "1900-01-01"]) assert.equal(isSourceDate(good), true, good);
  for (const bad of ["2026-02-30", "2026-13-01", "26-10-02", "1899-12-31", "2026-10-02T00:00:00Z", 20261002, null]) assert.equal(isSourceDate(bad), false, String(bad));
  assert.equal(normalizeSourceText("a\r\nb\rc\n"), "a\nb\nc\n");
  assert.equal(guessPdfType("Vineland-3 Report.PDF"), "vineland-3");
  assert.equal(guessPdfType("basc3_prq.pdf"), "basc-3");
  assert.equal(guessPdfType("ABLLS-R grid.pdf"), "ablls-r");
  assert.equal(guessPdfType("IEP 2026.pdf"), "iep");
  assert.equal(guessPdfType("recipe.pdf"), "other");
  assert.equal(textPreview("  one\n\ntwo   three "), "one two three");
  assert.equal(textPreview("x".repeat(200), 10), `${"x".repeat(10)}…`);
  // A character made of two UTF-16 units is never cut in half.
  const face = String.fromCodePoint(0x1f600);
  assert.equal(textPreview(face.repeat(20), 5), `${face.repeat(2)}…`);
});

test("sources: a PDF over a provider's size limit is flagged by its size alone", () => {
  assert.equal(LARGEST_PDF_FOR.openai, 37_500_000);
  assert.equal(LARGEST_PDF_FOR.anthropic, 96_000_000);
  assert.equal(pdfSizeWarning(37_500_000), null);
  assert.equal(pdfSizeWarning(37_500_001), "over-chatgpt");
  assert.equal(pdfSizeWarning(96_000_001), "over-all");
});

/* The data file, version 2 */

test("sources: a version 2 file with sources reads back exactly; a version 1 file reads with none", () => {
  let data = newCaseData({ id: CASE_ID, label: "Case", clientAge: null, now: NOW });
  data = addTextSource(data, { type: "cde", title: "CDE", date: "2026-10-02", text: "Invented.\r\nNotes." }, { id: "11111111-1111-4111-8111-111111111111", now: NOW.toISOString() });
  const text = serializeCaseFile(data);
  const read = readCaseFile(text);
  assert.ok(read.ok);
  assert.deepEqual(read.data, data);
  assert.equal(serializeCaseFile(read.data), text);
  const [source] = read.data.sources;
  assert.equal(source.kind === "text" ? source.text : null, "Invented.\nNotes.");

  const v1 = JSON.stringify({ schemaVersion: 1, id: CASE_ID, label: "Case", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), files: [], mine: { kept: true } });
  const migrated = readCaseFile(v1);
  assert.ok(migrated.ok);
  assert.equal(migrated.migratedFrom, 1);
  assert.deepEqual(migrated.data.sources, []);
  assert.deepEqual((migrated.data as Record<string, unknown>).mine, { kept: true });
});

test("sources: a source the app could not have written makes the file damaged, never rewritten", () => {
  const base = JSON.parse(serializeCaseFile(newCaseData({ id: CASE_ID, label: "Case", clientAge: null, now: NOW })));
  const source = { id: "11111111-1111-4111-8111-111111111111", kind: "text", type: "cde", addedAt: NOW.toISOString(), updatedAt: NOW.toISOString(), text: "x" };
  const bad: Array<Record<string, unknown>> = [
    { ...source, id: "not-an-id" },
    { ...source, kind: "image" },
    { ...source, type: "Has Spaces" },
    { ...source, title: " untrimmed" },
    { ...source, title: "" },
    { ...source, date: "2026-02-30" },
    { ...source, text: "x".repeat(MAX_SOURCE_TEXT_LENGTH + 1) },
    { ...source, kind: "pdf", file: "../outside.pdf", bytes: 1 },
    { ...source, kind: "pdf", file: "a.pdf" },
  ];
  for (const entry of bad) assert.equal(readCaseFile(JSON.stringify({ ...base, sources: [entry] })).ok, false, JSON.stringify(entry).slice(0, 80));
  // The same id twice.
  assert.equal(readCaseFile(JSON.stringify({ ...base, sources: [source, source] })).ok, false);
  // A type this version does not know (a newer app's) is kept as written, and shown as "other".
  const unknown = readCaseFile(JSON.stringify({ ...base, sources: [{ ...source, type: "srs-2", extra: { a: 1 } }] }));
  assert.ok(unknown.ok);
  assert.equal(unknown.data.sources[0].type, "srs-2");
  assert.deepEqual((unknown.data.sources[0] as Record<string, unknown>).extra, { a: 1 });
  assert.equal(caseSources(unknown.data, []).sources[0].type, "other");
});

test("sources: changes keep what they do not touch; removing only marks", () => {
  const sourceId = "11111111-1111-4111-8111-111111111111";
  let data = addTextSource(newCaseData({ id: CASE_ID, label: "Case", clientAge: null, now: NOW }), { type: "cde", text: "Text." }, { id: sourceId, now: NOW.toISOString() });
  data = { ...data, sources: [{ ...data.sources[0], future: "kept" } as (typeof data.sources)[0]] };
  const later = "2026-11-22T16:00:00.000Z";
  const titled = changeSource(data, sourceId, { title: "  Mine ", date: "2026-10-02" }, later);
  assert.deepEqual(titled?.sources[0], { ...data.sources[0], title: "Mine", date: "2026-10-02", updatedAt: later });
  const cleared = changeSource(titled!, sourceId, { title: null, date: null, type: "iep" }, later);
  assert.equal("title" in cleared!.sources[0] || "date" in cleared!.sources[0], false);
  assert.equal(cleared!.sources[0].type, "iep");
  assert.equal(changeSource(data, "22222222-2222-4222-8222-222222222222", { title: "x" }, later), null);
  assert.throws(() => changeSource(data, sourceId, { title: "a\tb" }, later), /Refused/);
  const removed = setRemoved(data, sourceId, true, later)!;
  assert.equal(removed.sources[0].removedAt, later);
  assert.equal(removed.sources[0].kind === "text" ? removed.sources[0].text : null, "Text.");
  const restored = setRemoved(removed, sourceId, false, later)!;
  assert.equal("removedAt" in restored.sources[0], false);
  assert.equal((restored.sources[0] as Record<string, unknown>).future, "kept");
});

/* PDFs in the case's folder */

test("sources: a PDF's copy gets a safe name, never overwrites, and identical bytes are found", async () => {
  assert.deepEqual(first(pdfFileNames("Vineland-3 report.PDF"), 1), ["Vineland-3 report.pdf"]);
  assert.deepEqual(first(pdfFileNames("a:b?.pdf", ["a-b-.pdf"]), 2), ["a-b- 2.pdf", "a-b- 3.pdf"]);
  assert.deepEqual(first(pdfFileNames(".hidden.pdf"), 1), ["hidden.pdf"]);
  assert.deepEqual(first(pdfFileNames("CON.pdf"), 1), ["CON case.pdf"]);
  assert.deepEqual(first(pdfFileNames(".pdf"), 1), ["Document.pdf"]);
  assert.deepEqual(first(pdfFileNames("REPORT.pdf", ["report.pdf"]), 1), ["REPORT 2.pdf"]);

  const folder = tempFolder();
  writeFileSync(path.join(folder, "report.pdf"), "someone else's file");
  const name = await copyPdfIntoFolder(folder, "C:\\Users\\x\\report.pdf", PDF("a"));
  assert.equal(name, "report 2.pdf");
  assert.equal(readFileSync(path.join(folder, "report.pdf"), "utf8"), "someone else's file");
  assert.deepEqual(readFileSync(path.join(folder, name)), PDF("a"));
  // A name taken a moment after the listing is skipped too, never overwritten.
  let calls = 0;
  const racing = async (file: string, bytes: Uint8Array) => {
    if (calls++ === 0) {
      writeFileSync(file, "appeared");
      throw Object.assign(new Error("exists"), { code: "EEXIST" });
    }
    await writeNewFile(file, bytes);
  };
  assert.equal(await copyPdfIntoFolder(folder, "new.pdf", PDF("b"), racing), "new 2.pdf");
  assert.equal(readFileSync(path.join(folder, "new.pdf"), "utf8"), "appeared");

  const files = readdirSync(folder).map((file) => ({ name: file, bytes: statSync(path.join(folder, file)).size }));
  assert.equal(await findSamePdf(folder, PDF("a"), files), "report 2.pdf");
  assert.equal(await findSamePdf(folder, PDF("c"), files), null);
  assert.equal(looksLikePdf(PDF("a")), true);
  assert.equal(looksLikePdf(Buffer.from("PK zip")), false);
});

test("sources: a copy never replaces a file, and one that fails removes only the partial file it created", async () => {
  const folder = tempFolder();
  const file = path.join(folder, "x.pdf");
  writeFileSync(file, "already here");
  await assert.rejects(writeNewFile(file, PDF("x")), /EEXIST/);
  assert.equal(readFileSync(file, "utf8"), "already here");
  // Bytes that cannot be written (a detached buffer stands in for a full disk).
  const detached = new Uint8Array(new ArrayBuffer(8));
  structuredClone(detached.buffer, { transfer: [detached.buffer] });
  await assert.rejects(writeNewFile(path.join(folder, "fresh.pdf"), detached));
  assert.deepEqual(readdirSync(folder), ["x.pdf"]);
});

/* Through the case library, on disk */

test("cases: pasted texts are saved in the data file, changed, removed and restored; nothing is deleted", async () => {
  const { lib, id, caseFolder } = await newCase(tempFolder());
  const added = await lib.addTextSource(id, { type: "parent-interview", title: "Mother", text: "Invented notes." });
  assert.ok(added.outcome === "saved");
  const sourceId = added.sourceId;
  assert.deepEqual(added.sources.sources, [
    {
      id: sourceId,
      kind: "text",
      type: "parent-interview",
      title: "Mother",
      date: null,
      addedAt: added.sources.sources[0].addedAt,
      updatedAt: added.sources.sources[0].updatedAt,
      removedAt: null,
      characters: 15,
      preview: "Invented notes.",
    },
  ]);
  assert.equal(dataOf(caseFolder).schemaVersion, 2);
  assert.equal((await lib.changeSource(id, sourceId, { text: "Changed." })).outcome, "saved");
  assert.deepEqual(await lib.readSourceText(id, sourceId), { outcome: "read", text: "Changed." });
  assert.equal((await lib.setSourceRemoved(id, sourceId, true)).outcome, "saved");
  assert.equal(dataOf(caseFolder).sources[0].text, "Changed.");
  assert.ok(dataOf(caseFolder).sources[0].removedAt);
  assert.equal((await lib.setSourceRemoved(id, sourceId, false)).outcome, "saved");
  assert.equal(dataOf(caseFolder).sources[0].removedAt, undefined);
  assert.deepEqual(await lib.changeSource(id, "22222222-2222-4222-8222-222222222222", { title: "x" }), { outcome: "source-not-found" });
  assert.deepEqual(readdirSync(caseFolder), [CASE_FILE_NAME]);
  // Every save moved updatedAt forward, even with the clock standing still.
  assert.ok(Date.parse(dataOf(caseFolder).updatedAt) > NOW.getTime());
});

test("cases: quick successive changes are all kept", async () => {
  const { lib, id, caseFolder } = await newCase(tempFolder());
  const added = await lib.addTextSource(id, { type: "cde", text: "0" });
  assert.ok(added.outcome === "saved");
  await Promise.all([1, 2, 3, 4, 5].map((n) => lib.changeSource(id, added.sourceId, n % 2 ? { text: String(n) } : { title: `T${n}` })));
  assert.equal(dataOf(caseFolder).sources[0].text, "5");
  assert.equal(dataOf(caseFolder).sources[0].title, "T4");
});

test("cases: a version 1 case gets its sources on the first save, keeping keys it does not know", async () => {
  const folder = tempFolder();
  const caseFolder = path.join(folder, "Old case");
  mkdirSync(caseFolder);
  writeFileSync(
    path.join(caseFolder, CASE_FILE_NAME),
    JSON.stringify({ schemaVersion: 1, id: CASE_ID, label: "Old case", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), files: [], extra: [1, 2] }),
  );
  const lib = library(folder);
  const opened = await lib.open(CASE_ID);
  assert.ok(opened.outcome === "opened");
  assert.deepEqual(opened.case.sources.sources, []);
  // Opening alone does not rewrite it.
  assert.equal(dataOf(caseFolder).schemaVersion, 1);
  assert.equal((await lib.addTextSource(CASE_ID, { type: "iep", text: "x" })).outcome, "saved");
  const data = dataOf(caseFolder);
  assert.equal(data.schemaVersion, 2);
  assert.deepEqual(data.extra, [1, 2]);
  assert.equal(data.sources.length, 1);
});

test("cases: a newer case is never written; a save over the size limit is refused whole", async () => {
  const { lib, id, caseFolder } = await newCase(tempFolder());
  const file = path.join(caseFolder, CASE_FILE_NAME);
  const good = readFileSync(file, "utf8");
  writeFileSync(file, JSON.stringify({ ...JSON.parse(good), schemaVersion: 3 }));
  const newer = readFileSync(file, "utf8");
  assert.deepEqual(await lib.addTextSource(id, { type: "cde", text: "x" }), { outcome: "case-unavailable" });
  assert.equal(readFileSync(file, "utf8"), newer);

  writeFileSync(file, good);
  const big = "x".repeat(MAX_SOURCE_TEXT_LENGTH);
  let outcome = "";
  for (let i = 0; i < 60 && outcome !== "case-full"; i++) outcome = (await lib.addTextSource(id, { type: "cde", text: big })).outcome;
  assert.equal(outcome, "case-full");
  assert.ok(statSync(file).size <= MAX_CASE_FILE_BYTES);
  assert.equal(readCaseFile(readFileSync(file)).ok, true);
});

test("cases: a failed save reports not-saved and leaves the data file as it was", async () => {
  let fail = false;
  const { lib, id, caseFolder } = await newCase(tempFolder(), {
    writeFile: async (file, text) => {
      if (fail) throw new Error("disk full");
      await writeFileDurably(file, text);
    },
  });
  const before = readFileSync(path.join(caseFolder, CASE_FILE_NAME), "utf8");
  fail = true;
  assert.deepEqual(await lib.addTextSource(id, { type: "cde", text: "x" }), { outcome: "not-saved" });
  assert.equal(readFileSync(path.join(caseFolder, CASE_FILE_NAME), "utf8"), before);
});

test("cases: PDFs are copied in once, the originals untouched; folder PDFs are added as they are", async () => {
  const originals = tempFolder();
  const { lib, id, caseFolder } = await newCase(tempFolder());
  const vineland = path.join(originals, "Vineland-3.pdf");
  writeFileSync(vineland, PDF("vineland"));
  writeFileSync(path.join(originals, "notes.txt"), "not a pdf");
  const before = statSync(vineland).mtimeMs;
  const result = await lib.addChosenPdfs(id, [vineland, path.join(originals, "notes.txt"), path.join(originals, "missing.pdf")]);
  assert.ok(result.outcome === "done");
  assert.equal(result.added.length, 1);
  assert.deepEqual(result.problems, [
    { name: "notes.txt", problem: "not-a-pdf" },
    { name: "missing.pdf", problem: "cannot-read" },
  ]);
  assert.deepEqual(readFileSync(path.join(caseFolder, "Vineland-3.pdf")), PDF("vineland"));
  assert.equal(statSync(vineland).mtimeMs, before);
  assert.deepEqual(readdirSync(originals).sort(), ["Vineland-3.pdf", "notes.txt"]);
  const source = result.sources.sources[0];
  assert.ok(source.kind === "pdf");
  assert.equal(source.type, "vineland-3");
  assert.equal(source.present, true);

  // The same bytes again, under any name: already a source, no second copy.
  const again = await lib.addDroppedPdf(id, { name: "copy.pdf", data: PDF("vineland") });
  assert.ok(again.outcome === "done");
  assert.deepEqual(again.problems, [{ name: "copy.pdf", problem: "already-added" }]);
  // Removed, it says so.
  await lib.setSourceRemoved(id, source.id, true);
  const removedAgain = await lib.addDroppedPdf(id, { name: "copy.pdf", data: PDF("vineland") });
  assert.ok(removedAgain.outcome === "done");
  assert.deepEqual(removedAgain.problems, [{ name: "copy.pdf", problem: "already-removed" }]);
  assert.deepEqual(readdirSync(caseFolder).sort(), ["Vineland-3.pdf", CASE_FILE_NAME]);

  // A PDF put in the folder by hand is listed, and added as it is.
  writeFileSync(path.join(caseFolder, "school iep.pdf"), PDF("iep"));
  const opened = await lib.open(id);
  assert.ok(opened.outcome === "opened");
  assert.deepEqual(
    opened.case.sources.files.map((file) => file.name),
    ["Vineland-3.pdf", "school iep.pdf"],
  );
  const fromFolder = await lib.addFolderPdf(id, "school iep.pdf");
  assert.ok(fromFolder.outcome === "done");
  assert.equal(fromFolder.sources.sources.at(-1)?.type, "iep");
  assert.deepEqual(readFileSync(path.join(caseFolder, "school iep.pdf")), PDF("iep"));
  const twice = await lib.addFolderPdf(id, "school iep.pdf");
  assert.ok(twice.outcome === "done");
  assert.deepEqual(twice.problems, [{ name: "school iep.pdf", problem: "already-added" }]);
  // Its path, to open it, is the case's own copy.
  assert.equal(await lib.sourcePdfPath(id, source.id), path.join(caseFolder, "Vineland-3.pdf"));
  // A PDF gone from the folder shows as not present, and is not opened.
  rmSync(path.join(caseFolder, "Vineland-3.pdf"));
  const missing = await lib.open(id);
  assert.ok(missing.outcome === "opened");
  const gone = missing.case.sources.sources.find((entry) => entry.id === source.id);
  assert.equal(gone?.kind === "pdf" ? gone.present : null, false);
  assert.equal(await lib.sourcePdfPath(id, source.id), null);
});

test("cases: the sources functions refuse hostile input before anything is read or written", async () => {
  const folder = tempFolder();
  const { lib, id, caseFolder } = await newCase(folder);
  const before = readFileSync(path.join(caseFolder, CASE_FILE_NAME), "utf8");
  const attempts: Array<() => Promise<unknown>> = [
    () => lib.addTextSource("../x", { type: "cde", text: "x" }),
    () => lib.addTextSource(id, { type: "unknown", text: "x" }),
    () => lib.addTextSource(id, { type: "cde", text: "x", more: 1 }),
    () => lib.addTextSource(id, { type: "cde", text: 5 }),
    () => lib.addTextSource(id, { type: "cde", text: "x".repeat(MAX_SOURCE_TEXT_LENGTH + 1) }),
    () => lib.addTextSource(id, { type: "cde", title: "x".repeat(121), text: "x" }),
    () => lib.addTextSource(id, { type: "cde", date: "yesterday", text: "x" }),
    () => lib.changeSource(id, "nope", { title: "x" }),
    () => lib.changeSource(id, "11111111-1111-4111-8111-111111111111", {}),
    () => lib.addFolderPdf(id, "../aba-case.json"),
    () => lib.addFolderPdf(id, "a/b.pdf"),
    () => lib.addDroppedPdf(id, { name: "x.pdf", data: "bytes" }),
    () => lib.addDroppedPdf(id, { name: "x.pdf", data: new Uint8Array(1), path: "/etc" }),
    () => lib.readSourceText(id, "../../etc/passwd"),
    () => lib.sourcePdfPath(id, "/etc/passwd"),
  ];
  for (const attempt of attempts) await assert.rejects(attempt(), /^Error: Refused:/);
  assert.equal(readFileSync(path.join(caseFolder, CASE_FILE_NAME), "utf8"), before);
  // A dropped name that tries to leave the folder lands inside it, by its last part.
  const pdf = await lib.addDroppedPdf(id, { name: "../../../escape.pdf", data: PDF("escape") });
  assert.ok(pdf.outcome === "done");
  assert.deepEqual(readdirSync(caseFolder).sort(), [CASE_FILE_NAME, "escape.pdf"]);
  assert.deepEqual(readdirSync(folder), ["M.F. initial assessment"]);
  // Only a pasted text has text.
  await assert.rejects(lib.changeSource(id, pdf.added[0], { text: "x" }), /Refused/);
  assert.deepEqual(await lib.readSourceText(id, pdf.added[0]), { outcome: "source-not-found" });
});

test("cases: a PDF that cannot be written into a read-only case folder is reported, and nothing is left", { skip: process.platform === "win32" || isPosixRoot }, async () => {
  const { lib, id, caseFolder } = await newCase(tempFolder());
  chmodSync(caseFolder, 0o555);
  try {
    const result = await lib.addDroppedPdf(id, { name: "x.pdf", data: PDF("x") });
    assert.ok(result.outcome === "done");
    assert.deepEqual(result.problems, [{ name: "x.pdf", problem: "not-copied" }]);
    assert.deepEqual(readdirSync(caseFolder), [CASE_FILE_NAME]);
  } finally {
    chmodSync(caseFolder, 0o755);
  }
});
