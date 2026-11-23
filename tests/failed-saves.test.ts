import assert from "node:assert/strict";
import { test } from "node:test";
import { DEVELOPMENT_ONLY_ROLES, appMenuTemplate } from "../src/main/app-menu.ts";
import { FailedSaves, saveKey, type SaveOp } from "../src/main/failed-saves.ts";
import type { CaseSources, SourceSaveResult } from "../src/shared/sources.ts";

/* Changes that could not be saved, kept by the main process (review round 2, R1). */

const CASE = "3f0c1a2b-4c5d-4e6f-8a9b-0c1d2e3f4a5b";
const SOURCE = "11111111-1111-4111-8111-111111111111";
const SOURCES = { sources: [], files: [], totalPdfWarning: null, pdfLimits: { chatgpt: 1, claude: 1 }, updatedAt: "2026-11-22T15:00:00.000Z" } as CaseSources;
const saved: SourceSaveResult = { outcome: "saved", sources: SOURCES, sourceId: SOURCE };

function store(answers: Array<SourceSaveResult | Error>) {
  const ran: SaveOp[] = [];
  let ids = 0;
  let clock = 0;
  const failed = new FailedSaves({
    run: async (_caseId, op) => {
      ran.push(op);
      const answer = answers.shift() ?? saved;
      if (answer instanceof Error) throw answer;
      return answer;
    },
    labelOf: (caseId) => (caseId === CASE ? "M.F. sample case" : null),
    newId: () => `id-${++ids}`,
    now: () => ++clock,
  });
  return { failed, ran };
}

test("failed saves: a change that could not be saved is kept with what it wrote, and Try again runs it again", async () => {
  const { failed, ran } = store([{ outcome: "not-saved" }, saved]);
  const op: SaveOp = { kind: "change", sourceId: SOURCE, change: { text: "Typed before reload." } };
  assert.deepEqual(await failed.save(CASE, op), { outcome: "not-saved" });
  assert.deepEqual(failed.list(), [{ id: "id-1", caseId: CASE, label: "M.F. sample case", failure: "not-saved", about: "source", sectionId: null }]);
  assert.equal(failed.size, 1);
  assert.deepEqual(await failed.retry("id-1"), saved);
  assert.deepEqual(ran, [op, op]);
  assert.deepEqual(failed.list(), []);
  assert.deepEqual(await failed.retry("id-1"), { outcome: "source-not-found" });
});

test("failed saves: a later saved change of the same thing replaces a failed one; another thing does not", async () => {
  const { failed } = store([{ outcome: "not-saved" }, { outcome: "case-full" }, saved, saved]);
  await failed.save(CASE, { kind: "change", sourceId: SOURCE, change: { text: "a" } });
  await failed.save(CASE, { kind: "change", sourceId: SOURCE, change: { title: "T" } });
  assert.equal(failed.size, 2);
  // The text saved later: the failed text is no longer offered; the title still is.
  await failed.save(CASE, { kind: "change", sourceId: SOURCE, change: { text: "ab" } });
  assert.deepEqual(failed.list().map((item) => item.failure), ["case-full"]);
  await failed.save(CASE, { kind: "change", sourceId: SOURCE, change: { title: "T2" } });
  assert.equal(failed.size, 0);
  assert.notEqual(saveKey(CASE, { kind: "change", sourceId: SOURCE, change: { text: "" } }), saveKey(CASE, { kind: "removed", sourceId: SOURCE, removed: true }));
});

test("failed saves: a new text failing again as it grows is one entry; a different new text never clears it", async () => {
  const { failed } = store([{ outcome: "not-saved" }, { outcome: "not-saved" }, saved, saved]);
  await failed.save(CASE, { kind: "add-text", input: { type: "cde", text: "First" } });
  await failed.save(CASE, { kind: "add-text", input: { type: "cde", text: "First words" } });
  assert.equal(failed.size, 1);
  // Another new text is saved: the failed draft is still offered.
  await failed.save(CASE, { kind: "add-text", input: { type: "iep", text: "Something else" } });
  assert.equal(failed.size, 1);
  // The same draft, typed on, is saved: it replaces the failed one.
  await failed.save(CASE, { kind: "add-text", input: { type: "cde", text: "First words and more" } });
  assert.equal(failed.size, 0);
});

test("failed saves: an unexpected error is kept; a refused input is not", async () => {
  const { failed } = store([new Error("disk exploded"), new Error("Refused: not a source id.")]);
  await assert.rejects(failed.save(CASE, { kind: "removed", sourceId: SOURCE, removed: true }), /exploded/);
  await assert.rejects(failed.save(CASE, { kind: "removed", sourceId: "x", removed: true }), /Refused/);
  assert.deepEqual(failed.list(), [{ id: "id-1", caseId: CASE, label: "M.F. sample case", failure: "error", about: "source", sectionId: null }]);
});

/* The packaged app's menu */

function roles(items: unknown[]): string[] {
  return items.flatMap((item) => {
    const entry = item as { role?: string; submenu?: unknown[] };
    return [...(entry.role ? [entry.role] : []), ...(Array.isArray(entry.submenu) ? roles(entry.submenu) : [])];
  });
}

test("menu: a development build keeps Electron's default; the packaged app has no Reload or developer tools, and keeps Edit", () => {
  assert.equal(appMenuTemplate({ packaged: false, platform: "darwin" }), null);
  for (const platform of ["darwin", "win32", "linux"] as const) {
    const template = appMenuTemplate({ packaged: true, platform });
    assert.ok(template);
    const all = roles(template);
    for (const role of DEVELOPMENT_ONLY_ROLES) assert.equal(all.includes(role), false, `${platform}: ${role}`);
    assert.ok(all.includes("editMenu"), platform);
    assert.equal(all.includes("appMenu"), platform === "darwin", platform);
  }
});
