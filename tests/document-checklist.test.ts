import assert from "node:assert/strict";
import { test } from "node:test";
import { SOURCE_TYPES, type SourceSummary, type SourceType } from "../src/shared/sources.ts";
import { CHECKLIST, checklistTypeOf, documentList, folderFileKey, stepChecks } from "../src/renderer/src/document-checklist.ts";

/*
 * The Documentos step's checklist (owner's decision T14, display only, from the source
 * types) and the list in its order; the rail's soft hint (P5).
 */

let next = 0;
function doc(type: SourceType, kind: "text" | "pdf" = "text"): SourceSummary {
  next++;
  const base = { id: `id-${next}`, type, title: null, date: null, addedAt: "2026-11-23T10:00:00.000Z", updatedAt: "2026-11-23T10:00:00.000Z", removedAt: null };
  return kind === "text"
    ? { ...base, kind, characters: 10, preview: "Invented." }
    : { ...base, kind, fileName: `${type}-${next}.pdf`, bytes: 1000, present: true, sizeWarning: null };
}

test("checklist: every source type has its row, in the order of an initial assessment, ABLLS-R after BASC-3", () => {
  assert.deepEqual(
    CHECKLIST.map((row) => row.type),
    ["cde", "parent-interview", "direct-observation", "fba-questionnaire", "vineland-3", "basc-3", "iep", "ablls-r", "other"],
  );
  assert.deepEqual([...SOURCE_TYPES].sort(), CHECKLIST.map((row) => row.type).sort());
  for (const type of SOURCE_TYPES) assert.equal(checklistTypeOf(type), type);
  // ABLLS-R and "other" are not part of every assessment; the rest are.
  assert.deepEqual(
    CHECKLIST.filter((row) => !row.expected).map((row) => row.type),
    ["ablls-r", "other"],
  );
});

test("checklist: the list follows the checklist's order, documents under their type, dashed rows for the expected types not added", () => {
  const vineland = doc("vineland-3", "pdf");
  const cdeOne = doc("cde");
  const other = doc("other");
  const cdeTwo = doc("cde", "pdf");
  const ablls = doc("ablls-r", "pdf");
  const entries = documentList([vineland, cdeOne, other, cdeTwo, ablls]);
  assert.deepEqual(
    entries.map((entry) => (entry.kind === "document" ? entry.source.id : `missing:${entry.row.type}`)),
    [cdeOne.id, cdeTwo.id, "missing:parent-interview", "missing:direct-observation", "missing:fba-questionnaire", vineland.id, "missing:basc-3", "missing:iep", ablls.id, other.id],
  );
  // With documents, ABLLS-R and "other" leave no dashed row when there is none of them.
  const one = documentList([doc("cde")]);
  assert.equal(
    one.some((entry) => entry.kind === "missing" && (entry.row.type === "ablls-r" || entry.row.type === "other")),
    false,
  );
  assert.equal(one.filter((entry) => entry.kind === "missing").length, 6);
});

test("checklist: the rail's checks name what is still missing (P5, a soft hint, never a gate)", () => {
  assert.deepEqual(stepChecks([]), { coreMissing: ["cde", "parent-interview", "direct-observation"], scoresMissing: ["vineland-3", "basc-3"], hasIep: false });
  assert.deepEqual(stepChecks([doc("cde"), doc("direct-observation"), doc("basc-3", "pdf"), doc("iep")]), {
    coreMissing: ["parent-interview"],
    scoresMissing: ["vineland-3"],
    hasIep: true,
  });
  assert.deepEqual(stepChecks([doc("cde"), doc("parent-interview"), doc("direct-observation"), doc("vineland-3", "pdf"), doc("basc-3", "pdf")]).coreMissing, []);
});

test("checklist: an ignored folder PDF is known by its name, size and date, so a changed file shows again", () => {
  const file = { name: "school report.pdf", bytes: 85_000, modifiedAt: "2026-11-20T10:00:00.000Z" };
  assert.equal(folderFileKey(file), folderFileKey({ ...file }));
  assert.notEqual(folderFileKey(file), folderFileKey({ ...file, bytes: 86_000 }));
  assert.notEqual(folderFileKey(file), folderFileKey({ ...file, modifiedAt: "2026-11-21T10:00:00.000Z" }));
});
