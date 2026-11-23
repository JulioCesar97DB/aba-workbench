import assert from "node:assert/strict";
import { REPORT_SECTIONS } from "../src/shared/report-sections.ts";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { CASE_FILE_NAME, CASE_SCHEMA_VERSION, MAX_CASE_FILE_BYTES, migrateCaseData, newCaseData, nextUpdatedAt, parsesWithoutLoss, readCaseFile, serializeCaseFile, type CaseData } from "../src/main/case-file.ts";
import { caseFolderName, caseFolderNames, folderNameKey, MAX_FOLDER_NAME_LENGTH } from "../src/main/case-folder-name.ts";
import { CaseLibrary, readCaseFolder, scanCaseFiles } from "../src/main/cases.ts";
import { DEFAULT_CASES_FOLDER_NAME, defaultCasesFolder, inspectCasesFolder } from "../src/main/cases-folder.ts";
import { temporaryFileFor, writeFileDurably } from "../src/main/durable-write.ts";
import { checkCaseLabel, isCaseId } from "../src/shared/api.ts";

// Invented cases only.
const ID = "3f0c1a2b-4c5d-4e6f-8a9b-0c1d2e3f4a5b";
const NOW = new Date("2026-11-22T15:00:00.000Z");
const NUL = String.fromCharCode(0);
const isPosixRoot = process.platform !== "win32" && process.getuid?.() === 0;

const folders: string[] = [];
after(() => folders.forEach((folder) => rmSync(folder, { recursive: true, force: true })));
function tempFolder(): string {
  const folder = mkdtempSync(path.join(tmpdir(), "aba-cases-test-"));
  folders.push(folder);
  return folder;
}

/** Sets a file's modified time two minutes back: what a crash in an earlier run leaves. */
function makeOld(file: string): void {
  const then = new Date(Date.now() - 2 * 60_000);
  utimesSync(file, then, then);
}

const BACKSLASH = String.fromCharCode(92);

/** Each named file's bytes, as base64, to compare before and after. */
function bytesOf(folder: string, names: string[]): Record<string, string> {
  return Object.fromEntries(names.map((name) => [name, readFileSync(path.join(folder, name)).toString("base64")]));
}

/** Every entry under `folder` with its bytes (folders as "dir"): to prove nothing changed. */
function everything(folder: string): string[] {
  return readdirSync(folder, { recursive: true, withFileTypes: true })
    .map((entry) => {
      const full = path.join(entry.parentPath, entry.name);
      return `${path.relative(folder, full)}:${entry.isFile() ? readFileSync(full).toString("base64") : entry.isSymbolicLink() ? "link" : "dir"}`;
    })
    .sort();
}

function sample(overrides: Partial<CaseData> = {}): CaseData {
  return { ...newCaseData({ id: ID, label: "M.F. initial assessment", clientAge: { years: 4, months: 2 }, now: NOW }), ...overrides };
}

function library(folder: string, extra: Partial<ConstructorParameters<typeof CaseLibrary>[0]> = {}) {
  let ids = 0;
  const logged: string[] = [];
  const lib = new CaseLibrary({
    location: async () => ({ folder, isDefault: false }),
    now: () => NOW,
    newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
    log: (message) => logged.push(message),
    ...extra,
  });
  return { lib, logged };
}

/* The data file */

test("case file: a new case's data file has the version 4 shape (no case map yet), and reads back the same", () => {
  const data = sample();
  const text = serializeCaseFile(data);
  assert.deepEqual(JSON.parse(text), {
    schemaVersion: 4,
    id: ID,
    label: "M.F. initial assessment",
    clientAge: { years: 4, months: 2 },
    createdAt: "2026-11-22T15:00:00.000Z",
    updatedAt: "2026-11-22T15:00:00.000Z",
    files: [],
    sources: [],
    sections: {},
  });
  assert.deepEqual(readCaseFile(text), { ok: true, data, migratedFrom: null });
  // No age given: the key is left out.
  const noAge = newCaseData({ id: ID, label: "Case", clientAge: null, now: NOW });
  assert.equal("clientAge" in JSON.parse(serializeCaseFile(noAge)), false);
  assert.equal(readCaseFile(serializeCaseFile(noAge)).ok, true);
});

test("case file: keys this version does not know are kept when it is saved again", () => {
  const text = JSON.stringify({ ...JSON.parse(serializeCaseFile(sample())), notes: { kept: true }, files: [{ name: "a.pdf", bytes: 1, modifiedAt: NOW.toISOString(), pages: 3 }] });
  const read = readCaseFile(text);
  assert.ok(read.ok);
  const again = JSON.parse(serializeCaseFile(read.data));
  assert.deepEqual(again.notes, { kept: true });
  assert.equal(again.files[0].pages, 3);
});

test("case file: anything that is not a valid version 1 file is damaged, never a crash", () => {
  const good = JSON.parse(serializeCaseFile(sample()));
  const damaged: unknown[] = [
    "",
    "{",
    "not json",
    "null",
    "[]",
    "42",
    '"text"',
    JSON.stringify({ ...good, schemaVersion: undefined }),
    JSON.stringify({ ...good, schemaVersion: "1" }),
    JSON.stringify({ ...good, schemaVersion: 0 }),
    JSON.stringify({ ...good, schemaVersion: -1 }),
    JSON.stringify({ ...good, schemaVersion: 1.5 }),
    JSON.stringify({ ...good, id: "case-a" }),
    JSON.stringify({ ...good, id: ID.toUpperCase() }),
    JSON.stringify({ ...good, label: "" }),
    JSON.stringify({ ...good, label: "  padded  " }),
    JSON.stringify({ ...good, label: "x".repeat(101) }),
    JSON.stringify({ ...good, label: `bad${NUL}label` }),
    JSON.stringify({ ...good, label: 7 }),
    JSON.stringify({ ...good, clientAge: { years: 4, months: 12 } }),
    JSON.stringify({ ...good, clientAge: { years: -1 } }),
    JSON.stringify({ ...good, clientAge: { years: 4.5 } }),
    JSON.stringify({ ...good, clientAge: "4 years" }),
    JSON.stringify({ ...good, createdAt: "yesterday" }),
    JSON.stringify({ ...good, updatedAt: undefined }),
    JSON.stringify({ ...good, files: "a.pdf" }),
    JSON.stringify({ ...good, files: [{ name: "", bytes: 1, modifiedAt: NOW.toISOString() }] }),
    JSON.stringify({ ...good, files: [{ name: "a.pdf", bytes: -1, modifiedAt: NOW.toISOString() }] }),
    String.fromCharCode(0, 1, 2),
  ];
  for (const text of damaged) assert.deepEqual(readCaseFile(text as string), { ok: false, problem: "damaged" }, String(text).slice(0, 120));
});

test("case file: a file from a newer version of the app is recognised as such", () => {
  const good = JSON.parse(serializeCaseFile(sample()));
  for (const version of [CASE_SCHEMA_VERSION + 1, 99]) {
    assert.deepEqual(readCaseFile(JSON.stringify({ ...good, schemaVersion: version, drafts: {} })), { ok: false, problem: "newer-version" });
  }
});

test("case file: an older version is migrated one step at a time; a missing step is damaged", () => {
  const migrations = {
    1: (data: Record<string, unknown>) => ({ ...data, sources: [] }),
    2: (data: Record<string, unknown>) => ({ ...data, behaviors: [], steps: [...((data.steps as number[]) ?? []), 2] }),
  };
  assert.deepEqual(migrateCaseData({ schemaVersion: 1, id: "x", steps: [] }, 3, migrations), {
    ok: true,
    data: { schemaVersion: 3, id: "x", sources: [], behaviors: [], steps: [2] },
    migratedFrom: 1,
  });
  assert.deepEqual(migrateCaseData({ schemaVersion: 2, id: "x" }, 3, migrations), { ok: true, data: { schemaVersion: 3, id: "x", behaviors: [], steps: [2] }, migratedFrom: 2 });
  assert.deepEqual(migrateCaseData({ schemaVersion: 3 }, 3, migrations), { ok: true, data: { schemaVersion: 3 }, migratedFrom: null });
  assert.deepEqual(migrateCaseData({ schemaVersion: 1 }, 3, { 2: migrations[2] }), { ok: false, problem: "damaged" });
  assert.deepEqual(migrateCaseData({ schemaVersion: 4 }, 3, migrations), { ok: false, problem: "newer-version" });
  for (const bad of [null, [], "x", {}, { schemaVersion: "2" }, { schemaVersion: 0 }, { schemaVersion: Number.MAX_SAFE_INTEGER + 2 }]) {
    assert.equal(migrateCaseData(bad, 3, migrations).ok, false, JSON.stringify(bad));
  }
  // The real chain: version 4 is current; a version 1 file gains an empty list of sources, a version 2 file an empty set of sections, and a version 3 file nothing (no case map until she makes one, D7).
  assert.equal(CASE_SCHEMA_VERSION, 4);
  assert.deepEqual(migrateCaseData({ schemaVersion: 1 }), { ok: true, data: { schemaVersion: 4, sources: [], sections: {} }, migratedFrom: 1 });
  assert.deepEqual(migrateCaseData({ schemaVersion: 2 }), { ok: true, data: { schemaVersion: 4, sections: {} }, migratedFrom: 2 });
  assert.deepEqual(migrateCaseData({ schemaVersion: 3 }), { ok: true, data: { schemaVersion: 4 }, migratedFrom: 3 });
  assert.deepEqual(migrateCaseData({ schemaVersion: 4 }), { ok: true, data: { schemaVersion: 4 }, migratedFrom: null });
});

test("case file: the updated time always moves forward", () => {
  assert.equal(nextUpdatedAt("2026-11-22T15:00:00.000Z", new Date("2026-11-22T16:00:00.000Z")), "2026-11-22T16:00:00.000Z");
  // Same millisecond, or a clock that went back: one millisecond later.
  assert.equal(nextUpdatedAt("2026-11-22T15:00:00.000Z", new Date("2026-11-22T15:00:00.000Z")), "2026-11-22T15:00:00.001Z");
  assert.equal(nextUpdatedAt("2026-11-22T15:00:00.000Z", new Date("2026-01-01T00:00:00.000Z")), "2026-11-22T15:00:00.001Z");
});

test("labels and ids: what the interface may send", () => {
  assert.deepEqual(checkCaseLabel("  Mateo F.  "), { ok: true, label: "Mateo F." });
  // NFC: an "é" typed as e + combining accent is saved as one character.
  assert.deepEqual(checkCaseLabel("Jose\u{301}"), { ok: true, label: "José" });
  assert.deepEqual(checkCaseLabel("   "), { ok: false, problem: "empty" });
  assert.deepEqual(checkCaseLabel("x".repeat(101)), { ok: false, problem: "too-long" });
  assert.equal(checkCaseLabel("😀".repeat(100)).ok, true);
  for (const bad of ["a\nb", `a${NUL}b`, "a\u{202E}b", "a\u{2066}b", "a\tb"]) assert.deepEqual(checkCaseLabel(bad), { ok: false, problem: "control-characters" }, JSON.stringify(bad));
  assert.equal(isCaseId(ID), true);
  for (const bad of [ID.toUpperCase(), "../etc", "", null, 1, {}, "3f0c1a2b-4c5d-1e6f-8a9b-0c1d2e3f4a5b"]) assert.equal(isCaseId(bad), false, String(bad));
});

/* Folder names */

test("folder name: the label stays readable", () => {
  assert.equal(caseFolderName("Mateo F. initial assessment"), "Mateo F. initial assessment");
  assert.equal(caseFolderName("Sofía Ñandú"), "Sofía Ñandú");
  assert.equal(caseFolderName("  many    spaces\there "), "many spaces-here");
});

test("folder name: characters Windows forbids, and control characters, become dashes", () => {
  assert.equal(caseFolderName('a<b>c:d"e/f\\g|h?i*j'), "a-b-c-d-e-f-g-h-i-j");
  assert.equal(caseFolderName(`a${NUL}b\u{1}c`), "a-b-c");
});

test("folder name: no dots or spaces at either end, and never empty", () => {
  assert.equal(caseFolderName(".hidden"), "hidden");
  assert.equal(caseFolderName("ends with dots..."), "ends with dots");
  assert.equal(caseFolderName(" . . "), "Case");
  assert.equal(caseFolderName(""), "Case");
  assert.equal(caseFolderName(".."), "Case");
  assert.equal(caseFolderName("/"), "-");
});

test("folder name: Unicode NFC, so the same label gives the same folder on every system", () => {
  assert.equal(caseFolderName("Jose\u{301}"), "José");
  assert.equal(caseFolderName("Jose\u{301}").length, 4);
});

test("folder name: at most 60 characters, cut between whole characters", () => {
  const long = caseFolderName("a".repeat(200));
  assert.equal(long.length, MAX_FOLDER_NAME_LENGTH);
  // An emoji is two UTF-16 units: never cut in half.
  const emoji = caseFolderName("😀".repeat(40));
  assert.equal(emoji, "😀".repeat(30));
  // A family emoji is one character of 11 units.
  const family = "👨‍👩‍👧";
  assert.equal(caseFolderName(`${"a".repeat(55)}${family}`), "a".repeat(55));
  // A cut that ends on a space or a dot is tidied.
  assert.equal(caseFolderName(`${"a".repeat(59)} b`), "a".repeat(59));
});

test("folder name: Windows device names get ' case' after them", () => {
  for (const name of ["CON", "con", "Prn", "AUX", "NUL", "COM1", "com9", "LPT1", "COM0", "LPT¹", "COM²"]) {
    assert.equal(caseFolderName(name), `${name} case`, name);
  }
  assert.equal(caseFolderName("CON.txt"), "CON case.txt");
  assert.equal(caseFolderName("nul .x"), "nul case.x");
  // Only the whole name before the dot counts.
  assert.equal(caseFolderName("CONSTANCE"), "CONSTANCE");
  assert.equal(caseFolderName("COM10"), "COM10");
});

test("folder name: a taken name gets ' 2', ' 3'..., compared ignoring case and Unicode form", () => {
  assert.equal(caseFolderName("Ana", ["Ana"]), "Ana 2");
  assert.equal(caseFolderName("Ana", ["ana", "ANA 2"]), "Ana 3");
  assert.equal(caseFolderName("José", ["Jose\u{301}"]), "José 2");
  const names = caseFolderNames("Ana", ["Ana"]);
  assert.deepEqual([names.next().value, names.next().value, names.next().value], ["Ana 2", "Ana 3", "Ana 4"]);
  // The suffix fits within the 60 characters.
  const long = caseFolderName("b".repeat(80), ["b".repeat(60)]);
  assert.equal(long, `${"b".repeat(58)} 2`);
  assert.equal(folderNameKey("ÁRBOL"), folderNameKey("a\u{301}rbol"));
});

/* Durable writes */

test("durable write: writes the whole file, leaves no temporary file, replaces an old one", async () => {
  const folder = tempFolder();
  const file = path.join(folder, CASE_FILE_NAME);
  await writeFileDurably(file, "first");
  await writeFileDurably(file, "second");
  assert.equal(readFileSync(file, "utf8"), "second");
  assert.deepEqual(readdirSync(folder), [CASE_FILE_NAME]);
});

test("R4-1: a temporary file a crashed run left under this process's id is never touched; the save uses another name", async () => {
  const folder = tempFolder();
  const file = path.join(folder, CASE_FILE_NAME);
  // A crashed earlier run had the same process id (ids are reused after a reboot), and the next name too.
  writeFileSync(temporaryFileFor(file), "the user's latest change");
  writeFileSync(temporaryFileFor(file, 1), "another leftover");
  await writeFileDurably(file, "whole");
  assert.equal(readFileSync(file, "utf8"), "whole");
  assert.equal(readFileSync(temporaryFileFor(file), "utf8"), "the user's latest change");
  assert.equal(readFileSync(temporaryFileFor(file, 1), "utf8"), "another leftover");
  assert.deepEqual(readdirSync(folder).sort(), [CASE_FILE_NAME, path.basename(temporaryFileFor(file)), path.basename(temporaryFileFor(file, 1))].sort());
  // Every name a save uses is one the listing recognizes as a temporary data file.
  assert.match(path.basename(temporaryFileFor(file, 7)), /^aba-case\.json\.[0-9]+\.tmp$/);
});
test("R4-1: a failed save removes the temporary file it created, and never one it did not", async () => {
  const folder = tempFolder();
  const file = path.join(folder, CASE_FILE_NAME);
  // A folder where the file should be: the rename fails on every system, after the
  // temporary file was created and written.
  mkdirSync(file);
  writeFileSync(path.join(file, "keep"), "");
  // Left by others: one with this process's id, one with another's.
  writeFileSync(temporaryFileFor(file), "left by a crashed run with this id");
  writeFileSync(path.join(folder, `${CASE_FILE_NAME}.99999.tmp`), "left by another run");
  await assert.rejects(writeFileDurably(file, "new"));
  assert.deepEqual(readdirSync(folder).sort(), [CASE_FILE_NAME, path.basename(temporaryFileFor(file)), `${CASE_FILE_NAME}.99999.tmp`].sort());
  assert.equal(readFileSync(temporaryFileFor(file), "utf8"), "left by a crashed run with this id");
  assert.equal(readFileSync(path.join(folder, `${CASE_FILE_NAME}.99999.tmp`), "utf8"), "left by another run");
  // A save that fails before it creates anything (no such folder) removes nothing.
  await assert.rejects(writeFileDurably(path.join(folder, "no-such-folder", "x.json"), "x"));
  assert.equal(readdirSync(folder).length, 3);
});
test("cases folder: the default is ABA Workbench in the home folder, outside Documents", () => {
  assert.equal(defaultCasesFolder("/Users/ana", path.posix), "/Users/ana/ABA Workbench");
  assert.equal(defaultCasesFolder("/home/ana", path.posix), "/home/ana/ABA Workbench");
  assert.equal(defaultCasesFolder("C:\\Users\\Ana", path.win32), "C:\\Users\\Ana\\ABA Workbench");
  assert.equal(DEFAULT_CASES_FOLDER_NAME, "ABA Workbench");
});

test("cases folder: ready, not made yet, missing or not a folder, and nothing is created", async () => {
  const home = tempFolder();
  const fallback = defaultCasesFolder(home);
  assert.equal(await inspectCasesFolder(fallback, true), "not-created-yet");
  // A folder the user chose that is gone is missing, never made again.
  assert.equal(await inspectCasesFolder(fallback, false), "missing");
  // The default with no home folder at all.
  assert.equal(await inspectCasesFolder(path.join(home, "no-home", DEFAULT_CASES_FOLDER_NAME), true), "missing");
  assert.deepEqual(readdirSync(home), []);
  writeFileSync(fallback, "a file");
  assert.equal(await inspectCasesFolder(fallback, true), "not-a-folder");
  assert.equal(await inspectCasesFolder(path.join(fallback, "inside-a-file"), false), "missing");
  rmSync(fallback);
  mkdirSync(fallback);
  assert.equal(await inspectCasesFolder(fallback, true), "ready");
  // Windows' write check leaves nothing behind.
  assert.equal(await inspectCasesFolder(fallback, false, "win32"), "ready");
  assert.deepEqual(readdirSync(fallback), []);
});

test("cases folder: a folder the app cannot write to is reported", { skip: process.platform === "win32" || isPosixRoot }, async () => {
  const folder = tempFolder();
  chmodSync(folder, 0o555);
  try {
    assert.equal(await inspectCasesFolder(folder, false), "not-writable");
    const { lib } = library(folder);
    assert.deepEqual(await lib.create({ label: "Ana" }), { outcome: "folder-problem", problem: "not-writable" });
    chmodSync(folder, 0o000);
    assert.equal(await inspectCasesFolder(folder, false), "not-allowed");
  } finally {
    chmodSync(folder, 0o755);
  }
});

/* Listing, creating, opening */

test("cases: create a case, list it, open it; the folder holds only its data file", async () => {
  const folder = tempFolder();
  const { lib } = library(folder);
  const created = await lib.create({ label: "  M.F. initial assessment ", clientAge: { years: 4, months: 2 } });
  assert.equal(created.outcome, "created");
  assert.ok(created.outcome === "created");
  assert.deepEqual(created.case, {
    id: "00000000-0000-4000-8000-000000000001",
    label: "M.F. initial assessment",
    clientAge: { years: 4, months: 2 },
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    pdfCount: 0,
  });
  assert.deepEqual(readdirSync(folder), ["M.F. initial assessment"]);
  assert.deepEqual(readdirSync(path.join(folder, "M.F. initial assessment")), [CASE_FILE_NAME]);

  // A fresh library, as after a restart.
  const restarted = library(folder).lib;
  const list = await restarted.list();
  assert.deepEqual(list.folder, { displayPath: folder, isDefault: false, state: "ready" });
  // Listed with how far it is (Home, UX-5): nothing yet.
  assert.deepEqual(list.cases, [
    {
      ...created.case,
      progress: { sources: 0, caseMap: { approved: 0, withContent: 0 }, mapPartToApprove: null, sections: REPORT_SECTIONS.map((section) => ({ id: section.id, state: "not-started" })) },
    },
  ]);
  assert.deepEqual(list.unreadable, []);
  const opened = await restarted.open(created.case.id);
  assert.deepEqual(opened, {
    outcome: "opened",
    case: {
      ...created.case,
      files: [],
      sources: { sources: [], files: [], totalPdfWarning: null, pdfLimits: { chatgpt: 37_500_000, claude: 96_000_000 }, updatedAt: created.case.updatedAt },
      sections: REPORT_SECTIONS.map((section) => ({ id: section.id, state: "not-started", currentVersion: null, approvedVersion: null, versionCount: 0, costUsd: 0 })),
      notes: "",
      caseMap: { approved: 0, withContent: 0 },
    },
  });
});

test("cases: newest first; two cases with the same label get two folders, none overwritten", async () => {
  const folder = tempFolder();
  let clock = Date.parse("2026-11-22T10:00:00.000Z");
  const { lib } = library(folder, { now: () => new Date((clock += 60_000)) });
  const first = await lib.create({ label: "Ana" });
  const second = await lib.create({ label: "ana" });
  const third = await lib.create({ label: "Beto", clientAge: null });
  assert.deepEqual(readdirSync(folder).sort(), ["Ana", "Beto", "ana 2"].sort());
  const list = await lib.list();
  assert.deepEqual(
    list.cases.map((c) => c.label),
    ["Beto", "ana", "Ana"],
  );
  assert.ok(first.outcome === "created" && second.outcome === "created" && third.outcome === "created");
  assert.notEqual(first.case.id, second.case.id);
});

test("cases: a folder that appears with the chosen name is skipped, never written into", async () => {
  const folder = tempFolder();
  mkdirSync(path.join(folder, "Ana"));
  writeFileSync(path.join(folder, "Ana", "someone-else.txt"), "keep me");
  const { lib } = library(folder);
  const created = await lib.create({ label: "Ana" });
  assert.equal(created.outcome, "created");
  assert.deepEqual(readdirSync(path.join(folder, "Ana")), ["someone-else.txt"]);
  assert.deepEqual(readdirSync(path.join(folder, "Ana 2")), [CASE_FILE_NAME]);
});

test("cases: the default folder is made on the first case, one level only", async () => {
  const home = tempFolder();
  const fallback = defaultCasesFolder(home);
  const { lib } = library(fallback, { location: async () => ({ folder: fallback, isDefault: true }) });
  assert.deepEqual((await lib.list()).folder.state, "not-created-yet");
  assert.deepEqual(readdirSync(home), []);
  assert.equal((await lib.create({ label: "Ana" })).outcome, "created");
  assert.deepEqual(readdirSync(home), [DEFAULT_CASES_FOLDER_NAME]);

  // No home folder: nothing is made.
  const gone = path.join(home, "missing-home", DEFAULT_CASES_FOLDER_NAME);
  const nowhere = library(gone, { location: async () => ({ folder: gone, isDefault: true }) }).lib;
  assert.deepEqual(await nowhere.create({ label: "Ana" }), { outcome: "folder-problem", problem: "missing" });
  assert.deepEqual(readdirSync(home), [DEFAULT_CASES_FOLDER_NAME]);
});

test("cases: a chosen folder that is gone is reported, and not made again", async () => {
  const parent = tempFolder();
  const folder = path.join(parent, "unplugged");
  const { lib } = library(folder);
  assert.equal((await lib.list()).folder.state, "missing");
  assert.deepEqual(await lib.create({ label: "Ana" }), { outcome: "folder-problem", problem: "missing" });
  assert.deepEqual(await lib.open(ID), { outcome: "folder-problem", problem: "missing" });
  assert.deepEqual(readdirSync(parent), []);
});

test("cases: every kind of unreadable folder shows in the list, and is never changed", async () => {
  const folder = tempFolder();
  const good = sample();
  const write = (name: string, text?: string) => {
    mkdirSync(path.join(folder, name));
    if (text !== undefined) writeFileSync(path.join(folder, name, CASE_FILE_NAME), text);
  };
  write("A good case", serializeCaseFile(good));
  write("Not a case");
  writeFileSync(path.join(folder, "Not a case", "notes.txt"), "mine");
  write("Corrupt", "{ half a fi");
  write("Wrong shape", JSON.stringify({ schemaVersion: 1, id: "nope" }));
  write("From a newer app", JSON.stringify({ ...JSON.parse(serializeCaseFile(good)), id: "11111111-2222-4333-8444-555555555555", schemaVersion: CASE_SCHEMA_VERSION + 1 }));
  write("Copy of a good case", serializeCaseFile(good));
  write("Too big", " ".repeat(MAX_CASE_FILE_BYTES + 1));
  mkdirSync(path.join(folder, "Data file is a folder", CASE_FILE_NAME), { recursive: true });
  // Not listed at all: hidden folders and plain files.
  mkdirSync(path.join(folder, ".hidden"));
  writeFileSync(path.join(folder, "loose.pdf"), "%PDF");

  const before = snapshot(folder);
  const { lib } = library(folder);
  const list = await lib.list();
  assert.deepEqual(list.cases.map((c) => c.id), [good.id]);
  assert.deepEqual(list.unreadable, [
    { folderName: "Copy of a good case", reason: "duplicate" },
    { folderName: "Corrupt", reason: "damaged" },
    { folderName: "Data file is a folder", reason: "damaged" },
    { folderName: "From a newer app", reason: "newer-version" },
    { folderName: "Not a case", reason: "not-a-case" },
    { folderName: "Too big", reason: "damaged" },
    { folderName: "Wrong shape", reason: "damaged" },
  ]);
  // Opening the newer one's id is refused as unreadable, not rewritten.
  assert.equal((await lib.open("11111111-2222-4333-8444-555555555555")).outcome, "not-found");
  assert.deepEqual(snapshot(folder), before);
});

test("cases: a data file that is a link is not followed", { skip: process.platform === "win32" }, async () => {
  const folder = tempFolder();
  const elsewhere = tempFolder();
  writeFileSync(path.join(elsewhere, "real.json"), serializeCaseFile(sample()));
  mkdirSync(path.join(folder, "Linked"));
  symlinkSync(path.join(elsewhere, "real.json"), path.join(folder, "Linked", CASE_FILE_NAME));
  assert.deepEqual(await readCaseFolder(path.join(folder, "Linked")), { kind: "unreadable", reason: "damaged" });
});

test("cases: opening finds the PDFs in the folder, saves the list and moves the updated time", async () => {
  const folder = tempFolder();
  let clock = NOW.getTime();
  const { lib } = library(folder, { now: () => new Date((clock += 1000)) });
  const created = await lib.create({ label: "Ana" });
  assert.ok(created.outcome === "created");
  const caseFolder = path.join(folder, "Ana");

  // Opening with nothing new does not write.
  const untouched = readFileSync(path.join(caseFolder, CASE_FILE_NAME), "utf8");
  assert.equal((await lib.open(created.case.id)).outcome, "opened");
  assert.equal(readFileSync(path.join(caseFolder, CASE_FILE_NAME), "utf8"), untouched);

  writeFileSync(path.join(caseFolder, "vineland-3.pdf"), "%PDF-1.4 invented");
  writeFileSync(path.join(caseFolder, "BASC-3.PDF"), "%PDF-1.4 invented too");
  writeFileSync(path.join(caseFolder, "notes.txt"), "not a PDF");
  writeFileSync(path.join(caseFolder, ".hidden.pdf"), "hidden");
  mkdirSync(path.join(caseFolder, "folder.pdf"));
  const mtime = new Date("2026-11-20T08:00:00.000Z");
  utimesSync(path.join(caseFolder, "vineland-3.pdf"), mtime, mtime);

  const opened = await lib.open(created.case.id);
  assert.ok(opened.outcome === "opened");
  assert.deepEqual(
    opened.case.files.map((f) => f.name),
    ["BASC-3.PDF", "vineland-3.pdf"],
  );
  assert.deepEqual(opened.case.files[1], { name: "vineland-3.pdf", bytes: 17, modifiedAt: mtime.toISOString() });
  assert.equal(opened.case.pdfCount, 2);
  assert.ok(opened.case.updatedAt > created.case.updatedAt);
  assert.equal(opened.case.createdAt, created.case.createdAt);
  const onDisk = JSON.parse(readFileSync(path.join(caseFolder, CASE_FILE_NAME), "utf8"));
  assert.equal(onDisk.updatedAt, opened.case.updatedAt);
  assert.equal(onDisk.files.length, 2);
  assert.deepEqual(readdirSync(caseFolder).filter((name) => name.endsWith(".tmp")), []);
  // The PDFs themselves are untouched.
  assert.equal(readFileSync(path.join(caseFolder, "vineland-3.pdf"), "utf8"), "%PDF-1.4 invented");
  assert.deepEqual((await scanCaseFiles(caseFolder)).length, 2);
});

test("cases: update saves a change durably with a new updated time, and keeps unknown keys", async () => {
  const folder = tempFolder();
  let clock = NOW.getTime();
  const { lib } = library(folder, { now: () => new Date((clock += 1000)) });
  const created = await lib.create({ label: "Ana" });
  assert.ok(created.outcome === "created");
  const file = path.join(folder, "Ana", CASE_FILE_NAME);
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), laterPhase: [1, 2] }));
  const updated = await lib.update(created.case.id, (data) => ({ ...data, label: "Ana R." }));
  assert.ok(updated);
  const onDisk = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(onDisk.label, "Ana R.");
  assert.deepEqual(onDisk.laterPhase, [1, 2]);
  assert.ok(onDisk.updatedAt > created.case.updatedAt);
  // Two at once: both land, in order.
  await Promise.all([lib.update(created.case.id, (d) => ({ ...d, label: "One" })), lib.update(created.case.id, (d) => ({ ...d, label: "Two" }))]);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).label, "Two");
});

test("cases: a data file that cannot be written leaves no half-made case behind", async () => {
  const folder = tempFolder();
  const { lib, logged } = library(folder, {
    writeFile: async () => {
      throw new Error("disk full (simulated)");
    },
  });
  assert.deepEqual(await lib.create({ label: "Ana" }), { outcome: "not-saved" });
  assert.deepEqual(readdirSync(folder), []);
  assert.equal(logged.length, 1);
});

test("cases: hostile input from the interface is refused and touches nothing", async () => {
  const folder = tempFolder();
  const { lib } = library(folder);
  const refusals: unknown[] = [
    undefined,
    null,
    "Ana",
    42,
    [],
    {},
    { label: 7 },
    { label: "" },
    { label: "   " },
    { label: "x".repeat(101) },
    { label: "x".repeat(10_000_000) },
    { label: "a\nb" },
    { label: "../../etc" + NUL },
    { label: "Ana", clientAge: { years: 200 } },
    { label: "Ana", clientAge: { years: 4, months: 12 } },
    { label: "Ana", clientAge: { years: "4" } },
    { label: "Ana", clientAge: "4 years" },
    { label: "Ana", folder: "/etc" },
    { label: "Ana", id: ID },
  ];
  for (const input of refusals) await assert.rejects(lib.create(input), /^Error: Refused:/, JSON.stringify(input)?.slice(0, 80));
  for (const id of [undefined, null, "", "../../etc/passwd", folder, "x".repeat(1_000_000), ID.toUpperCase(), 1, { id: ID }]) {
    await assert.rejects(lib.open(id), /^Error: Refused:/, String(id).slice(0, 80));
  }
  for (const name of [undefined, "", ".", "..", "../x", "a/b", "a\\b", `a${NUL}`, folder, "x".repeat(256), 1]) {
    await assert.rejects(lib.unreadableFolderPath(name), /^Error: Refused:/, String(name).slice(0, 80));
  }
  assert.deepEqual(readdirSync(folder), []);
  // A label that looks like a path makes an ordinary folder inside the cases folder.
  const created = await lib.create({ label: "../../outside" });
  assert.equal(created.outcome, "created");
  assert.deepEqual(readdirSync(folder), ["-..-outside"]);
  // Error messages carry no path.
  await lib.create({ label: "x".repeat(200) }).catch((error: Error) => assert.doesNotMatch(error.message, new RegExp(folder.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"))));
});

test("cases: an unreadable folder can be found to reveal it; anything else cannot", async () => {
  const folder = tempFolder();
  mkdirSync(path.join(folder, "Not a case"));
  writeFileSync(path.join(folder, "a file"), "");
  const { lib } = library(folder);
  // Nothing is revealed before Home has listed it as unreadable.
  assert.equal(await lib.unreadableFolderPath("Not a case"), null);
  await lib.list();
  assert.equal(await lib.unreadableFolderPath("Not a case"), path.join(folder, "Not a case"));
  assert.equal(await lib.unreadableFolderPath("a file"), null);
  assert.equal(await lib.unreadableFolderPath("gone"), null);
});

function snapshot(folder: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(folder, { recursive: true, withFileTypes: true })) {
    const full = path.join(entry.parentPath, entry.name);
    out.push(`${path.relative(folder, full)}:${entry.isFile() ? readFileSync(full, "utf8").length : "dir"}`);
  }
  return out.sort();
}

/* Review round 1 */

/** The data file's text with its label written in Latin-1, as an older Windows Notepad saved files: "Niño" is the bytes 4e 69 f1 6f. */
function latin1CaseFile(): Buffer {
  const text = serializeCaseFile(sample({ label: "Niño" }));
  return Buffer.from(text, "latin1");
}

test("B1: a data file that is not valid UTF-8 is damaged, and opening never rewrites it", async () => {
  const bytes = latin1CaseFile();
  assert.deepEqual(readCaseFile(bytes), { ok: false, problem: "damaged" });
  // The same file in UTF-8 is a good case.
  assert.equal(readCaseFile(Buffer.from(serializeCaseFile(sample({ label: "Niño" })), "utf8")).ok, true);

  const folder = tempFolder();
  mkdirSync(path.join(folder, "Niño"));
  writeFileSync(path.join(folder, "Niño", CASE_FILE_NAME), bytes);
  writeFileSync(path.join(folder, "Niño", "a.pdf"), "%PDF");
  const { lib } = library(folder);
  const list = await lib.list();
  assert.deepEqual(list.cases, []);
  assert.deepEqual(list.unreadable, [{ folderName: "Niño", reason: "damaged" }]);
  assert.deepEqual(await lib.open(ID), { outcome: "not-found" });
  assert.equal(await lib.update(ID, (data) => data), null);
  assert.ok(readFileSync(path.join(folder, "Niño", CASE_FILE_NAME)).equals(bytes), "the original bytes are kept");
});

test("B1: a data file JSON would read with less than it holds is damaged and never rewritten", async () => {
  const good = JSON.parse(serializeCaseFile(sample()));
  const goodText = serializeCaseFile(sample());
  // A repeated key (JSON.parse keeps the last), at the top or deeper.
  const repeated = goodText.replace('"label": "M.F. initial assessment",', '"label": "First",\n  "label": "M.F. initial assessment",');
  assert.notEqual(repeated, goodText);
  assert.deepEqual(readCaseFile(repeated), { ok: false, problem: "damaged" });
  assert.deepEqual(readCaseFile(JSON.stringify({ ...good, notes: { a: 1 } }).replace('{"a":1}', '{"a":1,"a":2}')), { ok: false, problem: "damaged" });
  // Numbers that cannot be held exactly, in a key a later version might add.
  for (const number of ["12345678901234567890", "-9007199254740993", "1e400"]) {
    assert.deepEqual(readCaseFile(goodText.replace('"files": []', `"files": [], "later": ${number}`)), { ok: false, problem: "damaged" }, number);
  }
  // What it reads whole stays readable: keys repeated in different objects, escapes, decimals.
  assert.equal(parsesWithoutLoss('{"a":{"x":1},"b":{"x":1.5e3},"c":"\\"x\\"","d":[{"x":-0.25},{"x":9007199254740991}]}'), true);

  const folder = tempFolder();
  mkdirSync(path.join(folder, "Repeated"));
  writeFileSync(path.join(folder, "Repeated", CASE_FILE_NAME), repeated);
  writeFileSync(path.join(folder, "Repeated", "a.pdf"), "%PDF");
  const { lib } = library(folder);
  assert.deepEqual((await lib.list()).unreadable, [{ folderName: "Repeated", reason: "damaged" }]);
  assert.deepEqual(await lib.open(ID), { outcome: "not-found" });
  assert.equal(readFileSync(path.join(folder, "Repeated", CASE_FILE_NAME), "utf8"), repeated);
});

test("S1: after the cases folder changes, a case in the old folder can no longer be read or written by its id", async () => {
  const oldFolder = tempFolder();
  const newFolder = tempFolder();
  let current = oldFolder;
  const { lib } = library(oldFolder, { location: async () => ({ folder: current, isDefault: false }) });
  const created = await lib.create({ label: "Ana" });
  assert.ok(created.outcome === "created");
  await lib.list();
  const file = path.join(oldFolder, "Ana", CASE_FILE_NAME);
  const before = readFileSync(file, "utf8");

  current = newFolder;
  writeFileSync(path.join(oldFolder, "Ana", "new.pdf"), "%PDF");
  assert.deepEqual(await lib.open(created.case.id), { outcome: "not-found" });
  assert.equal(await lib.update(created.case.id, (data) => ({ ...data, label: "Changed" })), null);
  assert.equal(readFileSync(file, "utf8"), before);

  // Back to the old folder: it opens there again.
  current = oldFolder;
  assert.equal((await lib.open(created.case.id)).outcome, "opened");
});

test("S2: a case folder renamed while the app is open still opens, without going back to Home", async () => {
  const folder = tempFolder();
  const { lib } = library(folder);
  const created = await lib.create({ label: "Old name" });
  assert.ok(created.outcome === "created");
  await lib.list();
  renameSync(path.join(folder, "Old name"), path.join(folder, "New name"));
  const opened = await lib.open(created.case.id);
  assert.equal(opened.outcome, "opened");
  // update finds it too after a second rename.
  renameSync(path.join(folder, "New name"), path.join(folder, "Third name"));
  assert.ok(await lib.update(created.case.id, (data) => ({ ...data, label: "Renamed" })));
  assert.equal(JSON.parse(readFileSync(path.join(folder, "Third name", CASE_FILE_NAME), "utf8")).label, "Renamed");
  // Gone for good: not found, nothing made.
  rmSync(path.join(folder, "Third name"), { recursive: true });
  assert.deepEqual(await lib.open(created.case.id), { outcome: "not-found" });
  assert.deepEqual(readdirSync(folder), []);
});

test("S3 and R3-1: a temporary file a save cut short left in a case folder is never removed", async () => {
  const folder = tempFolder();
  const { lib } = library(folder);
  const created = await lib.create({ label: "Ana" });
  assert.ok(created.outcome === "created");
  const caseFolder = path.join(folder, "Ana");
  // A complete newer copy (a crash between flush and rename), a partial one, look-alikes and a fresh one.
  writeFileSync(path.join(caseFolder, "aba-case.json.99999.tmp"), serializeCaseFile(sample({ id: created.case.id, label: "Ana, newer" })));
  writeFileSync(path.join(caseFolder, "aba-case.json.1.tmp"), "{ half a fi");
  for (const name of ["aba-case.json.99999.tmp", "aba-case.json.1.tmp"]) makeOld(path.join(caseFolder, name));
  writeFileSync(path.join(caseFolder, "aba-case.json.77777.tmp"), "{ being written");
  writeFileSync(path.join(caseFolder, "a.pdf"), "%PDF");
  const before = bytesOf(caseFolder, ["aba-case.json.99999.tmp", "aba-case.json.1.tmp", "aba-case.json.77777.tmp"]);
  assert.equal((await lib.open(created.case.id)).outcome, "opened");
  assert.ok(await lib.update(created.case.id, (data) => ({ ...data, label: "Ana R." })));
  await lib.list();
  assert.deepEqual(bytesOf(caseFolder, ["aba-case.json.99999.tmp", "aba-case.json.1.tmp", "aba-case.json.77777.tmp"]), before);
});

test("M1: an unknown key inside clientAge is kept on save; the interface sees only years and months", async () => {
  const text = serializeCaseFile(sample()).replace('"months": 2', '"months": 2,\n    "note": "x"');
  const read = readCaseFile(text);
  assert.ok(read.ok);
  assert.deepEqual(JSON.parse(serializeCaseFile(read.data)).clientAge, { years: 4, months: 2, note: "x" });

  const folder = tempFolder();
  mkdirSync(path.join(folder, "Ana"));
  writeFileSync(path.join(folder, "Ana", CASE_FILE_NAME), text);
  writeFileSync(path.join(folder, "Ana", "a.pdf"), "%PDF");
  const { lib } = library(folder);
  const opened = await lib.open(ID);
  assert.ok(opened.outcome === "opened");
  assert.deepEqual(opened.case.clientAge, { years: 4, months: 2 });
  assert.deepEqual(JSON.parse(readFileSync(path.join(folder, "Ana", CASE_FILE_NAME), "utf8")).clientAge, { years: 4, months: 2, note: "x" });
});

test("M2: newest first compares times, not text, and ties go by folder name", async () => {
  const folder = tempFolder();
  const write = (name: string, id: string, createdAt: string) => {
    mkdirSync(path.join(folder, name));
    writeFileSync(path.join(folder, name, CASE_FILE_NAME), serializeCaseFile({ ...sample({ id, label: name }), createdAt, updatedAt: createdAt }));
  };
  write("older", "11111111-1111-4111-8111-111111111111", "2026-11-22T15:00:00.5Z");
  write("newer", "22222222-2222-4222-8222-222222222222", "2026-11-22T15:00:00.55Z");
  write("b tie", "33333333-3333-4333-8333-333333333333", "2026-11-01T00:00:00Z");
  write("a tie", "44444444-4444-4444-8444-444444444444", "2026-11-01T00:00:00.000Z");
  const { lib } = library(folder);
  assert.deepEqual(
    (await lib.list()).cases.map((c) => c.label),
    ["newer", "older", "a tie", "b tie"],
  );
});

test("M3: a link to a folder is shown as unreadable, never followed", { skip: process.platform === "win32" }, async () => {
  const folder = tempFolder();
  const elsewhere = tempFolder();
  mkdirSync(path.join(elsewhere, "Real case"));
  writeFileSync(path.join(elsewhere, "Real case", CASE_FILE_NAME), serializeCaseFile(sample()));
  symlinkSync(path.join(elsewhere, "Real case"), path.join(folder, "Linked case"));
  // A link to a file, like a loose file, is not a folder: not listed.
  writeFileSync(path.join(elsewhere, "note.txt"), "x");
  symlinkSync(path.join(elsewhere, "note.txt"), path.join(folder, "note link"));
  const { lib } = library(folder);
  const list = await lib.list();
  assert.deepEqual(list.cases, []);
  assert.deepEqual(list.unreadable, [{ folderName: "Linked case", reason: "link" }]);
  assert.deepEqual(await lib.open(ID), { outcome: "not-found" });
  // Revealing it shows the link itself.
  assert.equal(await lib.unreadableFolderPath("Linked case"), path.join(folder, "Linked case"));
});

test("M4: only folders the last listing showed as unreadable can be revealed", async () => {
  const folder = tempFolder();
  const { lib } = library(folder);
  const created = await lib.create({ label: "Ana" });
  assert.ok(created.outcome === "created");
  mkdirSync(path.join(folder, ".git"));
  mkdirSync(path.join(folder, "Scans"));
  await lib.list();
  assert.equal(await lib.unreadableFolderPath("Ana"), null);
  assert.equal(await lib.unreadableFolderPath(".git"), null);
  assert.equal(await lib.unreadableFolderPath("Scans"), path.join(folder, "Scans"));
});

test("M6: listing never makes Windows' write check; creating a case does", { skip: process.platform === "win32" || isPosixRoot }, async () => {
  const folder = tempFolder();
  chmodSync(folder, 0o555);
  try {
    // platform "win32": the write check is a file made and removed, which this folder refuses.
    const { lib } = library(folder, { platform: "win32" });
    assert.equal((await lib.list()).folder.state, "ready");
    assert.equal((await lib.folderInfo()).state, "ready");
    assert.deepEqual(await lib.create({ label: "Ana" }), { outcome: "folder-problem", problem: "not-writable" });
    assert.equal(await inspectCasesFolder(folder, false, "win32"), "not-writable");
  } finally {
    chmodSync(folder, 0o755);
  }
});

/* Review round 2 */

test("R2-1: a __proto__ key, at the top or inside clientAge, makes the file damaged, and it is never rewritten", async () => {
  const good = serializeCaseFile(sample());
  const top = good.replace('"files": []', '"files": [],\n  "__proto__": { "q": 2 }');
  const inAge = good.replace('"months": 2', '"months": 2,\n    "__proto__": { "p": 1 }');
  // The same key with its first underscore escaped.
  const escaped = good.replace('"files": []', `"files": [],\n  "${BACKSLASH}u005f_proto__": 1`);
  for (const text of [top, inAge, escaped]) {
    assert.notEqual(text, good);
    assert.deepEqual(readCaseFile(text), { ok: false, problem: "damaged" });
  }
  // A key that merely contains it is an ordinary key.
  assert.equal(readCaseFile(good.replace('"files": []', '"files": [],\n  "not__proto__": 1')).ok, true);

  const folder = tempFolder();
  mkdirSync(path.join(folder, "Proto"));
  writeFileSync(path.join(folder, "Proto", CASE_FILE_NAME), top);
  writeFileSync(path.join(folder, "Proto", "a.pdf"), "%PDF");
  const { lib } = library(folder);
  assert.deepEqual((await lib.list()).unreadable, [{ folderName: "Proto", reason: "damaged" }]);
  assert.deepEqual(await lib.open(ID), { outcome: "not-found" });
  assert.equal(await lib.update(ID, (data) => data), null);
  assert.equal(readFileSync(path.join(folder, "Proto", CASE_FILE_NAME), "utf8"), top);
});

test("R2-2: a number that would not be written back as itself makes the file damaged; exact ones read", async () => {
  const good = serializeCaseFile(sample());
  const withNumber = (number: string) => good.replace('"files": []', `"files": [],\n  "later": ${number}`);
  for (const number of ["0.30000000000000000001", "1e-400", "-1e-400", "-0", "-0.0", "123456789.123456789", "2e-324"]) {
    assert.deepEqual(readCaseFile(withNumber(number)), { ok: false, problem: "damaged" }, number);
  }
  for (const number of ["0.1", "1.50", "1e2", "2.5e-3", "1E+21", "9007199254740992", "5e-324", "0", "-1.5"]) {
    assert.equal(readCaseFile(withNumber(number)).ok, true, number);
  }
  // A known field written as 4.0 is still the same value.
  assert.equal(readCaseFile(good.replace('"years": 4', '"years": 4.0')).ok, true);

  const folder = tempFolder();
  mkdirSync(path.join(folder, "Decimal"));
  const text = withNumber("0.30000000000000000001");
  writeFileSync(path.join(folder, "Decimal", CASE_FILE_NAME), text);
  writeFileSync(path.join(folder, "Decimal", "a.pdf"), "%PDF");
  const { lib } = library(folder);
  assert.deepEqual(await lib.open(ID), { outcome: "not-found" });
  assert.equal(readFileSync(path.join(folder, "Decimal", CASE_FILE_NAME), "utf8"), text);
});


/* Review round 3: a case whose creation was interrupted is finished or shown, never deleted */

/** A case folder as a crash during create leaves it, holding one temporary data file. */
function interruptedCreate(casesFolder: string, name: string, text: string, { old = true, pid = 4242 } = {}): string {
  const folder = path.join(casesFolder, name);
  mkdirSync(folder);
  const temporary = path.join(folder, `${CASE_FILE_NAME}.${pid}.tmp`);
  writeFileSync(temporary, text);
  if (old) makeOld(temporary);
  return temporary;
}

const COMPLETE = serializeCaseFile(sample({ label: "Interrupted" }));

test("R3-1: a crash before the temporary file was flushed leaves a partial file: shown as unfinished, nothing changed", async () => {
  const folder = tempFolder();
  interruptedCreate(folder, "Cut short", COMPLETE.slice(0, 60));
  interruptedCreate(folder, "Empty file", "");
  const before = everything(folder);
  const { lib } = library(folder);
  const list = await lib.list();
  assert.deepEqual(list.cases, []);
  assert.deepEqual(list.unreadable, [
    { folderName: "Cut short", reason: "unfinished" },
    { folderName: "Empty file", reason: "unfinished" },
  ]);
  assert.deepEqual(everything(folder), before);
  assert.deepEqual(await lib.open(ID), { outcome: "not-found" });
  assert.deepEqual(everything(folder), before);
});

test("R3-1: a crash after the flush (before or after the rename) leaves a complete case: the listing finishes or lists it", async () => {
  const folder = tempFolder();
  interruptedCreate(folder, "Interrupted", COMPLETE);
  // After the rename (and before the folder was flushed): an ordinary case.
  mkdirSync(path.join(folder, "Renamed"));
  writeFileSync(path.join(folder, "Renamed", CASE_FILE_NAME), serializeCaseFile(sample({ id: "88888888-8888-4888-8888-888888888888", label: "Renamed" })));
  const { lib, logged } = library(folder);
  const list = await lib.list();
  assert.deepEqual(list.unreadable, []);
  assert.deepEqual(
    list.cases.map((c) => [c.id, c.label]).sort(),
    [
      [ID, "Interrupted"],
      ["88888888-8888-4888-8888-888888888888", "Renamed"],
    ],
  );
  assert.deepEqual(readdirSync(path.join(folder, "Renamed")), [CASE_FILE_NAME]);
  // The same bytes, now under the data file's name; nothing else in the folder.
  assert.deepEqual(readdirSync(path.join(folder, "Interrupted")), [CASE_FILE_NAME]);
  assert.equal(readFileSync(path.join(folder, "Interrupted", CASE_FILE_NAME), "utf8"), COMPLETE);
  assert.equal(logged.length, 1);
  assert.equal((await lib.open(ID)).outcome, "opened");
});

test("R3-1: a complete temporary file changed in the last minute waits; once left behind it is finished, whatever its process id", async () => {
  const folder = tempFolder();
  interruptedCreate(folder, "Fresh", COMPLETE, { old: false });
  // Named after this process (a crashed earlier run with the same id), but not being written now.
  interruptedCreate(folder, "Same id", serializeCaseFile(sample({ id: "22222222-2222-4222-8222-222222222222", label: "Same process id" })), { pid: process.pid, old: false });
  const before = everything(folder);
  const { lib } = library(folder);
  assert.deepEqual((await lib.list()).unreadable, [
    { folderName: "Fresh", reason: "unfinished" },
    { folderName: "Same id", reason: "unfinished" },
  ]);
  assert.deepEqual(everything(folder), before);
  // A minute later, both are finished.
  makeOld(path.join(folder, "Fresh", `${CASE_FILE_NAME}.4242.tmp`));
  makeOld(path.join(folder, "Same id", `${CASE_FILE_NAME}.${process.pid}.tmp`));
  assert.deepEqual(
    (await lib.list()).cases.map((c) => c.label).sort(),
    ["Interrupted", "Same process id"],
  );
});

test("R3-1: a folder holding a temporary data file and anything else is never touched", async () => {
  const folder = tempFolder();
  const withPdf = interruptedCreate(folder, "With a PDF", COMPLETE);
  writeFileSync(path.join(path.dirname(withPdf), "a.pdf"), "%PDF");
  const withDsStore = interruptedCreate(folder, "With .DS_Store", serializeCaseFile(sample({ id: "33333333-3333-4333-8333-333333333333" })));
  writeFileSync(path.join(path.dirname(withDsStore), ".DS_Store"), "x");
  const withFolder = interruptedCreate(folder, "With a folder", serializeCaseFile(sample({ id: "44444444-4444-4444-8444-444444444444" })));
  mkdirSync(path.join(path.dirname(withFolder), `${CASE_FILE_NAME}.2.tmp`));
  // Two complete candidates: which one the user wants cannot be told.
  const two = interruptedCreate(folder, "Two copies", serializeCaseFile(sample({ id: "55555555-5555-4555-8555-555555555555" })));
  writeFileSync(path.join(path.dirname(two), `${CASE_FILE_NAME}.4243.tmp`), serializeCaseFile(sample({ id: "66666666-6666-4666-8666-666666666666" })));
  makeOld(path.join(path.dirname(two), `${CASE_FILE_NAME}.4243.tmp`));
  // Complete but not lossless (R2-1), and complete but with the id of a case already there.
  interruptedCreate(folder, "Proto", COMPLETE.replace('"files": []', '"files": [],\n  "__proto__": {}'));
  mkdirSync(path.join(folder, "Existing"));
  writeFileSync(path.join(folder, "Existing", CASE_FILE_NAME), serializeCaseFile(sample({ id: "77777777-7777-4777-8777-777777777777", label: "Existing" })));
  interruptedCreate(folder, "Same id", serializeCaseFile(sample({ id: "77777777-7777-4777-8777-777777777777", label: "Same id" })));
  const before = everything(folder);
  const { lib } = library(folder);
  const list = await lib.list();
  assert.deepEqual(
    list.cases.map((c) => c.label),
    ["Existing"],
  );
  assert.deepEqual(list.unreadable, [
    { folderName: "Proto", reason: "unfinished" },
    { folderName: "Same id", reason: "unfinished" },
    { folderName: "Two copies", reason: "unfinished" },
    { folderName: "With .DS_Store", reason: "unfinished" },
    { folderName: "With a PDF", reason: "unfinished" },
    { folderName: "With a folder", reason: "unfinished" },
  ]);
  assert.deepEqual(everything(folder), before);
});

test("R3-1 and M3-1: a link named like a temporary data file is never followed or finished", { skip: process.platform === "win32" }, async () => {
  const folder = tempFolder();
  const elsewhere = tempFolder();
  writeFileSync(path.join(elsewhere, "a case.json"), COMPLETE);
  makeOld(path.join(elsewhere, "a case.json"));
  mkdirSync(path.join(folder, "Linked"));
  symlinkSync(path.join(elsewhere, "a case.json"), path.join(folder, "Linked", `${CASE_FILE_NAME}.1.tmp`));
  const before = [...everything(folder), ...everything(elsewhere)];
  const { lib } = library(folder);
  const list = await lib.list();
  assert.deepEqual(list.cases, []);
  assert.deepEqual(list.unreadable, [{ folderName: "Linked", reason: "not-a-case" }]);
  assert.deepEqual([...everything(folder), ...everything(elsewhere)], before);
});

test("R3-1: a creation that crashed for real (the save never renamed its file) is finished on the next listing", async () => {
  const folder = tempFolder();
  // The save writes its temporary file under a dead process's id, then the process dies before the rename.
  const crashing = library(folder, {
    writeFile: async (file, text) => {
      writeFileSync(`${file}.4242.tmp`, text);
      makeOld(`${file}.4242.tmp`);
      throw new Error("the process stopped here (simulated)");
    },
  });
  // In a real crash nothing after this runs; here the failed save reports not-saved, and
  // its cleanup cannot remove the folder because the temporary file is in it.
  assert.deepEqual(await crashing.lib.create({ label: "Ana" }), { outcome: "not-saved" });
  assert.deepEqual(readdirSync(path.join(folder, "Ana")), [`${CASE_FILE_NAME}.4242.tmp`]);
  const { lib } = library(folder);
  assert.deepEqual(
    (await lib.list()).cases.map((c) => c.label),
    ["Ana"],
  );
  assert.deepEqual(readdirSync(path.join(folder, "Ana")), [CASE_FILE_NAME]);
});

/* Review round 4 */

test("R4-1: opening and saving a case never touches a leftover named after this process's id", async () => {
  const folder = tempFolder();
  const { lib } = library(folder);
  const created = await lib.create({ label: "Ana" });
  assert.ok(created.outcome === "created");
  const caseFolder = path.join(folder, "Ana");
  const leftover = path.join(caseFolder, `${CASE_FILE_NAME}.${process.pid}.tmp`);
  const newer = serializeCaseFile(sample({ id: created.case.id, label: "Ana, newer" }));
  writeFileSync(leftover, newer);
  makeOld(leftover);
  writeFileSync(path.join(caseFolder, "a.pdf"), "%PDF");
  const opened = await lib.open(created.case.id);
  assert.ok(opened.outcome === "opened");
  // The PDF list was saved (under another temporary name), and the leftover is as it was.
  assert.deepEqual(opened.case.files.map((f) => f.name), ["a.pdf"]);
  assert.equal(JSON.parse(readFileSync(path.join(caseFolder, CASE_FILE_NAME), "utf8")).files.length, 1);
  assert.ok(await lib.update(created.case.id, (data) => ({ ...data, label: "Ana R." })));
  assert.equal(readFileSync(leftover, "utf8"), newer);
  assert.deepEqual(readdirSync(caseFolder).sort(), ["a.pdf", CASE_FILE_NAME, path.basename(leftover)].sort());
});

test("R4-2: a complete temporary file next to a partial one is not chosen: shown as unfinished, untouched", async () => {
  const folder = tempFolder();
  interruptedCreate(folder, "Two saves", COMPLETE);
  writeFileSync(path.join(folder, "Two saves", `${CASE_FILE_NAME}.4243.tmp`), COMPLETE.slice(0, 50));
  makeOld(path.join(folder, "Two saves", `${CASE_FILE_NAME}.4243.tmp`));
  const before = everything(folder);
  const { lib } = library(folder);
  const list = await lib.list();
  assert.deepEqual(list.cases, []);
  assert.deepEqual(list.unreadable, [{ folderName: "Two saves", reason: "unfinished" }]);
  assert.deepEqual(everything(folder), before);
});

test("R4-1: Windows' write check never removes a file it did not create", async () => {
  const folder = tempFolder();
  // A check that a crashed run with this process id left behind.
  const leftover = path.join(folder, `.aba-workbench-write-check-${process.pid}.tmp`);
  writeFileSync(leftover, "not this check's");
  assert.equal(await inspectCasesFolder(folder, false, "win32"), "ready");
  assert.deepEqual(readdirSync(folder), [path.basename(leftover)]);
  assert.equal(readFileSync(leftover, "utf8"), "not this check's");
});
