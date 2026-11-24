import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { CASE_FILE_NAME, CASE_SCHEMA_VERSION, newCaseData, readCaseFile, readableCaseFileText, serializeCaseFile, type CaseData } from "../src/main/case-file.ts";
import { CaseMapService } from "../src/main/case-map-service.ts";
import { CaseLibrary } from "../src/main/cases.ts";
import { writeFileDurably } from "../src/main/durable-write.ts";
import { FailedSaves, runSaves } from "../src/main/failed-saves.ts";
import { addMapItem, approveMapPart, caseMapSummary, caseMapView, mapPartView, mergeInput, parseItemInput, removeMapItem, saveMapItem, setMapPartVersion, type StoredCaseMap } from "../src/main/case-map.ts";
import { baselineMean, MAP_PART_LIMITS, mapPartStatus } from "../src/shared/case-map.ts";

/*
 * The case map inside the case's data file (schema version 4): the migration from version
 * 3, every part's history and status, what she changes becoming hers, and the limits.
 * Invented data only.
 */

const ID = "3f0c1a2b-4c5d-4e6f-8a9b-0c1d2e3f4a5b";
const T0 = "2026-11-23T10:00:00.000Z";
const T1 = "2026-11-23T10:01:00.000Z";
const T2 = "2026-11-23T10:02:00.000Z";
const T3 = "2026-11-23T10:03:00.000Z";

function blank(): CaseData {
  return newCaseData({ id: ID, label: "Invented map case", clientAge: null, now: new Date(T0) });
}

const claim = (value: string, check: string | null = null) => ({ value, check });
const sourceClaim = (value: string) => ({ value, refs: [{ kind: "source", sourceId: "11111111-2222-4333-8444-555555555555", quote: value }], origin: "extracted", check: null });

/** A case whose behaviors part has an AI version (kind "ai") with one behavior drafted from a source. */
function withAiBehaviors(): CaseData {
  const map: StoredCaseMap = {
    parts: {
      behaviors: {
        currentVersion: 1,
        approvedVersion: null,
        versions: [
          {
            number: 1,
            kind: "ai",
            createdAt: T0,
            extraction: "ex-1",
            content: {
              items: [
                {
                  id: "beh-1",
                  name: sourceClaim("Spitting"),
                  topographies: [sourceClaim("spits toward the adult's arm"), sourceClaim("spits on the floor")],
                  function: { primary: ["escape"], secondary: [], origin: "hypothesis", evidence: [], reasoning: "ABC data point to escape.", check: null },
                },
              ],
              groups: [],
            },
          },
        ],
      },
    },
  };
  return { ...blank(), caseMap: map };
}

test("case map: a version 3 file reads with no map, and is written back whole in the current version", () => {
  const v3 = { ...JSON.parse(serializeCaseFile(blank())), schemaVersion: 3, kept: { by: "a later app" } };
  const read = readCaseFile(JSON.stringify(v3));
  assert.ok(read.ok);
  assert.equal(read.migratedFrom, 3);
  assert.equal("caseMap" in read.data, false, "no map until she drafts or types one (D7)");
  const text = readableCaseFileText(read.data);
  assert.ok(text);
  const written = JSON.parse(text);
  assert.equal(written.schemaVersion, CASE_SCHEMA_VERSION);
  assert.deepEqual(written.kept, { by: "a later app" }, "unknown keys are kept");
  assert.equal("caseMap" in written, false);
});

test("case map: a map read and saved again keeps every key, kind and part this version does not know", () => {
  const data = withAiBehaviors();
  const json = JSON.parse(serializeCaseFile(data));
  json.caseMap.kept = 1;
  json.caseMap.parts.plan = { currentVersion: null, approvedVersion: null, versions: [], futureKey: true };
  const version = json.caseMap.parts.behaviors.versions[0];
  version.futureKey = "kept";
  version.content.futureKey = "kept";
  const behavior = version.content.items[0];
  behavior.futureField = { any: "thing" };
  behavior.name.origin = "a-newer-origin";
  behavior.name.refs.push({ kind: "a-newer-ref", somewhere: 3 });
  behavior.function.primary.push("a-newer-function");
  const text = JSON.stringify(json, null, 2) + "\n";
  const read = readCaseFile(text);
  assert.ok(read.ok, "read");
  assert.equal(read.migratedFrom, null);
  assert.equal(serializeCaseFile(read.data), text, "written back byte for byte");
  // The interface still sees the behavior, with every field filled in.
  const view = mapPartView(read.data, "behaviors");
  assert.equal(view.status, "draft");
  assert.equal(view.items.length, 1);
  assert.deepEqual((view.items[0] as { examples: unknown[] }).examples, []);
});

test("case map: a stored map past a limit, or with a bad item, makes the file damaged (never rewritten with less)", () => {
  const tooMany = withAiBehaviors();
  const items = Array.from({ length: MAP_PART_LIMITS.behaviors + 1 }, (_, index) => ({ id: `beh-${index + 1}` }));
  tooMany.caseMap!.parts.behaviors.versions[0].content.items = items;
  assert.equal(readCaseFile(serializeCaseFile(tooMany)).ok, false);

  const longQuote = withAiBehaviors();
  (longQuote.caseMap!.parts.behaviors.versions[0].content.items[0] as Record<string, unknown>).name = { ...sourceClaim("Spitting"), refs: [{ kind: "source", quote: "x".repeat(301) }] };
  assert.equal(readCaseFile(serializeCaseFile(longQuote)).ok, false);

  const badId = withAiBehaviors();
  badId.caseMap!.parts.behaviors.versions[0].content.items[0].id = "../beh";
  assert.equal(readCaseFile(serializeCaseFile(badId)).ok, false);

  const twice = withAiBehaviors();
  twice.caseMap!.parts.behaviors.versions[0].content.items.push({ id: "beh-1" });
  assert.equal(readCaseFile(serializeCaseFile(twice)).ok, false, "an id twice in one version");
});

test("case map: her editing pass changes in place; approving, then editing, starts a new version; going back moves the pointer", () => {
  let data = blank();
  const added = addMapItem(data, "caregivers", "items", { role: claim("Mother") }, null, T1);
  assert.equal(added.version, 1);
  assert.equal(added.itemId, "cg-1");
  data = added.data;
  assert.equal(mapPartView(data, "caregivers").status, "corrected");

  // The same editing pass: version 1 changes, no new version.
  const typed = saveMapItem(data, "caregivers", "items", "cg-1", { language: claim("Spanish") }, 1, T2);
  assert.ok(typed && typed !== "item-not-found");
  data = typed.data;
  let part = data.caseMap!.parts.caregivers;
  assert.equal(part.versions.length, 1);
  assert.equal(part.versions[0].updatedAt, T2);

  // Nothing changed: no save.
  assert.equal(saveMapItem(data, "caregivers", "items", "cg-1", { language: claim("Spanish") }, 1, T2), null);

  const approved = approveMapPart(data, "caregivers", 1, T2);
  assert.ok(approved);
  data = approved;
  assert.equal(mapPartView(data, "caregivers").status, "approved");
  assert.equal(caseMapSummary(data).approved, 1);

  // Approved content never changes: the edit is version 2, and the approval goes (she approves again).
  const after = saveMapItem(data, "caregivers", "items", "cg-1", { availability: claim("Tuesdays and Thursdays") }, 1, T3);
  assert.ok(after && after !== "item-not-found");
  data = after.data;
  part = data.caseMap!.parts.caregivers;
  assert.equal(after.version, 2);
  assert.equal(part.versions[1].basedOn, 1);
  assert.equal(part.approvedVersion, null);
  assert.equal(mapPartView(data, "caregivers").status, "corrected");
  assert.equal(part.versions[0].content.items[0].availability, null, "version 1 is as approved");

  // Going back shows version 1; an edit then starts version 3 from it, even with the old editing pass.
  const back = setMapPartVersion(data, "caregivers", 1);
  assert.ok(back);
  data = back;
  assert.equal(mapPartView(data, "caregivers").currentVersion, 1);
  const fromOne = saveMapItem(data, "caregivers", "items", "cg-1", { limits: claim("Works evenings") }, 2, T3);
  assert.ok(fromOne && fromOne !== "item-not-found");
  assert.equal(fromOne.version, 3);
  assert.equal(fromOne.data.caseMap!.parts.caregivers.versions[2].basedOn, 1);
  assert.equal(setMapPartVersion(data, "caregivers", 9), null, "no such version");
  assert.equal(approveMapPart(data, "caregivers", 9, T3), null);
});

test("case map: a version she ever approved is never changed in place, even after she took the approval back (review round 2, R2-1)", () => {
  let data = blank();
  const added = addMapItem(data, "behaviors", "items", { name: claim("Spitting") }, null, T1);
  data = added.data;
  const typed = saveMapItem(data, "behaviors", "items", "beh-1", { definition: claim("Any instance of spitting toward a person.") }, added.version, T1);
  assert.ok(typed && typed !== "item-not-found");
  assert.equal(typed.version, 1, "her editing pass");
  data = approveMapPart(typed.data, "behaviors", 1, T2)!;
  data = approveMapPart(data, "behaviors", null, T2)!; // she takes it back
  assert.equal(data.caseMap!.parts.behaviors.versions[0].approvedOnce, true);
  // Her next keystroke names the same editing pass: it must not touch version 1.
  const again = saveMapItem(data, "behaviors", "items", "beh-1", { definition: claim("Any instance of spitting toward or at a person.") }, 1, T3);
  assert.ok(again && again !== "item-not-found");
  assert.equal(again.version, 2, "a new version");
  const versions = again.data.caseMap!.parts.behaviors.versions;
  assert.equal((versions[0].content.items[0] as Record<string, { value: string }>).definition.value, "Any instance of spitting toward a person.", "what she approved stays recorded");
  assert.equal(versions[1].basedOn, 1);
  assert.ok(readableCaseFileText(again.data), "the mark reads back");
});

test("case map: an edited line takes the source of the line at its place only when no line was added or removed (review round 2, R2-2)", () => {
  const a = { value: "A", refs: [{ kind: "source", sourceId: "11111111-2222-4333-8444-555555555555", quote: "A" }], origin: "extracted", check: null };
  const b = { value: "B", refs: [{ kind: "source", sourceId: "11111111-2222-4333-8444-555555555555", quote: "B" }], origin: "extracted", check: null };
  const c = { value: "C", refs: [{ kind: "source", sourceId: "11111111-2222-4333-8444-555555555555", quote: "C" }], origin: "extracted", check: null };
  // A removed and B edited in one save: B' must not take A's source.
  const shifted = mergeInput([claim("B edited"), claim("C")], [a, b, c]) as Array<{ refs: Array<{ kind: string; quote?: string }> }>;
  assert.deepEqual(shifted[0].refs, [{ kind: "her" }]);
  assert.equal(shifted[1].refs[0].quote, "C");
  // Same number of lines: the edited line keeps the source of the line it replaced.
  const inPlace = mergeInput([claim("A"), claim("B edited"), claim("C")], [a, b, c]) as Array<{ refs: Array<{ kind: string; quote?: string }> }>;
  assert.deepEqual(
    inPlace[1].refs.map((ref) => ref.quote ?? ref.kind),
    ["her", "B"],
  );
});

test("case map: a stored claim holds at most ten refs where it came from and one of hers (review round 2, R2-3)", () => {
  const sources = (count: number) => Array.from({ length: count }, (_, index) => ({ kind: "source", quote: `q${index}` }));
  const withRefs = (refs: unknown[]) => {
    const data = withAiBehaviors();
    (data.caseMap!.parts.behaviors.versions[0].content.items[0] as Record<string, unknown>).name = { value: "Spitting", refs, origin: "extracted", check: null };
    return readCaseFile(serializeCaseFile(data)).ok;
  };
  assert.equal(withRefs(sources(10)), true);
  assert.equal(withRefs([{ kind: "her" }, ...sources(10)]), true);
  assert.equal(withRefs(sources(11)), false, "eleven sources: damaged, never edited into twelve");
  assert.equal(withRefs([{ kind: "her" }, { kind: "her" }]), false);
});

test("case map: removing an item makes a version without it; the earlier version keeps it, and its id is never reused", () => {
  let data = blank();
  data = addMapItem(data, "behaviors", "items", { name: claim("Hair pulling") }, null, T1).data;
  data = approveMapPart(data, "behaviors", 1, T1)!;
  const removed = removeMapItem(data, "behaviors", "items", "beh-1", null, T2);
  assert.ok(removed !== "item-not-found");
  data = removed.data;
  const part = data.caseMap!.parts.behaviors;
  assert.equal(part.versions.length, 2);
  assert.equal(part.versions[0].content.items.length, 1, "kept in version 1");
  assert.equal(part.versions[1].content.items.length, 0);
  assert.equal(removeMapItem(data, "behaviors", "items", "beh-1", 2, T2), "item-not-found");
  const again = addMapItem(data, "behaviors", "items", { name: claim("Spitting") }, 2, T3);
  assert.equal(again.itemId, "beh-2", "an id is never reused");
  // Back to version 1 brings it back.
  assert.equal(mapPartView(setMapPartVersion(again.data, "behaviors", 1)!, "behaviors").items.length, 1);
});

test("case map: the sidebar's count is of parts with something in them: a part approved while empty is not counted (case map speed)", () => {
  let data = blank();
  data = addMapItem(data, "behaviors", "items", { name: claim("Hair pulling") }, null, T1).data;
  data = addMapItem(data, "caregivers", "items", { role: claim("Mother") }, null, T1).data;
  const removed = removeMapItem(data, "caregivers", "items", "cg-1", null, T2);
  assert.ok(removed !== "item-not-found");
  // The caregivers' version 2 holds nothing, and she approves it.
  data = approveMapPart(removed.data, "caregivers", 2, T2)!;
  assert.equal(mapPartView(data, "caregivers").status, "approved");
  assert.deepEqual(caseMapSummary(data), { approved: 0, withContent: 1 }, "approved never exceeds the parts with content");
  data = approveMapPart(data, "behaviors", 1, T3)!;
  assert.deepEqual(caseMapSummary(data), { approved: 1, withContent: 1 });
});

test("case map: a part's status follows the version shown (D2)", () => {
  assert.equal(mapPartStatus([], null, null), "empty");
  assert.equal(mapPartStatus([{ number: 1, kind: "ai" }], 1, null), "draft");
  assert.equal(mapPartStatus([{ number: 1, kind: "update" }], 1, null), "draft");
  assert.equal(mapPartStatus([{ number: 1, kind: "ai" }, { number: 2, kind: "edited" }], 2, null), "corrected");
  assert.equal(mapPartStatus([{ number: 1, kind: "ai" }, { number: 2, kind: "edited" }], 2, 2), "approved");
  assert.equal(mapPartStatus([{ number: 1, kind: "ai" }, { number: 2, kind: "edited" }], 1, 2), "draft", "approved is the version shown only");
  assert.equal(mapPartStatus([{ number: 1, kind: "a-newer-kind" }], 1, null), "corrected", "a kind this version does not know is hers to review");
  const view = caseMapView(blank());
  assert.equal(view.parts.client.status, "empty");
  assert.equal(view.revision, T0);
  assert.deepEqual(caseMapSummary(blank()), { approved: 0, withContent: 0 });
});

test("case map: what she changes becomes hers; what she leaves keeps where it came from (D3)", () => {
  let data = withAiBehaviors();
  const input = {
    name: claim("Spitting"),
    topographies: [claim("spits toward the adult's arm"), claim("spits toward the adult's face")],
  };
  const saved = saveMapItem(data, "behaviors", "items", "beh-1", input, null, T1);
  assert.ok(saved && saved !== "item-not-found");
  data = saved.data;
  const part = data.caseMap!.parts.behaviors;
  assert.equal(part.versions.length, 2, "an AI version never changes");
  assert.equal(part.versions[1].kind, "edited");
  type Loose = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- reading stored JSON in a test
  const behavior = part.versions[1].content.items[0] as Loose;
  assert.equal(behavior.name.origin, "extracted", "the name she kept keeps its source");
  assert.equal(behavior.name.refs[0].kind, "source");
  assert.equal(behavior.topographies[0].origin, "extracted", "an untouched line keeps its source");
  assert.equal(behavior.topographies[1].origin, "her");
  // The line she edited keeps the source of the line it replaced, after her own ref (review round 1, S4).
  assert.deepEqual(
    behavior.topographies[1].refs.map((ref: { kind: string }) => ref.kind),
    ["her", "source"],
  );
  assert.equal(behavior.topographies[1].refs[1].quote, "spits on the floor");
  assert.equal(behavior.editedAt, T1);
  assert.equal(mapPartView(data, "behaviors").status, "corrected");

  // A changed value that came from a source is hers, with the source kept after her ref.
  const changed = mergeInput({ value: "Spitting at people", check: null }, sourceClaim("Spitting")) as Loose;
  assert.equal(changed.origin, "her");
  assert.deepEqual(
    changed.refs.map((ref: { kind: string }) => ref.kind),
    ["her", "source"],
  );
  // A [CHECK] she edits keeps the value's origin.
  const checked = mergeInput({ value: "Spitting", check: "her section says 3 on 11/04" }, sourceClaim("Spitting")) as Loose;
  assert.equal(checked.origin, "extracted");
  assert.equal(checked.check, "her section says 3 on 11/04");

  // The function is a hypothesis until she changes it; then it is hers.
  const fn = saveMapItem(data, "behaviors", "items", "beh-1", { function: { primary: ["escape"], secondary: ["attention"], evidence: [], reasoning: "ABC data point to escape.", check: null } }, saved.version, T2);
  assert.ok(fn && fn !== "item-not-found");
  assert.equal((fn.data.caseMap!.parts.behaviors.versions[1].content.items[0] as Loose).function.origin, "her");
  const same = saveMapItem(data, "behaviors", "items", "beh-1", { function: { primary: ["escape"], secondary: [], evidence: [], reasoning: "ABC data point to escape.", check: null } }, saved.version, T2);
  assert.equal(same, null, "the same function is no change");
});

test("case map: groups by hand; a behavior is in one group only, and a removed behavior leaves its group", () => {
  let data = blank();
  data = addMapItem(data, "behaviors", "items", { name: claim("Spitting") }, null, T1).data;
  data = addMapItem(data, "behaviors", "items", { name: claim("Hair pulling") }, 1, T1).data;
  const group = addMapItem(data, "behaviors", "groups", { behaviorIds: ["beh-1", "beh-2"], nature: "Aggression toward others", function: "escape", measure: "frequency", reason: "Same response class and function." }, 1, T1);
  assert.equal(group.itemId, "grp-1");
  data = group.data;
  assert.equal(mapPartView(data, "behaviors").groups[0].origin, "her");
  // A behavior ticked into another group moves there: never refused, so nothing she types is lost (review round 1, S1).
  const second = addMapItem(data, "behaviors", "groups", { behaviorIds: ["beh-1"], nature: "Spitting alone", function: "escape", measure: null, reason: "" }, 1, T2);
  let groups = mapPartView(second.data, "behaviors").groups;
  assert.deepEqual(groups.map((g) => [g.id, g.behaviorIds]), [["grp-1", ["beh-2"]], ["grp-2", ["beh-1"]]]);
  assert.equal(groups[0].editedAt, T2, "the group it left is marked changed by her");
  // Typing in the second group, ticking a behavior of the first: it moves too, and the reason she typed is saved.
  const typed = saveMapItem(second.data, "behaviors", "groups", "grp-2", { behaviorIds: ["beh-1", "beh-2"], nature: "Spitting alone", function: "escape", measure: null, reason: "Both escape." }, 1, T3);
  assert.ok(typed && typed !== "item-not-found");
  groups = mapPartView(typed.data, "behaviors").groups;
  assert.deepEqual(groups.map((g) => [g.id, g.behaviorIds]), [["grp-1", []], ["grp-2", ["beh-1", "beh-2"]]]);
  assert.equal(groups[1].reason, "Both escape.");
  // A behavior the version does not have, or one named twice, is dropped rather than refused.
  const ghost = addMapItem(data, "behaviors", "groups", { behaviorIds: ["beh-9", "beh-2", "beh-2"], nature: "Ghost", function: null, measure: null, reason: "" }, 1, T1);
  assert.deepEqual(mapPartView(ghost.data, "behaviors").groups.map((g) => g.behaviorIds), [["beh-1"], ["beh-2"]]);
  assert.throws(() => addMapItem(data, "caregivers", "groups", {}, null, T1), /only the behaviors part/);
  const removed = removeMapItem(data, "behaviors", "items", "beh-2", 1, T2);
  assert.ok(removed !== "item-not-found");
  assert.deepEqual(mapPartView(removed.data, "behaviors").groups[0].behaviorIds, ["beh-1"]);
});

test("case map: an edit of an item the version shown does not hold brings it back with the edit, never lost (review round 1, minor 2)", () => {
  let data = blank();
  data = addMapItem(data, "caregivers", "items", { role: claim("Mother") }, null, T1).data;
  data = approveMapPart(data, "caregivers", 1, T1)!;
  data = addMapItem(data, "caregivers", "items", { role: claim("Grandmother") }, 1, T2).data; // version 2 has cg-2
  data = setMapPartVersion(data, "caregivers", 1)!; // version 1 does not
  const kept = saveMapItem(data, "caregivers", "items", "cg-2", { availability: claim("Tuesdays") }, 2, T3);
  assert.ok(kept && kept !== "item-not-found");
  assert.equal(kept.version, 3, "a new version, based on the one shown");
  const items = mapPartView(kept.data, "caregivers").items as Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any -- reading the view in a test
  assert.deepEqual(items.map((item) => item.id), ["cg-1", "cg-2"]);
  assert.equal(items[1].role.value, "Grandmother");
  assert.equal(items[1].availability.value, "Tuesdays");
  // An id no version ever had is still not found.
  assert.equal(saveMapItem(data, "caregivers", "items", "cg-9", {}, null, T3), "item-not-found");
});

test("case map: an empty line is not stored, and a changed claim keeps every earlier ref after hers (review round 1, minor 4 and 5)", () => {
  const merged = mergeInput([claim("kept"), claim(""), claim("  "), claim("", "a check on an empty line")], []) as Array<{ value: string }>;
  assert.deepEqual(
    merged.map((line) => line.value),
    ["kept", ""],
    "an empty line with a [CHECK] is kept",
  );
  const ten = Array.from({ length: 10 }, (_, index) => ({ kind: "source", sourceId: "11111111-2222-4333-8444-555555555555", quote: `quote ${index}` }));
  const changed = mergeInput(claim("changed"), { value: "before", refs: ten, origin: "extracted", check: null }) as { refs: unknown[] };
  assert.equal(changed.refs.length, 11, "her ref and all ten sources");
  const data = withAiBehaviors();
  (data.caseMap!.parts.behaviors.versions[0].content.items[0] as Record<string, unknown>).name = { value: "Spitting", refs: ten, origin: "extracted", check: null };
  const saved = saveMapItem(data, "behaviors", "items", "beh-1", { name: claim("Spitting at people") }, null, T1);
  assert.ok(saved && saved !== "item-not-found");
  assert.ok(readableCaseFileText(saved.data), "eleven refs read back whole");
});

test("case map: the limits hold on what she sends (D6)", () => {
  // Strict input: only the part's fields, only values and [CHECK]s.
  assert.throws(() => parseItemInput("caregivers", "items", { role: { value: "Mother", check: null, origin: "extracted" } }), /Refused/);
  assert.throws(() => parseItemInput("caregivers", "items", { secret: claim("x") }), /Refused/);
  assert.throws(() => parseItemInput("behaviors", "items", { name: claim("x".repeat(121)) }), /Refused/);
  assert.throws(() => parseItemInput("behaviors", "items", { definition: claim("x".repeat(3001)) }), /Refused/);
  assert.doesNotThrow(() => parseItemInput("behaviors", "items", { definition: claim("x".repeat(3000)) }));
  assert.throws(() => parseItemInput("behaviors", "items", { examples: Array.from({ length: 31 }, () => claim("e")) }), /Refused/);
  assert.throws(() => parseItemInput("report", "items", { text: "rewritten" }), /Refused/, "the report is the AI's; she only marks it");
  // A part's item limit.
  let data = blank();
  let editing: number | null = null;
  for (let index = 0; index < MAP_PART_LIMITS.caregivers; index++) {
    const added: { data: CaseData; version: number; itemId: string } = addMapItem(data, "caregivers", "items", {}, editing, T1);
    data = added.data;
    editing = added.version;
  }
  assert.throws(() => addMapItem(data, "caregivers", "items", {}, editing, T1), /full/);
  // The client part holds one item, "client".
  const client = addMapItem(blank(), "client", "items", { diagnosis: claim("Autism spectrum disorder") }, null, T1);
  assert.equal(client.itemId, "client");
  assert.throws(() => addMapItem(client.data, "client", "items", {}, 1, T1), /one item/);
  // What is saved reads back whole.
  assert.ok(readableCaseFileText(data));
  assert.ok(readableCaseFileText(client.data));
});

test("case map: the section 8 baseline mean is the app's, from the three counts, or none (D20)", () => {
  const obs = (value: string | null) => ({ value: value === null ? null : { value, refs: [], origin: "her", check: null } });
  assert.equal(baselineMean([obs("3"), obs("1"), obs("3")]), 2.33);
  assert.equal(baselineMean([obs("4"), obs("5")]), 4.5);
  assert.equal(baselineMean([obs("3"), obs(null)]), null, "a missing count: no mean");
  assert.equal(baselineMean([obs("about 3")]), null, "never guessed");
  assert.equal(baselineMean([]), null);
});

/* The service, on a real case in a temporary folder: every change through the case's save queue, and a change she typed kept when the disk refuses it. */

const folders: string[] = [];
after(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

async function serviceSetup(options: { failWrites?: () => boolean } = {}) {
  const folder = mkdtempSync(path.join(tmpdir(), "aba-case-map-test-"));
  folders.push(folder);
  let ids = 0;
  const cases = new CaseLibrary({
    location: async () => ({ folder, isDefault: false }),
    newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
    log: () => undefined,
    ...(options.failWrites
      ? {
          writeFile: async (file: string, text: string) => {
            if (options.failWrites!()) throw new Error("EACCES: the disk refused (test)");
            await writeFileDurably(file, text);
          },
        }
      : {}),
  });
  const created = await cases.create({ label: "Invented map case" });
  assert.ok(created.outcome === "created");
  const service = new CaseMapService({ cases });
  const failedSaves = new FailedSaves({ run: runSaves(cases, () => ({}) as never, () => service), labelOf: () => "Invented map case" });
  return { cases, service, failedSaves, caseId: created.case.id, caseFile: path.join(folder, "Invented map case", CASE_FILE_NAME) };
}

const json = (value: unknown) => JSON.stringify(value);

test("case map service: add, type, approve, go back and remove, each saved in the case's data file", async () => {
  const { cases, service, caseId, caseFile } = await serviceSetup();
  const empty = await service.get(caseId);
  assert.ok(empty.outcome === "read");
  assert.equal(empty.map.parts.behaviors.status, "empty");
  assert.equal("caseMap" in JSON.parse(readFileSync(caseFile, "utf8")), false, "reading writes no map");

  const added = await service.addItem(caseId, "behaviors", "items", json({ name: claim("Spitting") }), null);
  assert.ok(added.outcome === "saved");
  assert.equal(added.itemId, "beh-1");
  assert.equal(added.version, 1);
  assert.deepEqual(added.summary, { approved: 0, withContent: 1 });

  const typed = await service.saveItem(caseId, "behaviors", "items", "beh-1", json({ definition: claim("Any instance in which the child spits toward a person.") }), added.version);
  assert.ok(typed.outcome === "saved");
  assert.equal(typed.version, 1, "the same editing pass");
  const unchanged = await service.saveItem(caseId, "behaviors", "items", "beh-1", json({ definition: claim("Any instance in which the child spits toward a person.") }), 1);
  assert.ok(unchanged.outcome === "saved");
  assert.equal(unchanged.version, null, "nothing changed, nothing written");

  const approved = await service.approve(caseId, "behaviors", 1);
  assert.ok(approved.outcome === "saved");
  assert.equal(approved.map.parts.behaviors.status, "approved");
  assert.deepEqual(approved.summary, { approved: 1, withContent: 1 });
  const stored = JSON.parse(readFileSync(caseFile, "utf8"));
  assert.equal(stored.schemaVersion, CASE_SCHEMA_VERSION);
  assert.equal(stored.caseMap.parts.behaviors.approvedVersion, 1);
  assert.equal(stored.caseMap.parts.behaviors.versions[0].content.items[0].name.origin, "her");

  const removed = await service.removeItem(caseId, "behaviors", "items", "beh-1", 1);
  assert.ok(removed.outcome === "saved");
  assert.equal(removed.version, 2, "approved content never changes: a new version");
  assert.equal(removed.map.parts.behaviors.items.length, 0);
  const back = await service.setCurrent(caseId, "behaviors", 1);
  assert.ok(back.outcome === "saved");
  assert.equal(back.map.parts.behaviors.items.length, 1, "going back brings it back");
  assert.deepEqual(await service.setCurrent(caseId, "behaviors", 7), { outcome: "version-not-found" });
  assert.deepEqual(await service.saveItem(caseId, "behaviors", "items", "beh-9", json({}), null), { outcome: "item-not-found" });

  // Opening the case gives the sidebar its count.
  const opened = await cases.open(caseId);
  assert.ok(opened.outcome === "opened");
  assert.deepEqual(opened.case.caseMap, { approved: 0, withContent: 1 });
});

test("case map service: hostile or malformed input is refused before anything is read or written", async () => {
  const { service, caseId, caseFile } = await serviceSetup();
  const before = readFileSync(caseFile, "utf8");
  await assert.rejects(service.addItem(caseId, "plan", "items", json({}), null), /Refused: not a part/);
  await assert.rejects(service.addItem(caseId, "behaviors", "rows", json({}), null), /Refused/);
  await assert.rejects(service.addItem(caseId, "behaviors", "items", "{not json", null), /Refused: the item is not readable/);
  await assert.rejects(service.addItem(caseId, "behaviors", "items", "[1]", null), /Refused/);
  await assert.rejects(service.addItem(caseId, "behaviors", "items", json({ name: { value: "x", check: null, refs: [{ kind: "source" }] } }), null), /Refused/);
  await assert.rejects(service.saveItem(caseId, "behaviors", "items", "../x", json({}), null), /Refused: not an item/);
  await assert.rejects(service.saveItem(caseId, "behaviors", "items", "beh-1", json({}), 0), /Refused: not a version/);
  await assert.rejects(service.approve(caseId, "behaviors", "1"), /Refused/);
  await assert.rejects(service.addItem(caseId, "behaviors", "items", "x".repeat(400_001), null), /Refused/);
  assert.equal(readFileSync(caseFile, "utf8"), before);
});

test("case map service: a case from a newer app is never written to, through any map call (review round 1, minor 9)", async () => {
  const { service, caseId, caseFile } = await serviceSetup();
  writeFileSync(caseFile, JSON.stringify({ ...JSON.parse(readFileSync(caseFile, "utf8")), schemaVersion: CASE_SCHEMA_VERSION + 1 }, null, 2));
  const before = readFileSync(caseFile, "utf8");
  assert.deepEqual(await service.get(caseId), { outcome: "case-unavailable" });
  for (const call of [
    () => service.addItem(caseId, "behaviors", "items", json({}), null),
    () => service.saveItem(caseId, "behaviors", "items", "beh-1", json({}), null),
    () => service.removeItem(caseId, "behaviors", "items", "beh-1", null),
    () => service.setCurrent(caseId, "behaviors", 1),
    () => service.approve(caseId, "behaviors", 1),
  ]) {
    assert.deepEqual(await call(), { outcome: "case-unavailable" });
  }
  assert.equal(readFileSync(caseFile, "utf8"), before);
});

test("case map service: what she typed is kept when the disk refuses it, and Try again saves it", async () => {
  let refuse = false;
  const { service, failedSaves, caseId, caseFile } = await serviceSetup({ failWrites: () => refuse });
  const added = await service.addItem(caseId, "caregivers", "items", json({ role: claim("Grandmother") }), null);
  assert.ok(added.outcome === "saved");
  refuse = true;
  const op = { kind: "map-item" as const, part: "caregivers", collection: "items", itemId: "cg-1", text: json({ availability: claim("Tuesdays and Thursdays") }), editing: 1 };
  const failed = await failedSaves.save(caseId, op);
  assert.equal(failed.outcome, "not-saved");
  const kept = failedSaves.list();
  assert.equal(kept.length, 1);
  assert.equal(kept[0].about, "map");
  assert.equal(kept[0].mapItem, "caregivers/items/cg-1");
  assert.equal(kept[0].editing, 1);
  assert.equal(kept[0].text, op.text, "the fields she typed, for the item's form after a reload");
  refuse = false;
  const retried = await failedSaves.retry(kept[0].id);
  assert.equal(retried.outcome, "saved");
  assert.equal(failedSaves.size, 0);
  const stored = JSON.parse(readFileSync(caseFile, "utf8"));
  assert.equal(stored.caseMap.parts.caregivers.versions.at(-1).content.items[0].availability.value, "Tuesdays and Thursdays");
});
