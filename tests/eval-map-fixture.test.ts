import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { checkMapAnswer, parseMapAnswer } from "../src/lib/case-map-extraction.ts";

/* pnpm eval --map: the approved map fixture of invented case B (eval/map-fixture.ts). */

const DIR = path.join("fixtures", "cases", "case-b-sofia");

test("case B's approved map fixture passes the app's own checks, every quote found in the case's sources, and names only sources the case has", () => {
  const fixture = JSON.parse(readFileSync(path.join(DIR, "approved-map.json"), "utf8"));
  const caseJson = JSON.parse(readFileSync(path.join(DIR, "case.json"), "utf8")) as { sources: Array<{ id: string; title: string; file: string }> };
  const key = JSON.parse(readFileSync(path.join(DIR, "key.json"), "utf8")) as { extraSources: Array<{ id: string; title: string; file: string }>; inputs: { notes?: string }; behaviors: Array<{ name: string }> };
  const all = [...caseJson.sources, ...key.extraSources];
  const sources = all.map((source) => ({ id: source.id, title: source.title, text: source.file.endsWith(".pdf") ? null : readFileSync(path.join(DIR, source.file), "utf8") }));
  const facts = parseMapAnswer("map-facts", JSON.stringify(fixture.answers["map-facts"]));
  assert.ok(facts.ok);
  assert.deepEqual(checkMapAnswer("map-facts", facts.answer, { sources, sections: [], notes: key.inputs.notes ?? "", settingIds: new Set() }).problems, []);
  const settings = fixture.answers["map-facts"].settings.length;
  const behaviors = parseMapAnswer("map-behaviors", JSON.stringify(fixture.answers["map-behaviors"]));
  assert.ok(behaviors.ok);
  const settingIds = new Set(Array.from({ length: settings }, (_, index) => `set-${index + 1}`));
  assert.deepEqual(checkMapAnswer("map-behaviors", behaviors.answer, { sources, sections: [], notes: key.inputs.notes ?? "", settingIds, instructions: "" }).problems, []);
  // Her target behavior list, as the key has it: the map she approved names the same behaviors.
  const names = (fixture.answers["map-behaviors"].behaviors as Array<{ name: { value: string } }>).map((behavior) => behavior.name.value.toLowerCase());
  assert.deepEqual(names, key.behaviors.map((behavior) => behavior.name.toLowerCase()));
});
